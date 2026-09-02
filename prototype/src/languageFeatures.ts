/**
 * Symbol-level language features for RBLang: go-to-definition, find-references
 * and rename for concepts / relationships / instances (single-file scope in
 * the prototype), plus a CodeLens on every relationship: run it as a query,
 * see its rule/fact counts. Names may contain spaces ("lives in"), so
 * resolution is attribute-value based, not word based.
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

/** Which symbol kind an attribute value refers to, per element. */
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

interface Resolved {
  kind: SymbolKind;
  name: string;
  span: ValueSpan;
}

function resolveAt(doc: vscode.TextDocument, position: vscode.Position): { index: MapIndex; hit?: Resolved } {
  const text = doc.getText();
  const index = buildIndex(text);
  const offset = doc.offsetAt(position);
  for (const tag of index.tags) {
    if (tag.closing || offset < tag.start || offset >= tag.end) continue;
    for (const span of attrSpans(tag)) {
      if (offset < span.start || offset > span.end) continue;
      const kind = kindOf(tag.name, span.attr);
      if (!kind || span.value.startsWith("%")) return { index };
      // "instance" positions only resolve when the instance is declared —
      // condition subjects/objects can also be literals.
      if (kind === "instance" && !index.instances.has(span.value)) return { index };
      return { index, hit: { kind, name: span.value, span } };
    }
  }
  return { index };
}

/** Every value span in the document that refers to (or declares) the symbol. */
function allSpans(index: MapIndex, kind: SymbolKind, name: string): ValueSpan[] {
  const spans: ValueSpan[] = [];
  for (const tag of index.tags) {
    if (tag.closing) continue;
    for (const span of attrSpans(tag)) {
      if (span.value === name && kindOf(tag.name, span.attr) === kind) spans.push(span);
    }
  }
  return spans;
}

function toRange(doc: vscode.TextDocument, span: ValueSpan): vscode.Range {
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
