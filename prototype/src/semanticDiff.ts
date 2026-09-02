/**
 * Semantic diff: compares the open RBLang file against git HEAD (or a picked
 * base file) at the model level — concepts, relationships, instances, facts,
 * rules — instead of XML line noise. This operationalizes the "export, diff,
 * review in a pull request" promise; the output is a markdown report an SME
 * can read in a PR.
 */
import * as vscode from "vscode";
import { buildIndex, MapIndex, TagOccurrence } from "./mapIndex";

interface Rule {
  identity: string;
  type: string;
  name?: string;
  cf: string;
  behaviour?: string;
  alt?: string;
  conditions: string[];
}

interface Model {
  concepts: Map<string, string>;
  rels: Map<string, string>;
  instances: Map<string, string>;
  facts: Set<string>;
  rules: Map<string, Rule>;
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

  const report = diffReport(buildModel(base.text), buildModel(doc.getText()), base.label, doc.uri.path.split("/").pop() ?? "current");
  const md = await vscode.workspace.openTextDocument({ language: "markdown", content: report });
  await vscode.window.showTextDocument(md, { preview: false });
  await vscode.commands.executeCommand("markdown.showPreview", md.uri);
}

async function baseContent(doc: vscode.TextDocument): Promise<{ text: string; label: string } | undefined> {
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
        return { text, label: "HEAD" };
      }
    } catch {
      // Not in git / unborn HEAD — fall through to file picker.
    }
  }
  const picked = await vscode.window.showOpenDialog({
    title: "No git history for this file — pick the base version to compare against",
    filters: { RBLang: ["rbl", "rblang", "xml"] },
    canSelectMany: false,
  });
  if (!picked?.[0]) return undefined;
  const raw = await vscode.workspace.fs.readFile(picked[0]);
  return { text: Buffer.from(raw).toString("utf8"), label: picked[0].path.split("/").pop() ?? "base" };
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
    after.rules,
    (r) => `${r.type}, cf ${r.cf}, ${r.conditions.length} condition${r.conditions.length === 1 ? "" : "s"}`,
    (ra, rb) => {
      const details: string[] = [];
      if (ra.cf !== rb.cf) details.push(`cf ${ra.cf} → ${rb.cf}`);
      if (ra.behaviour !== rb.behaviour) details.push(`behaviour ${ra.behaviour ?? "default"} → ${rb.behaviour ?? "default"}`);
      if (ra.alt !== rb.alt) details.push("evidence text (alt) changed");
      const dropped = ra.conditions.filter((c) => !rb.conditions.includes(c));
      const gained = rb.conditions.filter((c) => !ra.conditions.includes(c));
      for (const c of gained) details.push(`condition added: ${c}`);
      for (const c of dropped) details.push(`condition removed: ${c}`);
      return details.length ? details.join("; ") : undefined;
    }
  );

  if (changes === 0) lines.push("No model-level changes — differences (if any) are formatting only.");
  else lines.splice(2, 0, `**${changes} model-level change${changes > 1 ? "s" : ""}.** Unnamed rules are matched positionally per relationship — naming rules makes diffs more precise.`, "");
  return lines.join("\n");
}
