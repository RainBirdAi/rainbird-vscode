/**
 * Evidence tree webview: renders the recursive derivation of a fact with the
 * same source colour-coding Rainbird's docs define (rule / answer / injection
 * / datasource / knowledge map / synthesis) plus per-condition impact and
 * salience. Read-only prototype; the production version adds the salience
 * chart and deep links back into the RBLang source of the firing rule.
 */
import * as vscode from "vscode";
import { EvidenceNode, RainbirdClient } from "./api";

type EvidenceTree = EvidenceNode & { children?: EvidenceTree[] };

const SOURCE_COLOURS: Record<string, string> = {
  rule: "#3b5bdb",
  answer: "#e03131",
  injection: "#8ce99a",
  datasource: "#2b8a3e",
  knowledgemap: "#e8590c",
  synthesis: "#74c0fc",
};

export async function showEvidenceTree(
  client: RainbirdClient,
  sessionId: string,
  factId: string,
  evidenceKey?: string
): Promise<void> {
  let tree: EvidenceTree;
  try {
    tree = await client.fullEvidence(factId, sessionId, evidenceKey);
  } catch (error) {
    const message = (error as Error).message;
    if (message.includes("401") || message.includes("403")) {
      const action = await vscode.window.showErrorMessage(
        "Evidence is locked for this map. Enable the Evidence Tree Link in Studio (Publish → API Management → Access Control) or provide an x-evidence-key.",
        "Set evidence key…"
      );
      if (action) await vscode.commands.executeCommand("rainbird.setEvidenceKey");
      return;
    }
    vscode.window.showErrorMessage(`Could not fetch evidence: ${message}`);
    return;
  }

  const panel = vscode.window.createWebviewPanel(
    "rainbirdEvidence",
    `Evidence: ${factId}`,
    vscode.ViewColumn.Beside,
    { enableScripts: false }
  );
  panel.webview.html = render(tree);
}

function render(tree: EvidenceTree): string {
  return /* html */ `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';">
<style>
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); padding: 1rem; }
  details { margin-left: 1.25rem; border-left: 2px solid var(--vscode-panel-border); padding-left: .75rem; }
  summary { cursor: pointer; margin: .35rem 0; list-style: none; }
  summary::before { content: "▸ "; }
  details[open] > summary::before { content: "▾ "; }
  .fact { font-weight: 600; }
  .badge { display: inline-block; border-radius: 3px; padding: 0 .45em; font-size: .8em; color: #fff; margin-right: .5em; }
  .certainty { opacity: .75; font-size: .85em; margin-left: .5em; }
  .condition { opacity: .85; font-size: .9em; margin: .15rem 0 .15rem 1.25rem; }
  .impact { opacity: .6; }
  .legend { margin-bottom: 1rem; font-size: .85em; }
</style>
</head>
<body>
<div class="legend">
  ${Object.entries(SOURCE_COLOURS)
    .map(([source, colour]) => `<span class="badge" style="background:${colour}">${source}</span>`)
    .join(" ")}
</div>
${renderNode(tree)}
</body>
</html>`;
}

function renderNode(node: EvidenceTree): string {
  const colour = SOURCE_COLOURS[node.source] ?? "#868e96";
  const fact = node.fact
    ? `${escapeHtml(node.fact.subject?.value)} <em>${escapeHtml(node.fact.relationship?.type)}</em> ${escapeHtml(node.fact.object?.value)}`
    : escapeHtml(node.factID);
  const certainty = node.fact ? `<span class="certainty">${node.fact.certainty}%</span>` : "";

  const conditions = (node.rule?.conditions ?? [])
    .filter((c) => !c.factID) // expression conditions and unexpanded leaves
    .map((c) => {
      const text = c.expression?.text
        ? `expr: ${escapeHtml(c.expression.text)} → ${escapeHtml(String(c.expression.value ?? ""))}`
        : `${escapeHtml(c.subject)} ${escapeHtml(c.relationship)} ${escapeHtml(c.object)}`;
      const met = c.wasMet === false ? " (not met)" : "";
      return `<div class="condition">• ${text}${met} <span class="impact">impact ${c.impact ?? "–"} / salience ${c.salience ?? "–"}</span></div>`;
    })
    .join("");

  const children = (node.children ?? []).map(renderNode).join("");
  const body = conditions + children;

  if (!body) {
    return `<div><span class="badge" style="background:${colour}">${node.source}</span><span class="fact">${fact}</span>${certainty}</div>`;
  }
  return `<details open>
  <summary><span class="badge" style="background:${colour}">${node.source}</span><span class="fact">${fact}</span>${certainty}</summary>
  ${body}
</details>`;
}

function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
