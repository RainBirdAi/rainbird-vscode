/**
 * Standalone evidence view: one editor tab per evidence tree, drawn by the
 * shared Studio-style renderer (src/evidenceRender.ts) so it matches the query
 * panel's inline tree, with Expand all / Collapse all, Open in Studio and Copy
 * link. Used by "Rainbird: Show Evidence Tree for Fact…", the Quick Pick query
 * runner and the query panel's "Open in panel".
 */
import { randomBytes } from "crypto";
import * as vscode from "vscode";
import { ApiError, RainbirdClient } from "./api";
import { ExpandedEvidence } from "./evidenceModel";
import { renderEvidencePage, tripleText } from "./evidenceRender";
import { currentApiUrl, openOrCopyEvidenceLink } from "./evidenceLinks";

/** The evidence key, or a function that reads the current one (needed to retry after "Set evidence key…"). */
export type EvidenceKeySource = string | (() => Promise<string | undefined>);

const SET_KEY = "Set evidence key…";
const LOCKED =
  "Evidence is locked for this map. Enable Evidence Tree Link in Studio (Publish → API Management → Access Control), or enter the map's evidence key.";

/**
 * Fetch (unless `prefetched` is given) and show the evidence tree for a fact.
 * A locked tree (401/403) offers "Set evidence key…" and retries only when the
 * key actually changed; that needs `evidenceKey` as a function — with a plain
 * string the user is asked to open the tree again.
 */
export async function showEvidenceTree(
  client: RainbirdClient,
  sessionId: string,
  factId: string,
  evidenceKey?: EvidenceKeySource,
  prefetched?: ExpandedEvidence
): Promise<void> {
  const apiUrl = currentApiUrl();
  const readKey = async () => (typeof evidenceKey === "function" ? await evidenceKey() : evidenceKey) || undefined;
  let key = await readKey();
  let tree = prefetched;

  while (!tree) {
    try {
      const usedKey = key;
      tree = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Window, title: "Rainbird: loading the evidence tree…" },
        () => client.fullEvidence(factId, sessionId, usedKey)
      );
    } catch (error) {
      if (!(error instanceof ApiError && (error.status === 401 || error.status === 403))) {
        vscode.window.showErrorMessage(`Could not fetch evidence: ${(error as Error).message}`);
        return;
      }
      const choice = await vscode.window.showErrorMessage(LOCKED, SET_KEY);
      if (choice !== SET_KEY) return;
      await vscode.commands.executeCommand("rainbird.setEvidenceKey");
      if (typeof evidenceKey !== "function") {
        vscode.window.showInformationMessage("If you entered a new evidence key, open the evidence tree again to use it.");
        return;
      }
      const next = await readKey();
      if (next === key) return; // cancelled or unchanged: retrying would hit the same lock
      key = next;
    }
  }

  const loaded = tree;
  const fact = loaded.fact;
  // Formatted like the tree itself, so a date result reads 2025-07-01 in the tab title too.
  const triple = fact ? tripleText(fact.subject?.value, fact.relationship?.type, fact.object?.value, fact.object?.dataType) : factId;
  const panel = vscode.window.createWebviewPanel("rainbirdEvidence", shorten(`Evidence: ${triple}`, 60), vscode.ViewColumn.Beside, {
    enableScripts: true,
    retainContextWhenHidden: true,
    localResourceRoots: [],
  });
  panel.webview.html = renderEvidencePage(loaded, {
    nonce: randomBytes(16).toString("base64"),
    heading: `Evidence: ${triple}`,
    subheading: `Session ${sessionId} · fact ${loaded.factID || factId}`,
    render: { collapseDepth: 2, toolbar: { studio: true, copyLink: true } },
  });

  const usedEvidenceKey = !!key;
  const listener = panel.webview.onDidReceiveMessage(async (message: { type?: unknown; action?: unknown; factId?: unknown }) => {
    if (message?.type !== "evidenceAction") return;
    if (message.action !== "openStudio" && message.action !== "copyLink") return; // "openPanel": already in a panel
    await openOrCopyEvidenceLink(message.action === "openStudio" ? "open" : "copy", {
      apiUrl,
      factId: typeof message.factId === "string" && message.factId ? message.factId : loaded.factID || factId,
      sessionId,
      usedEvidenceKey,
    });
  });
  panel.onDidDispose(() => listener.dispose());
}

function shorten(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
