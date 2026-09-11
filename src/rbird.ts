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

/** RBLang source from a .rbird buffer (gzip or plain JSON), or undefined when the export has none. */
export function decodeRbird(raw: Buffer): string | undefined {
  const json = raw[0] === 0x1f && raw[1] === 0x8b ? gunzipSync(raw) : raw;
  const parsed = JSON.parse(json.toString("utf8")) as RbirdFile;
  const rblang = parsed.unicronData?.rblang;
  return rblang && rblang.length ? rblang.join("\n") : undefined;
}

/**
 * Read-only virtual documents for export files (content provider registered in
 * compareSource.ts), so a .rbird export can be one side of the diff editor.
 */
export const EXPORT_SCHEME = "rainbird-export";

export function exportUri(file: vscode.Uri): vscode.Uri {
  const name = (file.path.split("/").pop() ?? "export").replace(/\.rbird$/i, ".rbl");
  return vscode.Uri.from({ scheme: EXPORT_SCHEME, path: `/${name}`, query: encodeURIComponent(file.fsPath) });
}

/** Read RBLang from a .rbird export or a plain .rbl/.xml file — the two shapes a Studio round-trip produces. */
export async function readRblang(uri: vscode.Uri): Promise<string> {
  const raw = Buffer.from(await vscode.workspace.fs.readFile(uri));
  if (/\.rbird$/i.test(uri.path) || (raw[0] === 0x1f && raw[1] === 0x8b)) {
    const rblang = decodeRbird(raw);
    if (!rblang) throw new Error(`${uri.path.split("/").pop()} contains no RBLang source.`);
    return rblang;
  }
  return raw.toString("utf8");
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
    const rblang = decodeRbird(Buffer.from(await vscode.workspace.fs.readFile(target)));
    if (!rblang) {
      vscode.window.showErrorMessage("No RBLang source found in this .rbird file.");
      return;
    }

    const output = vscode.Uri.file(target.fsPath.replace(/\.rbird$/i, ".rbl"));
    await vscode.workspace.fs.writeFile(output, Buffer.from(rblang, "utf8"));
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
