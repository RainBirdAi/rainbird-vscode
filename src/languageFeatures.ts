/**
 * Symbol-level language features for RBLang: go-to-definition, find-references
 * and rename for concepts / relationships / instances (single-file scope in
 * the prototype), plus a CodeLens on every relationship: run it as a query,
 * see its rule/fact counts. Names may contain spaces ("lives in"), so
 * resolution is attribute-value based, not word based.
 *
 * References live in two places: tag attributes (rel="lives in") and *inside*
 * attribute strings — quoted names in list functions
 * (countRelationshipInstances(%S, 'lives in', *)), dot traversals in evidence
 * text ({{%COUNTRY.national language}}) and datasource action maps
 * (map="lives in=/path"). Studio has propagated renames into expressions since
 * 4.88; a rename that missed them would silently break the map.
 */
import * as vscode from "vscode";
import { buildIndex, MapIndex, TagOccurrence, relinstCounts } from "./mapIndex";

type SymbolKind = "concept" | "rel" | "instance";

interface ValueSpan {
  attr: string;
  value: string;
  /** Document offset of the value's first character */
  start: number;
  end: number;
}

/** A reference to (or declaration of) a symbol, at exact document offsets. */
interface RefSpan {
  kind: SymbolKind;
  name: string;
  start: number;
  end: number;
}

/** Exact document offsets of every attribute value in a tag. */
function attrSpans(tag: TagOccurrence): ValueSpan[] {
  const base = tag.start + 1 + tag.name.length;
  const spans: ValueSpan[] = [];
  const re = /([a-zA-Z_][\w:.-]*)\s*=\s*"([^"]*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(tag.attrSource)) !== null) {
    const start = base + m.index + m[0].indexOf('"') + 1;
    spans.push({ attr: m[1], value: m[2], start, end: start + m[2].length });
  }
  return spans;
}

/** Which symbol kind a whole attribute value refers to, per element. */
function kindOf(tagName: string, attr: string): SymbolKind | undefined {
  if (tagName === "concept" && attr === "name") return "concept";
  if (tagName === "rel" && attr === "name") return "rel";
  if (tagName === "concinst" && attr === "name") return "instance";
  if (tagName === "rel" && (attr === "subject" || attr === "object")) return "concept";
  if (tagName === "concinst" && attr === "type") return "concept";
  if (tagName === "relinst" && attr === "type") return "rel";
  if ((tagName === "condition" || tagName === "input") && attr === "rel") return "rel";
  if ((tagName === "relinst" || tagName === "condition" || tagName === "input") && (attr === "subject" || attr === "object")) {
    return "instance";
  }
  return undefined;
}

/** Every symbol reference in a tag: whole attribute values plus names embedded in strings. */
function refsIn(tag: TagOccurrence, index: MapIndex): RefSpan[] {
  const refs: RefSpan[] = [];
  for (const span of attrSpans(tag)) {
    const kind = kindOf(tag.name, span.attr);
    if (kind && !span.value.startsWith("%")) {
      // Condition subjects/objects can also be plain literals — only count declared instances.
      if (kind !== "instance" || index.instances.has(span.value)) {
        refs.push({ kind, name: span.value, start: span.start, end: span.end });
      }
    }

    // Quoted names inside expressions: list functions name relationships, comparisons may name instances.
    if ((tag.name === "condition" || tag.name === "input") && (span.attr === "expression" || span.attr === "value")) {
      for (const m of span.value.matchAll(/'([^']*)'/g)) {
        const name = m[1];
        const at = span.start + (m.index ?? 0) + 1;
        if (index.relationships.has(name)) refs.push({ kind: "rel", name, start: at, end: at + name.length });
        else if (index.instances.has(name)) refs.push({ kind: "instance", name, start: at, end: at + name.length });
      }
    }

    // Evidence text traversals: {{%VAR.relationship name}}
    if ((tag.name === "relinst" || tag.name === "condition") && span.attr === "alt") {
      for (const m of span.value.matchAll(/\{\{\s*%[A-Za-z0-9_]+\.([^}]+?)\s*\}\}/g)) {
        const name = m[1].trim();
        if (!index.relationships.has(name)) continue;
        const at = span.start + (m.index ?? 0) + m[0].indexOf(name);
        refs.push({ kind: "rel", name, start: at, end: at + name.length });
      }
    }

    // Datasource output mapping: map="relationship name=/Response/Path"
    if (tag.name === "action" && span.attr === "map") {
      const eq = span.value.indexOf("=");
      if (eq > 0) {
        const name = span.value.slice(0, eq).trim();
        if (index.relationships.has(name)) {
          const at = span.start + span.value.indexOf(name);
          refs.push({ kind: "rel", name, start: at, end: at + name.length });
        }
      }
    }
  }
  return refs;
}

interface Resolved {
  kind: SymbolKind;
  name: string;
  span: { start: number; end: number };
}

function resolveAt(doc: vscode.TextDocument, position: vscode.Position): { index: MapIndex; hit?: Resolved } {
  const text = doc.getText();
  const index = buildIndex(text);
  const offset = doc.offsetAt(position);
  for (const tag of index.tags) {
    if (tag.closing || offset < tag.start || offset >= tag.end) continue;
    // Prefer the tightest span (an embedded name inside a longer attribute value).
    const candidates = refsIn(tag, index)
      .filter((ref) => offset >= ref.start && offset <= ref.end)
      .sort((a, b) => a.end - a.start - (b.end - b.start));
    const ref = candidates[0];
    if (!ref) return { index };
    return { index, hit: { kind: ref.kind, name: ref.name, span: { start: ref.start, end: ref.end } } };
  }
  return { index };
}

/** Every span in the document that refers to (or declares) the symbol. */
function allSpans(index: MapIndex, kind: SymbolKind, name: string): { start: number; end: number }[] {
  const spans: { start: number; end: number }[] = [];
  for (const tag of index.tags) {
    if (tag.closing) continue;
    for (const ref of refsIn(tag, index)) {
      if (ref.kind === kind && ref.name === name) spans.push({ start: ref.start, end: ref.end });
    }
  }
  return spans;
}

function toRange(doc: vscode.TextDocument, span: { start: number; end: number }): vscode.Range {
  return new vscode.Range(doc.positionAt(span.start), doc.positionAt(span.end));
}

export function registerLanguageFeatures(context: vscode.ExtensionContext): void {
  const selector: vscode.DocumentSelector = { language: "rblang" };

  context.subscriptions.push(
    vscode.languages.registerDefinitionProvider(selector, {
      provideDefinition(doc, position) {
        const { index, hit } = resolveAt(doc, position);
        if (!hit) return undefined;
        const decl =
          hit.kind === "concept"
            ? index.concepts.get(hit.name)
            : hit.kind === "rel"
              ? index.relationships.get(hit.name)
              : index.instances.get(hit.name);
        if (!decl) return undefined;
        return new vscode.Location(doc.uri, doc.positionAt(decl.offset));
      },
    }),

    vscode.languages.registerReferenceProvider(selector, {
      provideReferences(doc, position) {
        const { index, hit } = resolveAt(doc, position);
        if (!hit) return undefined;
        return allSpans(index, hit.kind, hit.name).map((span) => new vscode.Location(doc.uri, toRange(doc, span)));
      },
    }),

    vscode.languages.registerRenameProvider(selector, {
      prepareRename(doc, position) {
        const { hit } = resolveAt(doc, position);
        if (!hit) throw new Error("You can rename concepts, relationships and instances (place the cursor on the name).");
        return toRange(doc, hit.span);
      },
      provideRenameEdits(doc, position, newName) {
        const { index, hit } = resolveAt(doc, position);
        if (!hit) return undefined;
        if (/["'\\<>]/.test(newName)) throw new Error(`Names cannot contain " ' \\ < > characters`);
        const edit = new vscode.WorkspaceEdit();
        for (const span of allSpans(index, hit.kind, hit.name)) {
          edit.replace(doc.uri, toRange(doc, span), newName);
        }
        return edit;
      },
    }),

    vscode.languages.registerCodeLensProvider(selector, new RelCodeLensProvider(context))
  );
}

class RelCodeLensProvider implements vscode.CodeLensProvider {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this.emitter.event;
  private debounce?: NodeJS.Timeout;

  constructor(context: vscode.ExtensionContext) {
    context.subscriptions.push(
      vscode.workspace.onDidChangeTextDocument((e) => {
        if (e.document.languageId !== "rblang") return;
        clearTimeout(this.debounce);
        this.debounce = setTimeout(() => this.emitter.fire(), 500);
      })
    );
  }

  provideCodeLenses(doc: vscode.TextDocument): vscode.CodeLens[] {
    const index = buildIndex(doc.getText());
    const counts = relinstCounts(index);
    const lenses: vscode.CodeLens[] = [];
    for (const [name, rel] of index.relationships) {
      const range = new vscode.Range(doc.positionAt(rel.offset), doc.positionAt(rel.offset));
      lenses.push(
        new vscode.CodeLens(range, {
          title: "$(play) Run query",
          command: "rainbird.openQueryPanelWithGoal",
          arguments: [name],
        })
      );
      const count = counts.get(name);
      if (count && (count.rules || count.facts)) {
        const parts = [];
        if (count.rules) parts.push(`${count.rules} rule${count.rules > 1 ? "s" : ""}`);
        if (count.facts) parts.push(`${count.facts} fact${count.facts > 1 ? "s" : ""}`);
        lenses.push(
          new vscode.CodeLens(range, {
            title: parts.join(" · "),
            command: "rainbird.openGraphView",
          })
        );
      }
    }
    return lenses;
  }
}
