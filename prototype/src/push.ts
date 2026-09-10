/**
 * Push the open RBLang file to the Rainbird platform via POST /maps.
 *
 * Honest create-only semantics: the endpoint is undocumented (verified from
 * Rainbird's own tooling) and every push creates a NEW map with a new kmID —
 * there is no update-in-place or delete API, so pushed scratch maps are
 * cleaned up manually in Studio. The returned kmID is remembered per file and
 * can be chained straight into the query panel.
 */
import * as vscode from "vscode";
import { getClient } from "./queryRunner";
import { collectIssues } from "./diagnostics";
import { QueryPanel } from "./queryPanel";
import { recordKnownMap } from "./mapsTree";
import { ApiError } from "./api";
import { clearPlatformErrors, showPlatformErrors, showPlatformOutput } from "./platformDiagnostics";

export async function pushMap(context: vscode.ExtensionContext): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document.languageId !== "rblang") {
    vscode.window.showInformationMessage("Open the RBLang (.rbl) file you want to push first.");
    return;
  }
  const doc = editor.document;
  const rblang = doc.getText();

  const errors = collectIssues(rblang).filter((i) => i.severity === "error");
  if (errors.length > 0) {
    const proceed = await vscode.window.showWarningMessage(
      `This map has ${errors.length} lint error${errors.length > 1 ? "s" : ""} — the platform will likely reject it. Push anyway?`,
      { modal: true },
      "Push anyway"
    );
    if (proceed !== "Push anyway") return;
  }

  const client = await getClient(context);
  if (!client) return;

  const fileName = doc.uri.path.split("/").pop()?.replace(/\.(rbl|rblang)$/, "") ?? "map";
  const stamp = new Date().toISOString().slice(0, 16).replace("T", " ").replace(":", "");
  const name = await vscode.window.showInputBox({
    prompt: "Name for the new map on the platform (every push creates a new map)",
    value: `${fileName} ${stamp}`,
    ignoreFocusOut: true,
  });
  if (!name) return;

  const description = await vscode.window.showInputBox({
    prompt: "Description (the platform validates this — keep it simple: letters, numbers, spaces)",
    value: "Pushed from VSCode",
    ignoreFocusOut: true,
  });
  if (description === undefined) return;

  try {
    clearPlatformErrors(doc.uri);
    const { kmId, raw, validation } = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Pushing "${name}" to Rainbird…` },
      () => client.createMap(rblang, name, description)
    );

    if (!kmId) {
      const show = await vscode.window.showWarningMessage(
        "The map was uploaded but the response had no recognisable kmID field.",
        "Show response"
      );
      if (show) {
        const json = await vscode.workspace.openTextDocument({ language: "json", content: JSON.stringify(raw, null, 2) });
        await vscode.window.showTextDocument(json);
      }
      return;
    }

    await context.workspaceState.update(`rainbird.pushedKm.${doc.uri.toString()}`, kmId);
    recordKnownMap(context, {
      kmId,
      name,
      source: "pushed",
      rblang,
      ...(doc.uri.scheme === "file" ? { file: doc.uri.fsPath } : {}),
    });

    let action: string | undefined;
    if (validation.length) {
      // The platform stores the draft as-is and reports (only) the first problem it found.
      showPlatformErrors(doc, validation, `Push of "${name}" (kmID ${kmId}) accepted with validation errors`);
      action = await vscode.window.showWarningMessage(
        `Pushed "${name}" (kmID ${kmId}), but Rainbird reported a validation error, shown in the Problems panel: ${validation[0]}. The platform reports one problem per push; fix it and the next push may reveal another.`,
        "Show Problems",
        "Run query",
        "Copy kmID"
      );
    } else {
      action = await vscode.window.showInformationMessage(
        `Pushed to Rainbird — new map "${name}" (kmID ${kmId}). Remember: pushes are create-only; delete old scratch maps in Studio.`,
        "Run query",
        "Copy kmID",
        "Use as workspace kmID"
      );
    }
    if (action === "Show Problems") {
      await vscode.commands.executeCommand("workbench.actions.view.problems");
    } else if (action === "Run query") {
      await QueryPanel.open(context, kmId);
    } else if (action === "Copy kmID") {
      await vscode.env.clipboard.writeText(kmId);
    } else if (action === "Use as workspace kmID") {
      await vscode.workspace
        .getConfiguration("rainbird", doc.uri)
        .update("knowledgeMapId", kmId, vscode.ConfigurationTarget.Workspace);
    }
  } catch (error) {
    const validation = error instanceof ApiError ? error.errMessages() : undefined;
    if (validation?.length) {
      showPlatformErrors(doc, validation, `Push of "${name}" rejected by Rainbird`);
      const n = validation.length;
      const action = await vscode.window.showErrorMessage(
        `Rainbird rejected "${name}": ${n} validation error${n === 1 ? "" : "s"}, shown in the Problems panel at the elements they refer to. First: ${validation[0]}`,
        "Show Problems",
        "Show all"
      );
      if (action === "Show Problems") await vscode.commands.executeCommand("workbench.actions.view.problems");
      else if (action === "Show all") showPlatformOutput();
      return;
    }
    const message = (error as Error).message;
    const hint = /NAME_ERROR|DESCRIPTION_ERROR/.test(message)
      ? " — the platform rejected the name/description text; retry with only letters, numbers and spaces."
      : "";
    vscode.window.showErrorMessage(`Push failed: ${message}${hint}`);
  }
}
