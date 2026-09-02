/**
 * Rainbird for VSCode — prototype entry point.
 *
 * Wires up: RBLang diagnostics + completions + hovers, the interactive query
 * panel and graph view webviews, the Claude-powered authoring assistant,
 * push-to-platform, the map explorer sidebar, .rbird extraction, MCP
 * served-graph registration, and a connection status bar item.
 */
import * as vscode from "vscode";
import { registerDiagnostics } from "./diagnostics";
import { registerCompletions } from "./completions";
import { connect, runQuery, getClient, getEvidenceKey, setEvidenceKey } from "./queryRunner";
import { extractRbird } from "./rbird";
import { addMcpServer } from "./mcp";
import { showEvidenceTree } from "./evidenceView";
import { QueryPanel } from "./queryPanel";
import { GraphView } from "./graphView";
import { AssistantViewProvider } from "./assistantView";
import { MapTreeProvider, revealOffset } from "./mapTree";
import { PlatformMapsProvider } from "./mapsTree";
import { pushMap } from "./push";
import { setAnthropicKey } from "./anthropic";
import { registerLanguageFeatures } from "./languageFeatures";
import { registerEditorFeatures } from "./editorFeatures";
import { registerTests } from "./tests";
import { NlPanel } from "./nlPanel";
import { semanticDiff } from "./semanticDiff";

export function activate(context: vscode.ExtensionContext): void {
  registerDiagnostics(context);
  registerCompletions(context);

  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 90);
  status.name = "Rainbird";
  status.command = "rainbird.connect";
  const updateStatus = () => {
    const apiUrl = vscode.workspace.getConfiguration("rainbird").get<string>("apiUrl") ?? "";
    const env = apiUrl.includes("enterprise") ? "Enterprise" : apiUrl.includes("api.rainbird.ai") ? "Community" : "Custom";
    status.text = `$(circuit-board) Rainbird: ${env}`;
    status.tooltip = `Rainbird environment: ${apiUrl}\nClick to change environment / API key`;
    status.show();
  };
  updateStatus();

  registerLanguageFeatures(context);
  registerEditorFeatures(context);
  registerTests(context);

  const assistant = new AssistantViewProvider(context);
  const mapTree = new MapTreeProvider(context);
  const platformMaps = new PlatformMapsProvider(context);

  context.subscriptions.push(
    status,
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("rainbird")) updateStatus();
    }),

    vscode.window.registerWebviewViewProvider(AssistantViewProvider.viewId, assistant, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.window.registerTreeDataProvider(MapTreeProvider.viewId, mapTree),
    vscode.window.registerTreeDataProvider(PlatformMapsProvider.viewId, platformMaps),

    vscode.commands.registerCommand("rainbird.connect", () => connect(context)),
    vscode.commands.registerCommand("rainbird.setEvidenceKey", () => setEvidenceKey(context)),
    vscode.commands.registerCommand("rainbird.runQuery", () => runQuery(context)),
    vscode.commands.registerCommand("rainbird.openQueryPanel", () => QueryPanel.open(context)),
    vscode.commands.registerCommand("rainbird.openQueryPanelWithGoal", (goal?: string) =>
      QueryPanel.open(context, undefined, goal)
    ),
    vscode.commands.registerCommand("rainbird.openQueryPanelWithKm", (kmId?: string) =>
      QueryPanel.open(context, kmId)
    ),
    vscode.commands.registerCommand("rainbird.openGraphView", () => GraphView.open(context)),
    vscode.commands.registerCommand("rainbird.openNlPanel", () => NlPanel.open(context)),
    vscode.commands.registerCommand("rainbird.semanticDiff", () => semanticDiff()),
    vscode.commands.registerCommand("rainbird.pushMap", () => pushMap(context)),
    vscode.commands.registerCommand("rainbird.setAnthropicKey", () => setAnthropicKey(context)),
    vscode.commands.registerCommand("rainbird.assistantNewChat", () => assistant.newChat()),
    vscode.commands.registerCommand("rainbird.explainSelection", () =>
      assistant.ask("Explain what the selected RBLang does, including which rules fire when and how certainty flows.")
    ),
    vscode.commands.registerCommand("rainbird.mapsRefresh", () => platformMaps.refresh()),
    vscode.commands.registerCommand("rainbird.mapsAdd", () => platformMaps.addManual()),
    vscode.commands.registerCommand("rainbird.mapsCopyKmId", (node) => platformMaps.copyKmId(node)),
    vscode.commands.registerCommand("rainbird.mapsRemove", (node) => platformMaps.remove(node)),
    vscode.commands.registerCommand("rainbird.mapsOpenFile", (node) => platformMaps.openFile(node)),
    vscode.commands.registerCommand("rainbird.mapsOpen", (node) => platformMaps.openRblang(node)),
    vscode.commands.registerCommand("rainbird.mapsQuery", (node) => platformMaps.query(node)),
    vscode.commands.registerCommand("rainbird.revealOffset", (uri?: vscode.Uri, offset?: number) =>
      revealOffset(uri, offset)
    ),
    vscode.commands.registerCommand("rainbird.extractRbird", (uri?: vscode.Uri) => extractRbird(uri)),
    vscode.commands.registerCommand("rainbird.addMcpServer", () => addMcpServer()),

    vscode.commands.registerCommand("rainbird.showEvidence", async () => {
      const client = await getClient(context);
      if (!client) return;
      const sessionId = await vscode.window.showInputBox({ prompt: "Session ID" });
      if (!sessionId) return;
      const factId = await vscode.window.showInputBox({ prompt: "Fact ID (e.g. WA:RF:…)" });
      if (!factId) return;
      await showEvidenceTree(client, sessionId, factId, await getEvidenceKey(context));
    }),

    vscode.commands.registerCommand("rainbird.openExample", async () => {
      const example = vscode.Uri.joinPath(context.extensionUri, "examples", "hello-world.rbl");
      const doc = await vscode.workspace.openTextDocument(example);
      await vscode.window.showTextDocument(doc);
    })
  );
}

export function deactivate(): void {
  // Nothing to clean up — all disposables are on the extension context.
}
