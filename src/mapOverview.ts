/**
 * Read-side tool bodies: a structured, token-cheap overview of an RBLang map
 * (what the assistant asks for before answering or editing) and numbered line
 * ranges. Pure functions over the document text; the vscode glue only supplies
 * file name and platform state.
 */
import { buildIndex, MapIndex, TagOccurrence, instancesOf, relinstCounts } from "./mapIndex";
import { topLevelElements, TopLevelElement } from "./authoringModel";
import { collectIssues, LintIssue } from "./lint";

export interface OverviewExtra {
  fileName: string;
  kmId?: string;
  /** Where the kmID came from, e.g. "workspace setting" or "last push". */
  kmIdSource?: string;
  /** API base URL when connected. */
  apiUrl?: string;
  /** Pre-computed diagnostics (defaults to linting `text`). */
  issues?: LintIssue[];
}

/** 1-based line of a document offset. */
export function lineAt(text: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < text.length; i++) if (text.charCodeAt(i) === 10) line++;
  return line;
}

export function countLines(text: string): number {
  if (!text) return 0;
  let n = 1;
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) n++;
  return text.endsWith("\n") ? n - 1 : n;
}

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? "" : "s"}`;

export function summariseIssues(issues: LintIssue[]): string {
  const count = (s: LintIssue["severity"]) => issues.filter((i) => i.severity === s).length;
  return `${plural(count("error"), "error")}, ${plural(count("warning"), "warning")}, ${plural(count("info"), "hint")}`;
}

/** Conditions of a rule element, in order. */
export function conditionsOf(index: MapIndex, el: TopLevelElement): TagOccurrence[] {
  return index.tags.filter((t) => t.name === "condition" && !t.closing && t.start > el.start && t.end <= el.end);
}

function describeFact(tag: TagOccurrence): string {
  return `${tag.attrs.subject ?? "?"} ${tag.attrs.type ?? "?"} ${tag.attrs.object ?? "?"}${tag.attrs.cf && tag.attrs.cf !== "100" ? ` (cf ${tag.attrs.cf})` : ""}`;
}

export function describeRule(text: string, index: MapIndex, el: TopLevelElement): string {
  const a = el.tag.attrs;
  const head = a.name ? `"${a.name}"` : "(unnamed)";
  const target = `${a.type ?? "?"}${a.subject ? ` [subject ${a.subject}]` : ""}${a.object ? ` → ${a.object}` : ""}`;
  const flags = [a.cf ? `cf ${a.cf}` : "cf 100", a["minimum-rule-certainty"] ? `min ${a["minimum-rule-certainty"]}` : "", a.behaviour ?? ""].filter(Boolean).join(" · ");
  const n = conditionsOf(index, el).length;
  return `${head} · ${target} · ${flags} · ${plural(n, "condition")} · L${lineAt(text, el.start)}–${lineAt(text, el.end)}`;
}

/** A compact structural summary of the map for the model. */
export function buildOverview(text: string, extra: OverviewExtra): string {
  const index = buildIndex(text);
  const els = topLevelElements(index);
  const issues = extra.issues ?? collectIssues(text);
  const counts = relinstCounts(index);
  const lines: string[] = [];

  const platform = extra.apiUrl ? `connected to ${extra.apiUrl}` : "not connected to the platform";
  const km = extra.kmId ? `kmID ${extra.kmId}${extra.kmIdSource ? ` (${extra.kmIdSource})` : ""}` : "kmID not set";
  lines.push(`File ${extra.fileName} · ${plural(countLines(text), "line")} · ${summariseIssues(issues)} · ${km} · ${platform}`);

  const hasRoot = index.tags.some((t) => t.name === "rbl:kb" && !t.closing);
  if (!hasRoot) lines.push("No <rbl:kb> root element — the document is empty or not RBLang.");

  const concepts = els.filter((e) => e.kind === "concept");
  lines.push(`\nConcepts (${concepts.length})`);
  for (const c of concepts) {
    const a = c.tag.attrs;
    const flags = [a.type ?? "string", a.behaviour ? "mutually-exclusive" : "", a.scope ? `scope ${a.scope}` : ""].filter(Boolean).join(", ");
    const instances = instancesOf(index, a.name ?? "");
    const ds = index.tags.some((t) => t.name === "datasource" && !t.closing && t.start > c.start && t.end <= c.end) ? " · has datasource" : "";
    const inst = instances.length === 0 ? "no instances" : instances.length <= 12 ? `instances: ${instances.join(", ")}` : `${instances.length} instances (${instances.slice(0, 8).join(", ")}, …)`;
    lines.push(`  ${a.name ?? "?"} [${flags}] L${lineAt(text, c.start)} · ${inst}${ds}`);
  }

  const rels = els.filter((e) => e.kind === "rel");
  lines.push(`\nRelationships (${rels.length})`);
  for (const r of rels) {
    const a = r.tag.attrs;
    const n = counts.get(a.name ?? "") ?? { rules: 0, facts: 0 };
    const forms = index.tags
      .filter((t) => !t.closing && t.start > r.start && t.end <= r.end && /^(firstForm|secondFormObject|secondFormSubject)$/.test(t.name))
      .map((t) => t.name);
    const bits = [
      `askable=${a.askable ?? "all"}`,
      a.plural === "true" ? "plural" : "",
      a.allowUnknown === "true" ? "allowUnknown" : "",
      a.group ? `group "${a.group}"` : "",
      forms.length ? `wording: ${forms.join("/")}` : "",
      `${plural(n.facts, "fact")} · ${plural(n.rules, "rule")}`,
    ].filter(Boolean);
    lines.push(`  ${a.name ?? "?"}: ${a.subject ?? "?"} → ${a.object ?? "?"} · ${bits.join(" · ")} · L${lineAt(text, r.start)}`);
  }

  const facts = els.filter((e) => e.kind === "fact");
  lines.push(`\nFacts (${facts.length})`);
  if (facts.length <= 40) {
    for (const f of facts) lines.push(`  ${describeFact(f.tag)} · L${lineAt(text, f.start)}`);
  } else {
    const perRel = new Map<string, number>();
    for (const f of facts) perRel.set(f.tag.attrs.type ?? "?", (perRel.get(f.tag.attrs.type ?? "?") ?? 0) + 1);
    for (const [rel, n] of perRel) lines.push(`  ${rel}: ${n}`);
    lines.push("  (use read_map to see individual facts)");
  }

  const rules = els.filter((e) => e.kind === "rule");
  lines.push(`\nRules (${rules.length})`);
  for (const r of rules) lines.push(`  ${describeRule(text, index, r)}`);

  const imports = els.filter((e) => e.tag.name === "import");
  const compounds = els.filter((e) => e.tag.name === "compound");
  const others = els.filter((e) => e.kind === "other" && e.tag.name !== "import" && e.tag.name !== "compound");
  const extras: string[] = [];
  if (imports.length) extras.push(`Imports (${imports.length}): ${imports.map((i) => `${i.tag.attrs.km}@${i.tag.attrs.versionNumber}`).join(", ")} — names from linked maps show as unknown here`);
  if (compounds.length) extras.push(`Compounds (${compounds.length}) — legacy, semantics undocumented`);
  if (others.length) extras.push(`Other top-level elements: ${others.map((o) => `<${o.tag.name}> L${lineAt(text, o.start)}`).join(", ")}`);
  if (extras.length) lines.push("", ...extras);

  const errors = issues.filter((i) => i.severity === "error");
  if (errors.length) {
    lines.push(`\nErrors (${errors.length}${errors.length > 10 ? ", first 10" : ""}):`);
    for (const e of errors.slice(0, 10)) lines.push(`  L${e.line + 1}: ${e.message}`);
  }
  return lines.join("\n");
}

/** Lines `start..end` (1-based, inclusive) with line-number gutters, capped. */
export function readRange(text: string, start = 1, end?: number, maxLines = 300): string {
  const all = text.split("\n");
  if (all.length && all[all.length - 1] === "") all.pop();
  const total = all.length;
  const from = Math.max(1, Math.min(start, total || 1));
  let to = Math.min(end ?? total, total);
  if (to < from) to = from;
  let trailer = "";
  if (to - from + 1 > maxLines) {
    to = from + maxLines - 1;
    trailer = `\n… showing lines ${from}–${to} of ${total}. Call again with start_line=${to + 1}.`;
  } else if (end === undefined && to < total) {
    trailer = `\n… ${total - to} more lines.`;
  }
  return numberLines(all.slice(from - 1, to), from) + trailer + (to === total && from === 1 ? "" : `\n(lines ${from}–${to} of ${total})`);
}

export function numberLines(lines: string[], first = 1): string {
  const width = String(first + lines.length - 1).length;
  return lines.map((l, i) => `${String(first + i).padStart(width, " ")} | ${l}`).join("\n");
}

/** Diagnostics for the model: grouped by severity with fix titles. */
export function formatDiagnostics(issues: LintIssue[], severity: "error" | "warning" | "all" = "all"): string {
  const wanted = severity === "all" ? issues : issues.filter((i) => i.severity === severity);
  if (!issues.length) return "No diagnostics — the map passes the linter.";
  if (!wanted.length) return `No ${severity}s. Overall: ${summariseIssues(issues)}.`;
  const order: LintIssue["severity"][] = ["error", "warning", "info"];
  const out = [`${summariseIssues(issues)}.`];
  for (const s of order) {
    const group = wanted.filter((i) => i.severity === s);
    if (!group.length) continue;
    out.push("", `${s === "info" ? "Hints" : s.charAt(0).toUpperCase() + s.slice(1) + "s"}:`);
    for (const i of group) {
      const fixes = i.fixes?.length ? ` — fixes: ${i.fixes.map((f) => f.title).join(" / ")}` : "";
      out.push(`  L${i.line + 1}: ${i.message}${fixes}`);
    }
  }
  return out.join("\n");
}
