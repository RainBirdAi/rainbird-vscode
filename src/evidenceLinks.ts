/**
 * "Open in Studio" and "Copy link" for evidence trees, shared by the query
 * panel and the standalone evidence view. Kept out of queryRunner.ts (which
 * imports evidenceView.ts) so neither view creates an import cycle, and out of
 * studioLinks.ts so that module stays testable without vscode.
 */
import * as vscode from "vscode";
import { deriveStudioUrl, evidenceLink, hostOf, normaliseStudioUrl } from "./studioLinks";

const SET_STUDIO_URL = "Set Studio URL…";

/** The rainbird.apiUrl setting, as every other Rainbird command reads it. */
export function currentApiUrl(): string {
  return vscode.workspace.getConfiguration("rainbird").get<string>("apiUrl") || "https://api.rainbird.ai";
}

/**
 * The Studio base URL for an API URL (default: rainbird.apiUrl). Known
 * *.rainbird.ai API hosts are derived first, so a private Studio URL entered
 * once never leaks into Community or Enterprise links; rainbird.studioUrl is
 * read only for hosts that cannot be derived.
 */
export function resolveStudioUrl(apiUrl: string = currentApiUrl()): string | undefined {
  const derived = deriveStudioUrl(apiUrl);
  if (derived) return derived;
  return normaliseStudioUrl(vscode.workspace.getConfiguration("rainbird").get<string>("studioUrl"));
}

/** Sessions already warned that a link cannot carry the evidence key (once per session is enough). */
const warnedAboutKey = new Set<string>();

/**
 * Open the Studio evidence tree for a fact in the browser, or copy its link.
 * When no Studio URL can be worked out, offers to set rainbird.studioUrl. When
 * an evidence key is in use, it acts first and then warns, once per session and
 * without waiting for a click: a link cannot carry the key, so for a map that
 * needs one it only opens if the map's Evidence Tree Link is enabled. (A stored
 * key does not mean this map needed it, so the warning must not block.)
 * Resolves true when the link was opened or copied.
 */
export async function openOrCopyEvidenceLink(
  action: "open" | "copy",
  args: { apiUrl: string; factId: string; sessionId: string; usedEvidenceKey?: boolean }
): Promise<boolean> {
  if (!args.factId || !args.sessionId) return false;
  let studioUrl = resolveStudioUrl(args.apiUrl);
  if (!studioUrl) {
    studioUrl = await askForStudioUrl(args.apiUrl);
    if (!studioUrl) return false;
  }
  const link = evidenceLink({ studioUrl, apiUrl: args.apiUrl, factId: args.factId, sessionId: args.sessionId });

  if (action === "open") {
    const opened = await vscode.env.openExternal(vscode.Uri.parse(link));
    if (!opened) {
      vscode.window.showWarningMessage(`Could not open the browser. The Studio link is: ${link}`);
      return false;
    }
  } else {
    await vscode.env.clipboard.writeText(link);
    vscode.window.setStatusBarMessage("Rainbird: evidence link copied. Sessions expire, so share it soon.", 5000);
  }

  if (args.usedEvidenceKey && !warnedAboutKey.has(args.sessionId)) {
    warnedAboutKey.add(args.sessionId);
    void vscode.window.showWarningMessage(
      "An evidence key is set, and a Studio link cannot carry it. If this map needs the key, the link only opens once Evidence Tree Link is enabled for the map in Studio (Publish → API Management → Access Control)."
    );
  }
  return true;
}

async function askForStudioUrl(apiUrl: string): Promise<string | undefined> {
  const host = hostOf(apiUrl) ?? apiUrl;
  const choice = await vscode.window.showWarningMessage(
    `Rainbird cannot work out the Studio address for ${host}. Set rainbird.studioUrl to the Studio URL of this environment (for example https://clientname.rainbird.ai).`,
    SET_STUDIO_URL
  );
  if (choice !== SET_STUDIO_URL) return undefined;
  const entered = await vscode.window.showInputBox({
    title: "Rainbird Studio URL",
    prompt: `Studio address for the API at ${host}. Used only for "Open in Studio" and "Copy link".`,
    placeHolder: "https://clientname.rainbird.ai",
    value: "https://",
    ignoreFocusOut: true,
    validateInput: (value) => (normaliseStudioUrl(value) ? undefined : "Enter the Studio address, for example https://clientname.rainbird.ai"),
  });
  const studioUrl = normaliseStudioUrl(entered);
  if (!studioUrl) return undefined;
  try {
    await vscode.workspace.getConfiguration("rainbird").update("studioUrl", studioUrl, vscode.ConfigurationTarget.Global);
  } catch (error) {
    // Still use it for this link; only remembering it failed.
    vscode.window.showWarningMessage(`Could not save rainbird.studioUrl: ${(error as Error).message}`);
  }
  return studioUrl;
}
