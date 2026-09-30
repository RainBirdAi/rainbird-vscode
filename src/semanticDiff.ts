/**
 * Diff the open RBLang file against git HEAD (or a picked base file). The
 * primary view is the git-diff experience — both sources side by side in
 * VS Code's diff editor with added / removed / changed lines highlighted. On
 * top of that, the model-level semantic diff (concepts, relationships,
 * instances, facts, rules — not XML line noise) is summarised in the
 * notification and available as a markdown report an SME can read in a PR.
 */
import * as vscode from "vscode";
import { buildModel, diffReportDetailed, Report } from "./semanticModel";
import { exportUri, readRblang } from "./rbird";

export { buildModel, diffReport, diffReportDetailed } from "./semanticModel";
export type { Model, Report, Rule } from "./semanticModel";

/** One side of a comparison: its RBLang text, a label for titles, and a URI the diff editor can open. */
export interface DiffSide {
  label: string;
  text: string;
  uri: vscode.Uri;
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

/** The file's content at git HEAD, when it lives in a repository the git extension knows about. */
export async function gitHeadSide(doc: vscode.TextDocument): Promise<DiffSide | undefined> {
  const gitExtension = vscode.extensions.getExtension("vscode.git");
  if (!gitExtension) return undefined;
  try {
    const api = (await gitExtension.activate()).getAPI(1);
    const repo = api.repositories.find((r: { rootUri: vscode.Uri }) => doc.uri.fsPath.startsWith(r.rootUri.fsPath));
    if (!repo) return undefined;
    const text = await repo.show("HEAD", doc.uri.fsPath);
    return { text, label: "HEAD", uri: api.toGitUri(doc.uri, "HEAD") };
  } catch {
    return undefined; // not in git / unborn HEAD
  }
}

async function baseContent(doc: vscode.TextDocument): Promise<DiffSide | undefined> {
  // Prefer git HEAD when the file is in a repository.
  const fromGit = await gitHeadSide(doc);
  if (fromGit) return fromGit;
  const picked = await vscode.window.showOpenDialog({
    title: "No git history for this file — pick the base version to compare against (.rbl or a Studio .rbird export)",
    filters: { "RBLang or Studio export": ["rbl", "rblang", "xml", "rbird"] },
    canSelectMany: false,
  });
  if (!picked?.[0]) return undefined;
  return { text: await readRblang(picked[0]), label: picked[0].path.split("/").pop() ?? "base", uri: exportUri(picked[0]) };
}

