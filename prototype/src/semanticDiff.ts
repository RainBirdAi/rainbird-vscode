/**
 * Diff the open RBLang file against git HEAD (or a picked base file). The
 * primary view is the git-diff experience — both sources side by side in
 * VS Code's diff editor with added / removed / changed lines highlighted. On
 * top of that, the model-level semantic diff (concepts, relationships,
 * instances, facts, rules — not XML line noise) is summarised in the
 * notification and available as a markdown report an SME can read in a PR.
 */
import * as vscode from "vscode";
import { buildIndex, MapIndex, TagOccurrence } from "./mapIndex";
import { exportUri, readRblang } from "./rbird";

interface Rule {
  identity: string;
  type: string;
  name?: string;
  cf: string;
  behaviour?: string;
  alt?: string;
  conditions: string[];
  /** Set by pairRules: this rule's identity in the "after" model when it was renamed (or newly named). */
  renamed?: string;
}

/** A condition without its tunables (weight, mandatory) — what identifies it across edits. */
const conditionSignature = (c: string) => c.replace(/ \(mandatory\)/, "").replace(/ w=\d+$/, "");

/**
 * Unnamed rules are identified positionally ("speaks #1"), so naming a rule, or
 * renaming one, looks like a removal plus an addition. Pair the leftovers on
 * each side — first by identical relationship + condition set, then when a
 * relationship has exactly one unmatched rule on both sides — and re-key the
 * "after" rule under the "before" identity so the diff reports a modification.
 */
function pairRules(before: Map<string, Rule>, after: Map<string, Rule>): Map<string, Rule> {
  const paired = new Map(after);
  const onlyBefore = [...before.keys()].filter((k) => !after.has(k));
  const onlyAfter = [...after.keys()].filter((k) => !before.has(k));
  const shape = (r: Rule) => `${r.type}|${r.conditions.map(conditionSignature).sort().join("|")}`;
  const adopt = (kb: string, ka: string) => {
    const ra = paired.get(ka)!;
    paired.delete(ka);
    paired.set(kb, { ...ra, renamed: ka });
    onlyAfter.splice(onlyAfter.indexOf(ka), 1);
  };
  for (const kb of [...onlyBefore]) {
    const rb = before.get(kb)!;
    const ka = onlyAfter.find((k) => shape(after.get(k)!) === shape(rb));
    if (ka) {
      adopt(kb, ka);
      onlyBefore.splice(onlyBefore.indexOf(kb), 1);
    }
  }
  for (const kb of [...onlyBefore]) {
    const rb = before.get(kb)!;
    const sameTypeBefore = onlyBefore.filter((k) => before.get(k)!.type === rb.type);
    const sameTypeAfter = onlyAfter.filter((k) => after.get(k)!.type === rb.type);
    if (sameTypeBefore.length === 1 && sameTypeAfter.length === 1) {
      adopt(kb, sameTypeAfter[0]);
      onlyBefore.splice(onlyBefore.indexOf(kb), 1);
    }
  }
  return paired;
}

interface Model {
  concepts: Map<string, string>;
  rels: Map<string, string>;
  instances: Map<string, string>;
  facts: Set<string>;
  rules: Map<string, Rule>;
}

/** One side of a comparison: its RBLang text, a label for titles, and a URI the diff editor can open. */
export interface DiffSide {
  label: string;
  text: string;
  uri: vscode.Uri;
}

/** The report markdown plus how many model-level changes it lists. */
export interface Report {
  markdown: string;
  changes: number;
}

/**
 * Show two versions side by side in VS Code's diff editor (like `git diff`:
 * additions green, removals red, changed lines highlighted), then summarise the
 * model-level changes and offer the semantic report.
 */
export async function showSideBySideDiff(base: DiffSide, newer: DiffSide, report: Report): Promise<void> {
  await vscode.commands.executeCommand("vscode.diff", base.uri, newer.uri, `${base.label} ↔ ${newer.label}`);
  const summary =
    report.changes === 0
      ? "No model-level changes — highlighted lines, if any, are formatting only."
      : `${report.changes} model-level change${report.changes === 1 ? "" : "s"} (concepts, relationships, instances, facts, rules).`;
  const open = await vscode.window.showInformationMessage(summary, "Semantic report");
  if (open) await showReport(report.markdown);
}

/** Open the markdown report in an editor with its preview. */
export async function showReport(markdown: string): Promise<void> {
  const md = await vscode.workspace.openTextDocument({ language: "markdown", content: markdown });
  await vscode.window.showTextDocument(md, { preview: false });
  await vscode.commands.executeCommand("markdown.showPreview", md.uri);
}

export async function semanticDiff(): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document.languageId !== "rblang") {
    vscode.window.showInformationMessage("Open the RBLang (.rbl) file you want to diff first.");
    return;
  }
  const doc = editor.document;

  const base = await baseContent(doc);
  if (!base) return;

  const newer: DiffSide = { label: doc.uri.path.split("/").pop() ?? "current", text: doc.getText(), uri: doc.uri };
  await showSideBySideDiff(base, newer, diffReportDetailed(buildModel(base.text), buildModel(newer.text), base.label, newer.label));
}

async function baseContent(doc: vscode.TextDocument): Promise<DiffSide | undefined> {
  // Prefer git HEAD when the file is in a repository.
  const gitExtension = vscode.extensions.getExtension("vscode.git");
  if (gitExtension) {
    try {
      const api = (await gitExtension.activate()).getAPI(1);
      const repo = api.repositories.find((r: { rootUri: vscode.Uri }) =>
        doc.uri.fsPath.startsWith(r.rootUri.fsPath)
      );
      if (repo) {
        const text = await repo.show("HEAD", doc.uri.fsPath);
        return { text, label: "HEAD", uri: api.toGitUri(doc.uri, "HEAD") };
      }
    } catch {
      // Not in git / unborn HEAD — fall through to file picker.
    }
  }
  const picked = await vscode.window.showOpenDialog({
    title: "No git history for this file — pick the base version to compare against (.rbl or a Studio .rbird export)",
    filters: { "RBLang or Studio export": ["rbl", "rblang", "xml", "rbird"] },
    canSelectMany: false,
  });
  if (!picked?.[0]) return undefined;
  return { text: await readRblang(picked[0]), label: picked[0].path.split("/").pop() ?? "base", uri: exportUri(picked[0]) };
}

export function buildModel(text: string): Model {
  const index = buildIndex(text);
  const model: Model = {
    concepts: new Map(),
    rels: new Map(),
    instances: new Map(),
    facts: new Set(),
    rules: new Map(),
  };
  for (const [name, c] of index.concepts) model.concepts.set(name, c.type);
  for (const [name, r] of index.relationships) model.rels.set(name, `${r.subject} → ${r.object}${r.plural ? " (plural)" : ""}`);
  for (const [name, i] of index.instances) model.instances.set(name, i.type);

  const perTypeOrdinal = new Map<string, number>();
  collectRelinsts(index, (tag, conditions) => {
    const type = tag.attrs.type ?? "?";
    if (conditions.length === 0) {
      model.facts.add(`${tag.attrs.subject ?? "?"} **${type}** ${tag.attrs.object ?? "?"} (cf ${tag.attrs.cf ?? "100"})`);
      return;
    }
    const ordinal = (perTypeOrdinal.get(type) ?? 0) + 1;
    perTypeOrdinal.set(type, ordinal);
    const identity = tag.attrs.name ?? `${type} #${ordinal}`;
    model.rules.set(identity, {
      identity,
      type,
      name: tag.attrs.name,
      cf: tag.attrs.cf ?? "100",
      behaviour: tag.attrs.behaviour,
      alt: tag.attrs.alt,
      conditions,
    });
  });
  return model;
}

/** Walk relinst elements, gathering their normalized condition strings. */
function collectRelinsts(index: MapIndex, visit: (tag: TagOccurrence, conditions: string[]) => void): void {
  for (let i = 0; i < index.tags.length; i++) {
    const tag = index.tags[i];
    if (tag.closing || tag.name !== "relinst") continue;
    const conditions: string[] = [];
    if (!tag.selfClosing) {
      for (let j = i + 1; j < index.tags.length; j++) {
        const inner = index.tags[j];
        if (inner.name === "relinst" && inner.closing) break;
        if (inner.name === "condition" && !inner.closing) {
          conditions.push(
            inner.attrs.expression
              ? `expr: ${inner.attrs.expression}${inner.attrs.value ? ` → ${inner.attrs.value}` : ""}`
              : `${inner.attrs.subject ?? "?"} ${inner.attrs.rel ?? "?"} ${inner.attrs.object ?? "?"}` +
                (inner.attrs.behaviour === "mandatory" ? " (mandatory)" : "") +
                (inner.attrs.weight ? ` w=${inner.attrs.weight}` : "")
          );
        }
      }
    }
    visit(tag, conditions);
  }
}

export function diffReport(before: Model, after: Model, baseLabel: string, fileLabel: string): string {
  return diffReportDetailed(before, after, baseLabel, fileLabel).markdown;
}

export function diffReportDetailed(before: Model, after: Model, baseLabel: string, fileLabel: string): Report {
  const lines: string[] = [`# Semantic diff — ${fileLabel} vs ${baseLabel}`, ""];
  let changes = 0;

  const section = <V>(
    title: string,
    a: Map<string, V>,
    b: Map<string, V>,
    describe: (v: V) => string,
    changed?: (va: V, vb: V) => string | undefined
  ) => {
    const added = [...b.keys()].filter((k) => !a.has(k));
    const removed = [...a.keys()].filter((k) => !b.has(k));
    const modified: string[] = [];
    for (const k of b.keys()) {
      if (!a.has(k)) continue;
      const description = changed
        ? changed(a.get(k)!, b.get(k)!)
        : describe(a.get(k)!) !== describe(b.get(k)!)
          ? `${describe(a.get(k)!)} → ${describe(b.get(k)!)}`
          : undefined;
      if (description) modified.push(`- ~ **${k}**: ${description}`);
    }
    if (!added.length && !removed.length && !modified.length) return;
    changes += added.length + removed.length + modified.length;
    lines.push(`## ${title}`, "");
    for (const k of added) lines.push(`- ＋ **${k}** (${describe(b.get(k)!)})`);
    for (const k of removed) lines.push(`- － **${k}** (was ${describe(a.get(k)!)})`);
    lines.push(...modified, "");
  };

  section("Concepts", before.concepts, after.concepts, (t) => t);
  section("Relationships", before.rels, after.rels, (s) => s);
  section("Instances", before.instances, after.instances, (t) => t);

  const factsAdded = [...after.facts].filter((f) => !before.facts.has(f));
  const factsRemoved = [...before.facts].filter((f) => !after.facts.has(f));
  if (factsAdded.length || factsRemoved.length) {
    changes += factsAdded.length + factsRemoved.length;
    lines.push("## Facts", "");
    for (const f of factsAdded) lines.push(`- ＋ ${f}`);
    for (const f of factsRemoved) lines.push(`- － ${f}`);
    lines.push("");
  }

  section(
    "Rules",
    before.rules,
    pairRules(before.rules, after.rules),
    (r) => `${r.type}, cf ${r.cf}, ${r.conditions.length} condition${r.conditions.length === 1 ? "" : "s"}`,
    (ra, rb) => {
      const details: string[] = [];
      if (rb.renamed) details.push(ra.name ? `renamed to "${rb.renamed}"` : `named "${rb.renamed}"`);
      if (ra.cf !== rb.cf) details.push(`cf ${ra.cf} → ${rb.cf}`);
      if (ra.behaviour !== rb.behaviour) details.push(`behaviour ${ra.behaviour ?? "default"} → ${rb.behaviour ?? "default"}`);
      if (ra.alt !== rb.alt) details.push("evidence text (alt) changed");
      const dropped = ra.conditions.filter((c) => !rb.conditions.includes(c));
      const gained = rb.conditions.filter((c) => !ra.conditions.includes(c));
      // Pair a dropped and a gained condition that share the same triple / expression:
      // that is one condition whose weight or behaviour changed, not a swap.
      const signature = conditionSignature;
      const weightOf = (c: string) => / w=(\d+)$/.exec(c)?.[1] ?? "100";
      const mandatory = (c: string) => / \(mandatory\)/.test(c);
      const unmatchedGained = [...gained];
      for (const before of dropped) {
        const at = unmatchedGained.findIndex((after) => signature(after) === signature(before));
        if (at === -1) {
          details.push(`condition removed: ${before}`);
          continue;
        }
        const after = unmatchedGained.splice(at, 1)[0];
        const changes: string[] = [];
        if (weightOf(before) !== weightOf(after)) changes.push(`weight ${weightOf(before)} → ${weightOf(after)}`);
        if (mandatory(before) !== mandatory(after)) changes.push(mandatory(after) ? "now mandatory" : "now optional");
        details.push(`condition ${signature(before)}: ${changes.join(", ") || "changed"}`);
      }
      for (const c of unmatchedGained) details.push(`condition added: ${c}`);
      return details.length ? details.join("; ") : undefined;
    }
  );

  if (changes === 0) lines.push("No model-level changes — differences (if any) are formatting only.");
  else lines.splice(2, 0, `**${changes} model-level change${changes > 1 ? "s" : ""}.** Unnamed rules are matched positionally per relationship — naming rules makes diffs more precise.`, "");
  return { markdown: lines.join("\n"), changes };
}
