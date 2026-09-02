/**
 * .rbird interop: Studio's export format is gzip-compressed JSON whose
 * unicronData.rblang array holds the map's RBLang source lines. This command
 * extracts that source next to the export so it can be diffed, reviewed and
 * versioned — the "your logic in git" wedge.
 */
import * as vscode from "vscode";
import { gunzipSync } from "zlib";

interface RbirdFile {
  format: string;
  version: string;
  unicronData?: { rblang?: string[] };
  studioData?: unknown;
}

export async function extractRbird(uri?: vscode.Uri): Promise<void> {
  const target =
    uri ??
    (
      await vscode.window.showOpenDialog({
        filters: { "Rainbird export": ["rbird"] },
        canSelectMany: false,
      })
    )?.[0];
  if (!target) return;

  try {
    const raw = Buffer.from(await vscode.workspace.fs.readFile(target));
    const json = raw[0] === 0x1f && raw[1] === 0x8b ? gunzipSync(raw) : raw;
    const parsed = JSON.parse(json.toString("utf8")) as RbirdFile;
    const rblang = parsed.unicronData?.rblang;
    if (!rblang || rblang.length === 0) {
      vscode.window.showErrorMessage("No RBLang source found in this .rbird file.");
      return;
    }

    const output = vscode.Uri.file(target.fsPath.replace(/\.rbird$/i, ".rbl"));
    await vscode.workspace.fs.writeFile(output, Buffer.from(rblang.join("\n"), "utf8"));
    const doc = await vscode.workspace.openTextDocument(output);
    await vscode.window.showTextDocument(doc);
    vscode.window.showInformationMessage(`Extracted RBLang to ${vscode.workspace.asRelativePath(output)}`);
  } catch (error) {
    vscode.window.showErrorMessage(`Could not extract .rbird file: ${(error as Error).message}`);
  }
}

// NOTE: a "Package as .rbird" reverse command existed briefly and was removed:
// a live round-trip showed Studio's importer does not reconstruct the map from
// the unicronData.rblang lines alone (it relies on the parallel structured
// model arrays), so a repack from text produces a broken import. Rebuilding
// those arrays needs the full parser — tracked in PROPOSAL.md; until then the
// governed path into Studio is pushing via POST /maps or Studio's own import
// of a Studio-produced .rbird.
