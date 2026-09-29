/**
 * Editor-agnostic symbol resolution for RBLang: where a concept, relationship
 * or instance is declared and every place it is referred to. Drives
 * go-to-definition, find-references, F2 rename and live linked editing in
 * languageFeatures.ts, and the symbol hover in completions.ts. Kept free of
 * the vscode module so `npm test` can exercise it under plain node.
 *
 * Names may contain spaces ("lives in"), so resolution is attribute-value
 * based, not word based. References live in two places: tag attributes
 * (rel="lives in") and *inside* attribute strings — quoted names in list
 * functions (countRelationshipInstances(%S, 'lives in', *)), dot traversals
 * in evidence text ({{%COUNTRY.national language}}) and datasource action
 * maps (map="lives in=/path"). Studio has propagated renames into expressions
 * since 4.88; a rename that missed them would silently break the map.
 *
 * Instances are identified by name AND concept ("France" the Country is not
 * "France" the Team). A subject/object reference is scoped by the concept the
 * relationship expects there, so renaming one France leaves the other alone.
 * Quoted instance names inside expressions carry no such context and match by
 * name.
 */
import { buildIndex, MapIndex, TagOccurrence } from "./mapIndex";

export type SymbolKind = "concept" | "rel" | "instance";

export interface Span {
  start: number;
  end: number;
}

interface ValueSpan extends Span {
  attr: string;
  value: string;
}

/** A reference to (or declaration of) a symbol, at exact document offsets. */
export interface RefSpan extends Span {
  kind: SymbolKind;
  name: string;
  /** True for the `name` attribute of <concept>, <rel> and <concinst>. */
  declaration: boolean;
  /**
   * Instances only: the concept this mention belongs to — the declared type
   * on a <concinst>, the concept the relationship expects on a subject/object.
   * Undefined when unknown (unknown relationship, quoted name in an expression).
   */
  concept?: string;
}

export interface SymbolHit {
  kind: SymbolKind;
  name: string;
  span: Span;
  declaration: boolean;
  /** Instances only: the concept this mention is scoped to, when known. */
  concept?: string;
}

/** Characters a name may not contain (the platform rejects them). */
export const NAME_FORBIDDEN = /["\\<>]/;

/**
 * Text a linked-editing range may hold while linking stays active. Wider than
 * the language's word pattern, which stops at the first space and would break
 * the link halfway through "lives in".
 */
export const LINKED_NAME_PATTERN = /[^"\\<>]*/;

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

/** The concept a relationship expects as the subject/object of this tag, when the relationship is known. */
function expectedConcept(tag: TagOccurrence, attr: string, index: MapIndex): string | undefined {
  const relName = tag.name === "relinst" ? tag.attrs.type : tag.attrs.rel;
  const rel = relName ? index.relationships.get(relName) : undefined;
  if (!rel) return undefined;
  return attr === "subject" ? rel.subject : rel.object;
}

/** Every symbol reference in a tag: whole attribute values plus names embedded in strings. */
export function refsIn(tag: TagOccurrence, index: MapIndex): RefSpan[] {
  const refs: RefSpan[] = [];
  for (const span of attrSpans(tag)) {
    const kind = kindOf(tag.name, span.attr);
    if (kind && !span.value.startsWith("%")) {
      // Condition subjects/objects can also be plain literals — only count declared instances.
      if (kind !== "instance" || index.instances.has(span.value)) {
        const declaration = span.attr === "name";
        const ref: RefSpan = { kind, name: span.value, start: span.start, end: span.end, declaration };
        if (kind === "instance") {
          ref.concept = declaration ? tag.attrs.type || undefined : expectedConcept(tag, span.attr, index);
        }
        refs.push(ref);
      }
    }

    // Quoted names inside expressions: list functions name relationships, comparisons may name instances.
    if ((tag.name === "condition" || tag.name === "input") && (span.attr === "expression" || span.attr === "value")) {
      for (const m of span.value.matchAll(/'((?:[^'\\]|\\.)*)'/g)) {
        const name = m[1].replace(/\\'/g, "'");
        const at = span.start + (m.index ?? 0) + 1;
        const end = at + m[1].length;
        if (index.relationships.has(name)) refs.push({ kind: "rel", name, start: at, end, declaration: false });
        else if (index.instances.has(name)) refs.push({ kind: "instance", name, start: at, end, declaration: false });
      }
    }

    // Evidence text traversals: {{%VAR.relationship name}}
    if ((tag.name === "relinst" || tag.name === "condition") && span.attr === "alt") {
      for (const m of span.value.matchAll(/\{\{\s*%[A-Za-z0-9_]+\.([^}]+?)\s*\}\}/g)) {
        const name = m[1].trim();
        if (!index.relationships.has(name)) continue;
        const at = span.start + (m.index ?? 0) + m[0].indexOf(name);
        refs.push({ kind: "rel", name, start: at, end: at + name.length, declaration: false });
      }
    }

    // Datasource output mapping: map="relationship name=/Response/Path"
    if (tag.name === "action" && span.attr === "map") {
      const eq = span.value.indexOf("=");
      if (eq > 0) {
        const name = span.value.slice(0, eq).trim();
        if (index.relationships.has(name)) {
          const at = span.start + span.value.indexOf(name);
          refs.push({ kind: "rel", name, start: at, end: at + name.length, declaration: false });
        }
      }
    }
  }
  return refs;
}

/** The symbol mention under `offset`, if any. Prefers the tightest span (a name embedded in a longer value). */
export function symbolAt(text: string, offset: number, index: MapIndex = buildIndex(text)): { index: MapIndex; hit?: SymbolHit } {
  for (const tag of index.tags) {
    if (tag.closing || offset < tag.start || offset >= tag.end) continue;
    const candidates = refsIn(tag, index)
      .filter((ref) => offset >= ref.start && offset <= ref.end)
      .sort((a, b) => a.end - a.start - (b.end - b.start));
    const ref = candidates[0];
    if (!ref) return { index };
    return {
      index,
      hit: { kind: ref.kind, name: ref.name, span: { start: ref.start, end: ref.end }, declaration: ref.declaration, concept: ref.concept },
    };
  }
  return { index };
}

/**
 * Every span in the document that refers to (or declares) the symbol. For
 * instances, `concept` narrows the result to mentions scoped to that concept;
 * mentions whose concept is unknown are kept.
 */
export function allSpans(index: MapIndex, kind: SymbolKind, name: string, concept?: string): Span[] {
  const spans: Span[] = [];
  for (const tag of index.tags) {
    if (tag.closing) continue;
    for (const ref of refsIn(tag, index)) {
      if (ref.kind !== kind || ref.name !== name) continue;
      if (kind === "instance" && concept && ref.concept && ref.concept !== concept) continue;
      spans.push({ start: ref.start, end: ref.end });
    }
  }
  return spans;
}

/** Spans of every mention of the symbol under `offset`, with the resolved symbol. */
export function spansAt(text: string, offset: number): { hit: SymbolHit; index: MapIndex; spans: Span[] } | undefined {
  const { index, hit } = symbolAt(text, offset);
  if (!hit) return undefined;
  return { hit, index, spans: allSpans(index, hit.kind, hit.name, hit.concept) };
}

/** Document offset of the symbol's declaration, if it is declared in this document. */
export function declarationOf(index: MapIndex, hit: SymbolHit): number | undefined {
  if (hit.kind === "concept") return index.concepts.get(hit.name)?.offset;
  if (hit.kind === "rel") return index.relationships.get(hit.name)?.offset;
  const decls = index.instanceDecls.filter((d) => d.name === hit.name);
  return (decls.find((d) => d.type === hit.concept) ?? decls[decls.length - 1])?.offset;
}

/**
 * Ranges to edit in lockstep while the user types in a declaration's name.
 * Only offered from the declaration: editing a reference is usually meant to
 * point it at a different symbol, not to rename this one. Spans whose text is
 * not the name verbatim (an escaped quote inside an expression string) cannot
 * follow keystrokes and are left out.
 */
export function linkedSpans(text: string, offset: number): { name: string; spans: Span[] } | undefined {
  const found = spansAt(text, offset);
  if (!found || !found.hit.declaration) return undefined;
  const name = found.hit.name;
  const spans = found.spans.filter((s) => text.slice(s.start, s.end) === name);
  if (!spans.some((s) => s.start === found.hit.span.start)) return undefined;
  return { name, spans };
}

export interface TextEdit extends Span {
  newText: string;
}

/**
 * The edits an F2 rename of the symbol under `offset` needs. Throws when the
 * new name is invalid so the editor can show the reason.
 */
export function renameEdits(text: string, offset: number, newName: string): TextEdit[] | undefined {
  const found = spansAt(text, offset);
  if (!found) return undefined;
  if (!newName.trim()) throw new Error("Names cannot be empty");
  if (NAME_FORBIDDEN.test(newName)) throw new Error(`Names cannot contain " \\ < > characters`);
  return found.spans.map((s) => ({ ...s, newText: newName }));
}

/** Apply offset edits to `text` — highest offset first so earlier offsets stay valid. */
export function applyEdits(text: string, edits: TextEdit[]): string {
  let out = text;
  for (const e of [...edits].sort((a, b) => b.start - a.start)) out = out.slice(0, e.start) + e.newText + out.slice(e.end);
  return out;
}
