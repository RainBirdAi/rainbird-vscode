/**
 * "Does my buffer match what is on the platform?" — the extension snapshots
 * the exact RBLang it sends on every push (mapsTree.ts). This module turns
 * that snapshot into (a) quick-diff gutter bars via an SCM quick-diff
 * provider and (b) an explicit side-by-side diff command. Both are
 * client-only: the platform has no export API to fetch the draft back.
 */
import * as vscode from "vscode";
import { SNAPSHOT_SCHEME, snapshotUri } from "./mapsTree";

function pushedKmId(context: vscode.ExtensionContext, uri: vscode.Uri): string | undefined {
  return context.workspaceState.get<string>(`rainbird.pushedKm.${uri.toString()}`);
}

async function snapshotFor(context: vscode.ExtensionContext, uri: vscode.Uri): Promise<vscode.Uri | undefined> {
  if (!/\.(rbl|rblang)$/i.test(uri.path)) return undefined;
  const kmId = pushedKmId(context, uri);
  if (!kmId) return undefined;
  try {
    await vscode.workspace.fs.stat(snapshotUri(context, kmId));
  } catch {
    return undefined;
  }
  return vscode.Uri.from({ scheme: SNAPSHOT_SCHEME, path: `/${kmId}.rbl` });
}

export function registerQuickDiff(context: vscode.ExtensionContext): void {
  // A minimal source control whose only job is the quick-diff provider: no
  // resource groups, no input box. Git (when present) keeps its own gutter
  // decorations; VS Code shows ours for files Git has no original for, and
  // the explicit command below always works.
  const scm = vscode.scm.createSourceControl("rainbird", "Rainbird platform");
  scm.inputBox.visible = false;
  scm.count = 0;
  scm.quickDiffProvider = {
    provideOriginalResource: (uri) => snapshotFor(context, uri),
  };

  context.subscriptions.push(
    scm,
    vscode.commands.registerCommand("rainbird.diffAgainstPushed", async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor || editor.document.languageId !== "rblang") {
        vscode.window.showInformationMessage("Open the RBLang (.rbl) file you want to compare first.");
        return;
      }
      const kmId = pushedKmId(context, editor.document.uri);
      const snapshot = await snapshotFor(context, editor.document.uri);
      if (!kmId || !snapshot) {
        const push = await vscode.window.showInformationMessage(
          "This file has not been pushed from VSCode yet, so there is no platform snapshot to compare against. Push it first (cloud icon) — every push records exactly what was sent.",
          "Push now"
        );
        if (push) await vscode.commands.executeCommand("rainbird.pushMap");
        return;
      }
      const name = editor.document.uri.path.split("/").pop() ?? "map.rbl";
      await vscode.commands.executeCommand(
        "vscode.diff",
        snapshot,
        editor.document.uri,
        `${name}: pushed snapshot (kmID ${kmId}) ↔ local`
      );
    })
  );
}
