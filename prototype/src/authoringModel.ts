/**
 * Pure helpers behind the guided authoring flows (authoring.ts): where a new
 * element belongs in the document, how the file is indented, which variables a
 * rule already binds, and the RBLang text for each element kind. No vscode
 * dependency, so it can be exercised in plain node.
 */
import { MapIndex, TagOccurrence } from "./mapIndex";

export type ElementKind = "concept" | "rel" | "concinst" | "fact" | "rule";

/** The docs' recommended order: concepts → relationships → instances → facts → rules. */
export const KIND_ORDER: ElementKind[] = ["concept", "rel", "concinst", "fact", "rule"];

export const SKELETON = `<?xml version="1.0" encoding="utf-8"?>\n<rbl:kb xmlns:rbl="http://rbl.io/schema/RBLang">\n\n</rbl:kb>\n`;

export interface TopLevelElement {
  kind: ElementKind | "other";
  tag: TagOccurrence;
  /** Offset of the "<" of the opening tag. */
  start: number;
  /** Offset just past the ">" that ends the element (closing tag or self-closing tag). */
  end: number;
  /** Offset of the "<" of the closing tag, when the element is not self-closing. */
  closeStart?: number;
}

/** The direct children of the root element, in document order, with their extent. */
export function topLevelElements(index: MapIndex): TopLevelElement[] {
  const out: TopLevelElement[] = [];
  const stack: { tag: TagOccurrence; at: number; topLevel: boolean }[] = [];
  const tags = index.tags;
  for (let i = 0; i < tags.length; i++) {
    const tag = tags[i];
    if (tag.closing) {
      let at = stack.length - 1;
      while (at >= 0 && stack[at].tag.name !== tag.name) at--;
      if (at < 0) continue;
      const open = stack[at];
      stack.length = at; // also drops anything left unclosed inside
      if (open.topLevel) out.push({ kind: kindOf(tags, open.at, i), tag: open.tag, start: open.tag.start, end: tag.end, closeStart: tag.start });
      continue;
    }
    if (tag.selfClosing) {
      if (stack.length === 1) out.push({ kind: kindOf(tags, i, i), tag, start: tag.start, end: tag.end });
      continue;
    }
    stack.push({ tag, at: i, topLevel: stack.length === 1 });
  }
  return out.sort((a, b) => a.start - b.start);
}

function kindOf(tags: TagOccurrence[], openAt: number, closeAt: number): ElementKind | "other" {
  const name = tags[openAt].name;
  if (name === "concept" || name === "rel" || name === "concinst") return name;
  if (name !== "relinst") return "other";
  for (let j = openAt + 1; j < closeAt; j++) {
    if (tags[j].name === "condition" && !tags[j].closing) return "rule";
  }
  return "fact";
}

export const hasRoot = (index: MapIndex): boolean => index.tags.some((t) => t.name === "rbl:kb" && !t.closing);

/** The indentation unit the file uses for top-level elements (tab by default). */
export function detectIndent(text: string): string {
  return /^([ \t]+)<(?:concept|rel|concinst|relinst|import)\b/m.exec(text)?.[1] ?? "\t";
}

export interface InsertPoint {
  offset: number;
  /** Text to put before the element (newlines and indentation). */
  before: string;
  /** Text to put after the element. */
  after: string;
}

export const lineStartOf = (text: string, offset: number): number => text.lastIndexOf("\n", offset - 1) + 1;

/**
 * Where a new element of `kind` belongs: after the last element of the same kind
 * (or of the last one matching `prefer`, e.g. instances of the same concept),
 * else after the last element of an earlier kind, else before the first element
 * of a later kind, else just before the root's closing tag. Undefined when the
 * document has no root element.
 */
export function insertPoint(
  text: string,
  index: MapIndex,
  kind: ElementKind,
  prefer?: (el: TopLevelElement) => boolean
): InsertPoint | undefined {
  const indent = detectIndent(text);
  const els = topLevelElements(index);
  const same = els.filter((e) => e.kind === kind);
  if (same.length) {
    const preferred = prefer ? same.filter(prefer) : [];
    const anchor = (preferred.length ? preferred : same).at(-1)!;
    return { offset: anchor.end, before: `\n${indent}`, after: "" };
  }
  const rank = KIND_ORDER.indexOf(kind);
  for (let r = rank - 1; r >= 0; r--) {
    const previous = els.filter((e) => e.kind === KIND_ORDER[r]);
    if (previous.length) return { offset: previous.at(-1)!.end, before: `\n\n${indent}`, after: "" };
  }
  for (let r = rank + 1; r < KIND_ORDER.length; r++) {
    const next = els.find((e) => e.kind === KIND_ORDER[r]);
    if (next) return { offset: lineStartOf(text, next.start), before: indent, after: "\n\n" };
  }
  const close = index.tags.find((t) => t.closing && t.name === "rbl:kb");
  if (close) return { offset: lineStartOf(text, close.start), before: indent, after: "\n" };
  return undefined;
}

/** The rule (relinst with conditions) whose extent contains `offset`. */
export function ruleAt(index: MapIndex, offset: number): TopLevelElement | undefined {
  return topLevelElements(index).find((e) => e.kind === "rule" && e.start <= offset && offset <= e.end);
}

const VAR_RE = /%[A-Za-z][A-Za-z0-9_]*/g;

/** Distinct %VARIABLES mentioned in a piece of RBLang, in order of first appearance. */
export function variablesIn(text: string): string[] {
  return [...new Set(text.match(VAR_RE) ?? [])];
}

/** "date of birth" → "%DATE_OF_BIRTH". Empty when nothing usable remains. */
export function toVariable(raw: string): string {
  const cleaned = raw
    .trim()
    .replace(/^%/, "")
    .toUpperCase()
    .replace(/[^A-Z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (!cleaned) return "";
  return "%" + (/^[A-Z]/.test(cleaned) ? cleaned : `V_${cleaned}`);
}

/** Snippet fragments: literal text, or a placeholder the user tabs through. */
export type Part = string | { placeholder: string };

export const escapeAttr = (v: string): string => v.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
const attr = (name: string, value: string | undefined): string => (value === undefined ? "" : ` ${name}="${escapeAttr(value)}"`);

export function conceptXml(name: string, type: string, mutuallyExclusive: boolean): string {
  return `<concept${attr("name", name)}${attr("type", type)}${mutuallyExclusive ? attr("behaviour", "mutually-exclusive") : ""}/>`;
}

export function instanceXml(name: string, concept: string): string {
  return `<concinst${attr("name", name)}${attr("type", concept)}/>`;
}

export function factXml(rel: string, subject: string, object: string, cf: string): string {
  return `<relinst${attr("type", rel)}${attr("subject", subject)}${attr("object", object)}${attr("cf", cf)}/>`;
}

export type Askable = "all" | "none" | "secondFormObject" | "secondFormSubject";

export interface RelSpec {
  name: string;
  subject: string;
  object: string;
  plural: boolean;
  askable: Askable;
}

/** Default question wording, offered as placeholders so the author rewrites it in their own words. */
export function questionTemplates(rel: RelSpec): { element: string; text: string }[] {
  const forms = [
    { element: "firstForm", text: `Does %S ${rel.name} %O?`, when: rel.askable === "all" },
    { element: "secondFormObject", text: `Which ${rel.object} does %S ${rel.name}?`, when: rel.askable === "all" || rel.askable === "secondFormObject" },
    { element: "secondFormSubject", text: `Which ${rel.subject} ${rel.name} %O?`, when: rel.askable === "all" || rel.askable === "secondFormSubject" },
  ];
  return forms.filter((f) => f.when).map(({ element, text }) => ({ element, text }));
}

export function relXml(rel: RelSpec, indent: string): Part[] {
  const open = `<rel${attr("name", rel.name)}${attr("subject", rel.subject)}${attr("object", rel.object)}${rel.plural ? attr("plural", "true") : ""}${attr("askable", rel.askable)}`;
  const questions = questionTemplates(rel);
  if (!questions.length) return [`${open}/>`];
  const parts: Part[] = [`${open}>`];
  for (const q of questions) parts.push(`\n${indent}${indent}<${q.element}>`, { placeholder: q.text }, `</${q.element}>`);
  parts.push(`\n${indent}</rel>`);
  return parts;
}

export type ConditionSpec =
  | { kind: "rel"; rel: string; subject: string; object: string; weight: string; optional: boolean }
  | { kind: "expression"; expression: string; value?: string; weight: string; optional: boolean };

export function conditionXml(c: ConditionSpec): string {
  const tail = `${attr("weight", c.weight)}${c.optional ? attr("behaviour", "optional") : ""}/>`;
  if (c.kind === "rel") return `<condition${attr("rel", c.rel)}${attr("subject", c.subject)}${attr("object", c.object)}${tail}`;
  return `<condition${attr("expression", c.expression)}${attr("value", c.value)}${tail}`;
}

/** Plain-English reading of a condition, for the rule builder's running summary. */
export function conditionEnglish(c: ConditionSpec): string {
  const base = c.kind === "rel" ? `${c.subject} ${c.rel} ${c.object}` : c.value ? `${c.value} = ${c.expression}` : c.expression;
  return c.optional ? `${base} (optional)` : base;
}

export interface RuleSpec {
  rel: string;
  name?: string;
  cf: string;
  /** A fixed object instance the rule concludes, instead of inferring %O. */
  object?: string;
  conditions: ConditionSpec[];
}

export function ruleXml(rule: RuleSpec, indent: string): Part[] {
  const inner = `\n${indent}${indent}`;
  const parts: Part[] = [`<relinst${attr("type", rule.rel)}${attr("object", rule.object)}${attr("cf", rule.cf)}${attr("name", rule.name || undefined)}>`];
  if (rule.conditions.length) {
    for (const c of rule.conditions) parts.push(inner + conditionXml(c));
  } else {
    parts.push(`${inner}<condition rel="`, { placeholder: "relationship" }, `" subject="%S" object="`, { placeholder: "%O" }, `" weight="100"/>`);
  }
  parts.push(`\n${indent}</relinst>`);
  return parts;
}
