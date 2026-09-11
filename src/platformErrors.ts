/**
 * Locate the platform's validation messages in the RBLang they reject.
 *
 * A rejected POST /maps answers {"err": ["Relationship was born on expects a
 * date as its object", …]}: plain sentences with no positions. This module
 * maps each sentence back onto the element it is most likely about, so the
 * messages can be shown in the Problems panel at the offending line rather
 * than in a truncated notification. Heuristic by design — the platform's
 * message catalogue is not documented — and honest about it: anything it
 * cannot place lands on the root element with the full text.
 *
 * Pure TypeScript (no vscode import) so it is unit-testable.
 */
import { buildIndex, MapIndex, TagOccurrence } from "./mapIndex";
import { literalMatchesType } from "./lint";

export interface LocatedError {
  message: string;
  start: number;
  end: number;
  /** 0-based line of `start` */
  line: number;
}

/** Flatten whatever the platform put in `err` into readable sentences. */
export function normaliseErrMessages(err: unknown): string[] {
  if (err === undefined || err === null) return [];
  const list = Array.isArray(err) ? err : [err];
  return list
    .map((item) => {
      if (typeof item === "string") return item;
      if (item && typeof item === "object") {
        const o = item as Record<string, unknown>;
        const text = [o.message, o.msg, o.error, o.err, o.text].find((v) => typeof v === "string" && v.trim());
        return typeof text === "string" ? text : JSON.stringify(item);
      }
      return String(item);
    })
    .map((s) => s.trim())
    .filter(Boolean);
}

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Does `name` occur in `message` as a whole word/phrase? */
function mentions(message: string, name: string, caseInsensitive = false): boolean {
  if (!name) return false;
  return new RegExp(`(^|[^\\w])${escapeRegExp(name)}([^\\w]|$)`, caseInsensitive ? "i" : "").test(message);
}

/** The longest declared name the message mentions (exact case first, then case-insensitive). */
function mentionedName(message: string, names: Iterable<string>): string | undefined {
  const all = [...names].sort((a, b) => b.length - a.length);
  return all.find((n) => mentions(message, n)) ?? all.find((n) => mentions(message, n, true));
}

const lineRange = (text: string, line: number): { start: number; end: number } => {
  const lines = text.split("\n");
  const clamped = Math.max(0, Math.min(line, lines.length - 1));
  let start = 0;
  for (let i = 0; i < clamped; i++) start += lines[i].length + 1;
  const raw = lines[clamped];
  const lead = raw.length - raw.trimStart().length;
  return { start: start + lead, end: start + raw.trimEnd().length };
};

export function locatePlatformErrors(text: string, messages: string[]): LocatedError[] {
  const index = buildIndex(text);
  const lineStarts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === "\n") lineStarts.push(i + 1);
  const lineOf = (offset: number): number => {
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lineStarts[mid] <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  };
  const at = (message: string, range: { start: number; end: number }): LocatedError => ({ message, ...range, line: lineOf(range.start) });
  const tagRange = (tag: TagOccurrence) => ({ start: tag.start, end: tag.end });
  const root = index.tags.find((t) => !t.closing && t.name === "rbl:kb");
  const fallback = root ? tagRange(root) : { start: 0, end: 0 };

  const located: LocatedError[] = [];
  for (const raw of messages) {
    // "Line: 35 - Datasource hostname must …" (the platform's upload validation): the position is the line, the text is the rest.
    const prefixed = /^\s*line[:\s]+(\d+)\s*[-–:]\s*(.+)$/i.exec(raw);
    if (prefixed) {
      located.push(at(prefixed[2].trim(), lineRange(text, Number(prefixed[1]) - 1)));
      continue;
    }
    const places = locateOne(raw, text, index, tagRange);
    for (const range of places.length ? places : [fallback]) located.push(at(raw, range));
  }
  return located;
}

function locateOne(
  message: string,
  text: string,
  index: MapIndex,
  tagRange: (t: TagOccurrence) => { start: number; end: number }
): { start: number; end: number }[] {
  // 1. An explicit position (XML parser style: "Line: 12 Column: 5").
  const lineMatch = /\bline[:\s]+(\d+)/i.exec(message);
  if (lineMatch) return [lineRange(text, Number(lineMatch[1]) - 1)];

  const open = (name: string) => index.tags.filter((t) => !t.closing && t.name === name);

  // 2. A relationship: point at the facts/conditions whose literal the platform would reject, else its declaration.
  const relName = mentionedName(message, index.relationships.keys());
  if (relName) {
    const rel = index.relationships.get(relName)!;
    const side: "subject" | "object" | undefined = /\bobject\b/i.test(message) ? "object" : /\bsubject\b/i.test(message) ? "subject" : undefined;
    if (side) {
      const conceptType = index.concepts.get(rel[side])?.type;
      const uses = [
        ...open("relinst").filter((t) => t.attrs.type === relName),
        ...open("condition").filter((t) => t.attrs.rel === relName),
      ];
      const literal = (t: TagOccurrence) => {
        const v = t.attrs[side];
        return v && !v.startsWith("%") ? v : undefined;
      };
      if (conceptType && conceptType !== "string") {
        const failing = uses.filter((t) => literal(t) !== undefined && !literalMatchesType(literal(t)!, conceptType));
        if (failing.length) return failing.map(tagRange);
      }
      const instance = mentionedName(message, index.instanceDecls.map((d) => d.name));
      if (instance) {
        const hits = uses.filter((t) => literal(t) === instance);
        if (hits.length) return hits.map(tagRange);
      }
    }
    const decl = open("rel").find((t) => t.attrs.name === relName);
    if (decl) return [tagRange(decl)];
  }

  // 3. A concept, then (only when the message talks about instances) an instance.
  const conceptName = mentionedName(message, index.concepts.keys());
  if (conceptName) {
    if (/\binstance\b/i.test(message)) {
      const instName = mentionedName(message, index.instanceDecls.filter((d) => d.type === conceptName).map((d) => d.name));
      const inst = instName && open("concinst").find((t) => t.attrs.name === instName && t.attrs.type === conceptName);
      if (inst) return [tagRange(inst)];
    }
    const decl = open("concept").find((t) => t.attrs.name === conceptName);
    if (decl) return [tagRange(decl)];
  }
  if (/\binstance\b/i.test(message)) {
    const instName = mentionedName(message, index.instanceDecls.map((d) => d.name));
    const inst = instName && open("concinst").find((t) => t.attrs.name === instName);
    if (inst) return [tagRange(inst)];
  }
  return [];
}
