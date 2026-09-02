/**
 * Register a Rainbird served-graph MCP endpoint with VSCode.
 *
 * Rainbird's MCP research preview serves each published graph as a
 * Streamable-HTTP MCP endpoint (describe_graph / inject / query / answer /
 * explain tools). The endpoint URL is self-authenticating — treat it as a
 * secret. This command writes the server into the workspace's .vscode/mcp.json
 * so Copilot agent mode (and any MCP-aware assistant) can query the graph.
 *
 * Roadmap version: a platform "list served graphs" API + an
 * McpServerDefinitionProvider would replace this manual paste entirely.
 */
import * as vscode from "vscode";

const MCP_URL_PATTERN = /^https:\/\/[\w.-]+\/mcp\/graph\/[a-f0-9]+$/i;

export async function addMcpServer(): Promise<void> {
  const url = await vscode.window.showInputBox({
    prompt: "Served graph MCP endpoint URL (from the graph's 'Test over MCP' page)",
    placeHolder: "https://rake.rainbird.ai/mcp/graph/…",
    password: true, // the URL grants access — do not echo it on screen
    ignoreFocusOut: true,
    validateInput: (value) =>
      MCP_URL_PATTERN.test(value.trim()) ? undefined : "Expected an https://…/mcp/graph/<id> URL",
  });
  if (!url) return;

  const name = await vscode.window.showInputBox({
    prompt: "Name for this graph (used as the MCP server id)",
    value: "rainbird-graph",
    validateInput: (v) => (/^[\w-]+$/.test(v) ? undefined : "Letters, digits, - and _ only"),
  });
  if (!name) return;

  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) {
    vscode.window.showErrorMessage("Open a workspace folder first — the MCP server is written to .vscode/mcp.json.");
    return;
  }

  const mcpUri = vscode.Uri.joinPath(folder.uri, ".vscode", "mcp.json");
  let config: { servers?: Record<string, unknown> } = {};
  try {
    config = JSON.parse(Buffer.from(await vscode.workspace.fs.readFile(mcpUri)).toString("utf8"));
  } catch {
    // No existing mcp.json — start fresh.
  }
  config.servers = { ...config.servers, [name]: { type: "http", url: url.trim() } };
  await vscode.workspace.fs.writeFile(mcpUri, Buffer.from(JSON.stringify(config, null, 2), "utf8"));

  const warning =
    "The endpoint URL is self-authenticating: anyone with the URL can query the graph. " +
    "Consider .gitignore-ing .vscode/mcp.json, and pause the served graph from your dashboard to revoke access.";
  vscode.window.showInformationMessage(`MCP server "${name}" added to .vscode/mcp.json. ${warning}`);
}
