/**
 * "What have I changed since this file last matched the platform?" The
 * extension snapshots the exact RBLang it pushes, and the draft it pulls into
 * a file (mapsTree.ts, per environment + kmID). This module turns the snapshot
 * of the map a file is bound to into (a) quick-diff gutter bars via an SCM
 * quick-diff provider and (b) an explicit side-by-side diff command. Both are
 * client-only; "Diff Open File Against Platform Draft" fetches the current
 * draft instead. A file saved from a saved version is skipped: the snapshot
 * records the draft, so its bars would show version-vs-draft differences.
 */
import * as vscode from "vscode";
import { snapshotDocumentUri, snapshotUri } from "./mapsTree";
import { fileKmId, fileKmVersion } from "./platform";

async function snapshotFor(context: vscode.ExtensionContext, uri: vscode.Uri): Promise<vscode.Uri | undefined> {
  if (!/\.(rbl|rblang)$/i.test(uri.path)) return undefined;
  const kmId = fileKmId(context, uri);
  if (!kmId || fileKmVersion(context, uri) !== undefined) return undefined;
  try {
    await vscode.workspace.fs.stat(snapshotUri(context, kmId));
  } catch {
    return undefined;
  }
  return snapshotDocumentUri(kmId);
}

export function registerQuickDiff(context: vscode.ExtensionContext): void {
  // A minimal source control whose only job is the quick-diff provider: no
  // resource groups, no input box. Git (when present) keeps its own gutter
  // decorations; VS Code shows ours for files Git has no original for, and
  // the explicit command below always works. Created when the first RBLang
  // document opens: the extension activates in every window
  // (onStartupFinished), where an empty "Rainbird platform" entry in Source
  // Control would be noise. VS Code re-diffs open editors when a quick-diff
  // provider appears, as it does when Git activates after editors restore.
  let scm: vscode.SourceControl | undefined;
  const ensureScm = (doc: vscode.TextDocument): void => {
    if (scm || doc.languageId !== "rblang") return;
    scm = vscode.scm.createSourceControl("rainbird", "Rainbird platform");
    scm.inputBox.visible = false;
    scm.count = 0;
    scm.quickDiffProvider = {
      provideOriginalResource: (uri) => snapshotFor(context, uri),
    };
    context.subscriptions.push(scm);
  };
  vscode.workspace.textDocuments.forEach(ensureScm);

  context.subscriptions.push(
    // Also fires when a document's language changes, e.g. RBLang pasted into an untitled file.
    vscode.workspace.onDidOpenTextDocument(ensureScm),
    vscode.commands.registerCommand("rainbird.diffAgainstPushed", async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor || editor.document.languageId !== "rblang") {
        vscode.window.showInformationMessage("Open the RBLang (.rbl) file you want to compare first.");
        return;
      }
      const uri = editor.document.uri;
      const kmId = fileKmId(context, uri);
      if (!kmId) {
        const action = await vscode.window.showInformationMessage(
          "This file is not bound to a platform map, so there is no snapshot to compare it with. Snapshots are recorded when you open a map by its Knowledge Map ID (or pull its draft into a file) and when you push. If this file is a copy of a map, bind it and compare with the platform draft; pushing creates a new map.",
          "Bind to a Knowledge Map ID…",
          "Push as a new map"
        );
        if (action === "Bind to a Knowledge Map ID…") await vscode.commands.executeCommand("rainbird.bindKmId", uri);
        else if (action === "Push as a new map") await vscode.commands.executeCommand("rainbird.pushMap");
        return;
      }
      const version = fileKmVersion(context, uri);
      if (version !== undefined) {
        const action = await vscode.window.showInformationMessage(
          `This file is a copy of version ${version} of ${kmId}. The map's snapshot records its draft as last pulled into a file, or what was pushed, so it is not where this file started. Compare with the current platform draft instead?`,
          "Diff Against Platform Draft"
        );
        if (action) await vscode.commands.executeCommand("rainbird.diffAgainstDraft");
        return;
      }
      const snapshot = await snapshotFor(context, uri);
      if (!snapshot) {
        const action = await vscode.window.showInformationMessage(
          `There is no snapshot of ${kmId} yet: one is recorded when its draft is pulled into a file or when you push. Compare with the current platform draft instead?`,
          "Diff Against Platform Draft"
        );
        if (action) await vscode.commands.executeCommand("rainbird.diffAgainstDraft");
        return;
      }
      const name = uri.path.split("/").pop() ?? "map.rbl";
      await vscode.commands.executeCommand(
        "vscode.diff",
        snapshot,
        uri,
        `${name}: last pulled or pushed snapshot (kmID ${kmId}) ↔ local`
      );
    })
  );
}
