/**
 * The assistant's edit engine: element-level operations on an RBLang document
 * (insert / replace / delete an element, set an attribute, replace exact text)
 * resolved through selectors that survive line drift, applied atomically, and
 * described back to the model with the diagnostics delta, the model-level diff
 * and the changed region. Also the snippet linter and the minimal-edit
 * computation the editor glue uses. Pure: no vscode import.
 */
import { buildIndex, MapIndex, TagOccurrence, attrValueRange, attrFullRange } from "./mapIndex";
import { topLevelElements, TopLevelElement, insertPoint, detectIndent, SKELETON, hasRoot, lineStartOf, escapeAttr, ElementKind, KIND_ORDER } from "./authoringModel";
import { SCHEMA } from "./schema";
import { collectIssues, LintIssue } from "./lint";
import { buildModel, diffReportDetailed } from "./semanticModel";
import { lineAt, numberLines, countLines, summariseIssues } from "./mapOverview";

export type SelectorKind = ElementKind | "relinst" | "any";

export interface Selector {
  kind?: SelectorKind;
  name?: string;
  rel?: string;
  subject?: string;
  object?: string;
  type?: string;
  /** 1-based line of the opening tag; selects any tag on that line, including nested ones. */
  line?: number;
}

export type Operation =
  | { op: "insert_element"; kind: ElementKind; xml: string; after?: Selector }
  | { op: "replace_element"; selector: Selector; xml: string }
  | { op: "delete_element"; selector: Selector }
  | { op: "set_attribute"; selector: Selector; attr: string; value: string | null }
  | { op: "replace_text"; old_text: string; new_text: string };

export class EditError extends Error {}

/** A resolved target: the tag plus the extent of the whole element. */
export interface Resolved {
  tag: TagOccurrence;
  start: number;
  end: number;
  /** Nesting depth: 1 for children of the root. */
  depth: number;
  kind: ElementKind | "other";
  topLevel: boolean;
}

// ---------------------------------------------------------------------------
// Describing elements

export function describeTag(text: string, index: MapIndex, tag: TagOccurrence, kind: ElementKind | "other", end?: number): string {
  const a = tag.attrs;
  const line = `L${lineAt(text, tag.start)}`;
  switch (kind) {
    case "concept":
      return `concept "${a.name ?? "?"}" (${line})`;
    case "rel":
      return `rel "${a.name ?? "?"}" ${a.subject ?? "?"} → ${a.object ?? "?"} (${line})`;
    case "concinst":
      return `instance "${a.name ?? "?"}" of ${a.type ?? "?"} (${line})`;
    case "fact":
      return `fact ${a.subject ?? "?"} ${a.type ?? "?"} ${a.object ?? "?"} (${line})`;
    case "rule": {
      const range = end !== undefined ? `L${lineAt(text, tag.start)}–${lineAt(text, end)}` : line;
      return `rule ${a.name ? `"${a.name}"` : "(unnamed)"} ${a.type ?? "?"}${a.object ? ` → ${a.object}` : ""} (${range})`;
    }
    default:
      return `<${tag.name}>${a.name ? ` "${a.name}"` : a.rel ? ` rel="${a.rel}"` : a.expression ? ` expression="${a.expression.slice(0, 30)}"` : ""} (${line})`;
  }
}

function describeSelector(sel: Selector): string {
  const parts = Object.entries(sel)
    .filter(([, v]) => v !== undefined && v !== null && v !== "")
    .map(([k, v]) => `${k}=${JSON.stringify(v)}`);
  return parts.length ? `{${parts.join(", ")}}` : "{}";
}

const kindNoun: Record<string, string> = { concept: "concept", rel: "relationship", concinst: "instance", fact: "fact", rule: "rule", relinst: "fact or rule", any: "element" };

// ---------------------------------------------------------------------------
// Resolution

/** Extent and depth of every non-closing tag, by index into `index.tags`. */
function elementExtents(index: MapIndex): Map<TagOccurrence, { end: number; depth: number }> {
  const out = new Map<TagOccurrence, { end: number; depth: number }>();
  const stack: TagOccurrence[] = [];
  for (const tag of index.tags) {
    if (tag.closing) {
      let at = stack.length - 1;
      while (at >= 0 && stack[at].name !== tag.name) at--;
      if (at < 0) continue;
      for (let i = stack.length - 1; i > at; i--) out.set(stack[i], { end: stack[i].end, depth: i }); // unclosed inner tags: extent is the tag itself
      out.set(stack[at], { end: tag.end, depth: at });
      stack.length = at;
      continue;
    }
    if (tag.selfClosing) {
      out.set(tag, { end: tag.end, depth: stack.length });
      continue;
    }
    stack.push(tag);
  }
  for (let i = 0; i < stack.length; i++) out.set(stack[i], { end: stack[i].end, depth: i });
  return out;
}

function kindOfTag(index: MapIndex, tag: TagOccurrence, end: number): ElementKind | "other" {
  if (tag.name === "concept" || tag.name === "rel" || tag.name === "concinst") return tag.name;
  if (tag.name !== "relinst") return "other";
  return index.tags.some((t) => t.name === "condition" && !t.closing && t.start > tag.start && t.end <= end) ? "rule" : "fact";
}

function kindMatches(sel: SelectorKind | undefined, kind: ElementKind | "other"): boolean {
  if (!sel || sel === "any") return true;
  if (sel === "relinst") return kind === "fact" || kind === "rule";
  return sel === kind;
}

function attrMatches(sel: Selector, tag: TagOccurrence, kind: ElementKind | "other", fold: (s: string) => string): boolean {
  const a = tag.attrs;
  const eq = (x: string | undefined, y: string | undefined) => x !== undefined && y !== undefined && fold(x) === fold(y);
  if (sel.name !== undefined && !eq(a.name, sel.name)) return false;
  if (sel.rel !== undefined) {
    const relOf = tag.name === "rel" ? a.name : tag.name === "relinst" ? a.type : tag.name === "condition" ? a.rel : undefined;
    if (!eq(relOf, sel.rel)) return false;
  }
  if (sel.subject !== undefined && !eq(a.subject, sel.subject)) return false;
  if (sel.object !== undefined && !eq(a.object, sel.object)) return false;
  if (sel.type !== undefined && !eq(a.type, sel.type)) return false;
  void kind;
  return true;
}

/** Everything the selector could mean, for error messages: names of that kind with lines. */
function candidatesHint(text: string, index: MapIndex, sel: Selector): string {
  const els = topLevelElements(index);
  const wanted = els.filter((e) => kindMatches(sel.kind, e.kind) && e.kind !== "other");
  if (!wanted.length) return sel.kind && sel.kind !== "any" ? `The map has no ${kindNoun[sel.kind]}s.` : "The map has no elements.";
  const shown = wanted.slice(0, 12).map((e) => describeTag(text, index, e.tag, e.kind, e.end));
  return `Available: ${shown.join("; ")}${wanted.length > 12 ? `; … ${wanted.length - 12} more (use get_map_overview)` : ""}.`;
}

/** Resolve a selector to exactly one element, or throw an EditError that tells the model how to disambiguate. */
export function resolveSelector(text: string, index: MapIndex, sel: Selector): Resolved {
  const extents = elementExtents(index);
  let pool: Resolved[];
  if (sel.line !== undefined) {
    pool = index.tags
      .filter((t) => !t.closing && lineAt(text, t.start) === sel.line)
      .map((t) => {
        const ext = extents.get(t) ?? { end: t.end, depth: 1 };
        return { tag: t, start: t.start, end: ext.end, depth: ext.depth, kind: kindOfTag(index, t, ext.end), topLevel: ext.depth === 1 };
      });
    if (!pool.length) throw new EditError(`Nothing starts on line ${sel.line} (the file has ${countLines(text)} lines). Use read_map to find the right line, or select by name.`);
  } else {
    pool = topLevelElements(index).map((e) => ({ tag: e.tag, start: e.start, end: e.end, depth: 1, kind: e.kind, topLevel: true }));
  }
  const filtered = pool.filter((r) => kindMatches(sel.kind, r.kind));
  const exact = filtered.filter((r) => attrMatches(sel, r.tag, r.kind, (s) => s));
  let matches = exact;
  if (!matches.length) matches = filtered.filter((r) => attrMatches(sel, r.tag, r.kind, (s) => s.toLowerCase().trim()));
  if (matches.length === 1) return matches[0];
  if (!matches.length) {
    const noun = sel.kind && sel.kind !== "any" ? kindNoun[sel.kind] : "element";
    throw new EditError(`No ${noun} matches ${describeSelector(sel)}. ${candidatesHint(text, index, sel)}`);
  }
  const listed = matches.slice(0, 10).map((r) => describeTag(text, index, r.tag, r.kind, r.end)).join("; ");
  throw new EditError(`${matches.length} elements match ${describeSelector(sel)}: ${listed}${matches.length > 10 ? "; …" : ""}. Add name, subject, object or line to select exactly one.`);
}

// ---------------------------------------------------------------------------
// Fragments

interface Fragment {
  /** Re-indented text, first line without leading indent. */
  text: string;
  kinds: (ElementKind | "other")[];
  names: string[];
}

/** Column width of leading whitespace (a tab counts as 4 columns). */
function indentWidth(ws: string): number {
  let w = 0;
  for (const ch of ws) w += ch === "\t" ? 4 : 1;
  return w;
}

/** Normalise a fragment's indentation to the file's unit at `depth`, preserving relative nesting whatever unit the fragment used. */
export function reindentFragment(xml: string, indentUnit: string, depth = 1): string {
  const lines = xml.replace(/\r\n/g, "\n").split("\n");
  while (lines.length && !lines[0].trim()) lines.shift();
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  const widths = lines.filter((l) => l.trim()).map((l) => indentWidth(/^[ \t]*/.exec(l)![0]));
  const base = widths.length ? Math.min(...widths) : 0;
  const steps = widths.map((w) => w - base).filter((d) => d > 0);
  const unit = steps.length ? Math.min(...steps) : 2;
  return lines
    .map((l, i) => {
      if (!l.trim()) return "";
      const rel = Math.max(0, Math.round((indentWidth(/^[ \t]*/.exec(l)![0]) - base) / unit));
      const prefix = i === 0 ? "" : indentUnit.repeat(depth + rel);
      return prefix + l.trimStart();
    })
    .join("\n");
}

/** Parse a fragment of one or more elements, checking it is well-formed. */
function parseFragment(xml: string, indentUnit: string, depth: number): Fragment {
  if (!xml.trim()) throw new EditError("xml is empty.");
  const wrapped = `<rbl:kb>${xml}</rbl:kb>`;
  const index = buildIndex(wrapped);
  if (index.problems.length) throw new EditError(`The xml is malformed: ${index.problems.map((p) => p.message).join("; ")}`);
  const els = topLevelElements(index);
  if (!els.length) throw new EditError(xml.includes("<") ? "The xml could not be parsed — check for unbalanced quotes or a missing \">\"." : "The xml contains no element. Provide complete elements such as <concept …/> or <relinst …>…</relinst>.");
  const unclosed = index.tags.filter((t) => !t.closing && !t.selfClosing && !els.some((e) => e.tag === t) && !index.tags.some((c) => c.closing && c.name === t.name && c.start > t.start));
  if (unclosed.length) throw new EditError(`Unclosed <${unclosed[0].name}> in the xml.`);
  // Stray text outside elements (other than whitespace/comments) would be silently dropped by Studio; refuse it.
  const masked = wrapped.replace(/<!--[\s\S]*?-->/g, " ").replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, " ");
  const outside = masked.replace(/<[^>]*>/g, "").replace(/\s+/g, "");
  // Text content inside text-bearing elements (firstForm, meta, datasource body) is legitimate; only reject when no such element exists.
  const textBearing = index.tags.some((t) => !t.closing && SCHEMA[t.name]?.text);
  if (outside && !textBearing) throw new EditError("The xml has text outside any element. Attribute values must be quoted and text belongs only inside question-form, meta or datasource elements.");
  return {
    text: reindentFragment(xml, indentUnit, depth),
    kinds: els.map((e) => e.kind),
    names: els.map((e) => e.tag.attrs.name ?? e.tag.attrs.type ?? e.tag.name),
  };
}

function checkKinds(fragment: Fragment, kind: ElementKind): void {
  for (const k of fragment.kinds) {
    if (k === kind) continue;
    if (k === "other") throw new EditError(`The xml contains an element that is not a ${kindNoun[kind]}. insert_element takes concept, rel, concinst, fact (relinst without conditions) or rule (relinst with conditions) elements only; for <import> use replace_text.`);
    throw new EditError(`kind is "${kind}" but the xml contains a ${kindNoun[k]}. Set kind to "${k}" or fix the xml.`);
  }
}

// ---------------------------------------------------------------------------
// Operations

interface Step {
  text: string;
  summary: string;
  /** Offsets in the new text of the region this step touched. */
  start: number;
  end: number;
}

function splice(text: string, start: number, end: number, replacement: string): string {
  return text.slice(0, start) + replacement + text.slice(end);
}

function applyOne(text: string, op: Operation): Step {
  const index = buildIndex(text);
  const indentUnit = detectIndent(text);

  switch (op.op) {
    case "insert_element": {
      if (!KIND_ORDER.includes(op.kind)) throw new EditError(`kind must be one of ${KIND_ORDER.join(", ")}.`);
      let working = text;
      let idx = index;
      if (!hasRoot(idx)) {
        if (working.trim()) throw new EditError("The document has no <rbl:kb> root element. Fix the structure first (get_diagnostics), or use replace_text.");
        working = SKELETON.replace("\n\n</rbl:kb>", "\n</rbl:kb>");
        idx = buildIndex(working);
      }
      const fragment = parseFragment(op.xml, indentUnit, 1);
      checkKinds(fragment, op.kind);
      let offset: number;
      let before: string;
      let after: string;
      if (op.after) {
        const anchor = resolveSelector(working, idx, op.after);
        if (!anchor.topLevel) throw new EditError(`"after" must select a top-level element; ${describeTag(working, idx, anchor.tag, anchor.kind, anchor.end)} is nested.`);
        offset = anchor.end;
        before = "\n";
        after = "";
      } else {
        const prefer =
          op.kind === "fact" || op.kind === "rule"
            ? (e: TopLevelElement) => fragment.names.includes(e.tag.attrs.type ?? "")
            : op.kind === "concinst"
              ? (e: TopLevelElement) => (buildIndex(op.xml).instanceDecls[0]?.type ?? "") === (e.tag.attrs.type ?? "")
              : undefined;
        const point = insertPoint(working, idx, op.kind, prefer);
        if (!point) throw new EditError("Could not find where to insert: the document has no <rbl:kb> root element.");
        offset = point.offset;
        before = point.before.replace(/[ \t]+$/, "");
        after = point.after;
      }
      const insertion = `${before}${indentUnit}${fragment.text}${after}`;
      const start = offset + before.length;
      return {
        text: splice(working, offset, offset, insertion),
        summary: `insert_element ${op.kind}: ${fragment.names.map((n) => `"${n}"`).join(", ")}`,
        start,
        end: start + indentUnit.length + fragment.text.length,
      };
    }
    case "replace_element": {
      const target = resolveSelector(text, index, op.selector);
      const fragment = parseFragment(op.xml, indentUnit, target.depth);
      const was = describeTag(text, index, target.tag, target.kind, target.end);
      return {
        text: splice(text, target.start, target.end, fragment.text),
        summary: `replace_element ${was} → ${fragment.names.map((n) => `"${n}"`).join(", ")}`,
        start: target.start,
        end: target.start + fragment.text.length,
      };
    }
    case "delete_element": {
      const target = resolveSelector(text, index, op.selector);
      const was = describeTag(text, index, target.tag, target.kind, target.end);
      let start = target.start;
      let end = target.end;
      const lineStart = lineStartOf(text, start);
      const lineEnd = text.indexOf("\n", end);
      const restOfLine = text.slice(end, lineEnd === -1 ? text.length : lineEnd);
      if (!text.slice(lineStart, start).trim() && !restOfLine.trim()) {
        start = lineStart;
        end = lineEnd === -1 ? text.length : lineEnd + 1;
        // Collapse a blank line left between two blank lines.
        const prevBlank = start >= 1 && text[start - 1] === "\n" && (start < 2 || text[start - 2] === "\n");
        const nextBlank = text[end] === "\n";
        if (prevBlank && nextBlank) end++;
      }
      return { text: splice(text, start, end, ""), summary: `delete_element ${was}`, start, end: start };
    }
    case "set_attribute": {
      const target = resolveSelector(text, index, op.selector);
      const tag = target.tag;
      const spec = SCHEMA[tag.name];
      if (spec && !spec.required.includes(op.attr) && !spec.optional.includes(op.attr)) {
        throw new EditError(`<${tag.name}> has no attribute "${op.attr}". Allowed: ${[...spec.required, ...spec.optional].join(", ")}.`);
      }
      const where = describeTag(text, index, tag, target.kind, target.end);
      const current = tag.attrs[op.attr];
      if (op.value === null) {
        if (spec?.required.includes(op.attr)) throw new EditError(`"${op.attr}" is required on <${tag.name}> and cannot be removed.`);
        const range = attrFullRange(tag, op.attr);
        if (!range) throw new EditError(`${where} has no "${op.attr}" attribute to remove.`);
        return { text: splice(text, range.start, range.end, ""), summary: `set_attribute ${op.attr} removed from ${where} (was "${current}")`, start: range.start, end: range.start };
      }
      const allowed = spec?.enums?.[op.attr];
      if (allowed && !allowed.includes(op.value)) throw new EditError(`${op.attr}="${op.value}" is not valid on <${tag.name}>; expected one of ${allowed.join(", ")}.`);
      const escaped = escapeAttr(op.value);
      const valueRange = attrValueRange(tag, op.attr);
      if (valueRange) {
        return {
          text: splice(text, valueRange.start, valueRange.end, escaped),
          summary: `set_attribute ${op.attr} on ${where}: "${current}" → "${op.value}"`,
          start: valueRange.start,
          end: valueRange.start + escaped.length,
        };
      }
      let at = tag.end - (tag.selfClosing ? 2 : 1);
      while (at > tag.start && /\s/.test(text[at - 1])) at--;
      const insertion = ` ${op.attr}="${escaped}"`;
      return { text: splice(text, at, at, insertion), summary: `set_attribute ${op.attr}="${op.value}" added to ${where}`, start: at, end: at + insertion.length };
    }
    case "replace_text": {
      if (!op.old_text) throw new EditError("old_text is empty.");
      const first = text.indexOf(op.old_text);
      if (first === -1) throw new EditError("old_text was not found. Copy the exact current text from read_map (whitespace and quotes included).");
      if (text.indexOf(op.old_text, first + 1) !== -1) {
        const n = text.split(op.old_text).length - 1;
        throw new EditError(`old_text matches ${n} times; include more surrounding text so it matches exactly once.`);
      }
      const line = lineAt(text, first);
      return { text: splice(text, first, first + op.old_text.length, op.new_text), summary: `replace_text at L${line}`, start: first, end: first + op.new_text.length };
    }
    default:
      throw new EditError(`Unknown op "${(op as { op: string }).op}".`);
  }
}

export interface EditOutcome {
  text: string;
  summaries: string[];
}

/** Apply operations in order, each against the result of the previous. Throws EditError (naming the operation) and leaves nothing applied. */
export function applyOperations(text: string, ops: Operation[]): EditOutcome {
  if (!ops.length) throw new EditError("operations is empty.");
  let working = text;
  const summaries: string[] = [];
  ops.forEach((op, i) => {
    try {
      const step = applyOne(working, op);
      working = step.text;
      summaries.push(`${i + 1}. ${step.summary} → L${lineAt(working, step.start)}${step.end > step.start && lineAt(working, step.end) !== lineAt(working, step.start) ? `–${lineAt(working, step.end)}` : ""}`);
    } catch (error) {
      if (error instanceof EditError) throw new EditError(`Operation ${i + 1} (${op.op}) failed: ${error.message} Nothing was applied.`);
      throw error;
    }
  });
  return { text: working, summaries };
}

// ---------------------------------------------------------------------------
// Describing what changed

/** Issues present after but not before (introduced) and before but not after (fixed), matched by severity + message so line shifts do not count. */
export function diagnosticsDelta(before: LintIssue[], after: LintIssue[]): { introduced: LintIssue[]; fixed: LintIssue[] } {
  const key = (i: LintIssue) => `${i.severity}|${i.message}`;
  const count = (list: LintIssue[]) => {
    const m = new Map<string, number>();
    for (const i of list) m.set(key(i), (m.get(key(i)) ?? 0) + 1);
    return m;
  };
  const b = count(before);
  const a = count(after);
  const introduced: LintIssue[] = [];
  const fixed: LintIssue[] = [];
  const seenA = new Map<string, number>();
  for (const i of after) {
    const k = key(i);
    const n = (seenA.get(k) ?? 0) + 1;
    seenA.set(k, n);
    if (n > (b.get(k) ?? 0)) introduced.push(i);
  }
  const seenB = new Map<string, number>();
  for (const i of before) {
    const k = key(i);
    const n = (seenB.get(k) ?? 0) + 1;
    seenB.set(k, n);
    if (n > (a.get(k) ?? 0)) fixed.push(i);
  }
  return { introduced, fixed };
}

/** The single range that differs between two texts (common prefix/suffix stripped). */
export function computeMinimalEdit(before: string, after: string): { start: number; end: number; newText: string } {
  let prefix = 0;
  const max = Math.min(before.length, after.length);
  while (prefix < max && before[prefix] === after[prefix]) prefix++;
  let suffix = 0;
  while (suffix < max - prefix && before[before.length - 1 - suffix] === after[after.length - 1 - suffix]) suffix++;
  return { start: prefix, end: before.length - suffix, newText: after.slice(prefix, after.length - suffix) };
}

/** Condensed model-level diff for the tool result. */
export function modelChanges(before: string, after: string): string[] {
  const report = diffReportDetailed(buildModel(before), buildModel(after), "before", "after");
  return report.markdown
    .split("\n")
    .filter((l) => /^- /.test(l))
    .map((l) => l.replace(/\*\*/g, "").replace(/^- /, ""));
}

/** Full tool result text for a successful edit_map call. */
export function describeEdit(fileName: string, before: string, outcome: EditOutcome, beforeIssues: LintIssue[], afterIssues: LintIssue[]): string {
  const after = outcome.text;
  const lines: string[] = [`Applied ${outcome.summaries.length} operation${outcome.summaries.length === 1 ? "" : "s"} to ${fileName} (now ${countLines(after)} lines).`];
  lines.push(...outcome.summaries.map((s) => `  ${s}`));

  const delta = diagnosticsDelta(beforeIssues, afterIssues);
  lines.push("", `Diagnostics: ${summariseIssues(afterIssues)} (was ${summariseIssues(beforeIssues)}).`);
  if (delta.introduced.length) lines.push(`  New: ${delta.introduced.map((i) => `L${i.line + 1} ${i.severity}: ${i.message}`).join("; ")}`);
  if (delta.fixed.length) lines.push(`  Fixed: ${delta.fixed.map((i) => `${i.severity}: ${i.message}`).join("; ")}`);
  if (!delta.introduced.length && !delta.fixed.length) lines.push("  No new or fixed findings.");

  const changes = modelChanges(before, after);
  lines.push("", changes.length ? `Model changes:\n${changes.map((c) => `  ${c}`).join("\n")}` : "Model changes: none at the concept/relationship/fact/rule level (text or attribute-only edit).");

  const edit = computeMinimalEdit(before, after);
  const all = after.split("\n");
  const from = Math.max(1, lineAt(after, edit.start) - 1);
  const to = Math.min(all.length, lineAt(after, Math.max(edit.start, edit.start + edit.newText.length - 1)) + 1);
  const capped = Math.min(to, from + 79);
  lines.push("", `Changed region (L${from}–${capped}${capped < to ? `, truncated; ${to - capped} more lines` : ""}):`);
  lines.push(numberLines(all.slice(from - 1, capped), from));
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Snippet linting

/**
 * Lint a fragment in the context of a host document (or the empty skeleton):
 * the fragment is placed before the root's closing tag and only findings
 * inside it are returned, with fragment-relative 0-based lines.
 */
export function lintSnippet(snippet: string, hostText?: string): LintIssue[] {
  const host = hostText && hasRoot(buildIndex(hostText)) ? hostText : SKELETON;
  const index = buildIndex(host);
  const close = index.tags.find((t) => t.closing && t.name === "rbl:kb")!;
  const at = lineStartOf(host, close.start);
  const body = snippet.replace(/\s+$/, "") + "\n";
  const combined = host.slice(0, at) + body + host.slice(at);
  const firstLine = countLines(host.slice(0, at)) ;
  return collectIssues(combined)
    .filter((i) => i.start >= at && i.start < at + body.length)
    .map((i) => ({ ...i, line: i.line - firstLine, start: i.start - at, end: i.end - at }));
}
