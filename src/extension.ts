/**
 * Rainbird for VSCode — prototype entry point.
 *
 * Wires up: RBLang diagnostics + completions + hovers + inlay hints + formatting, the
 * interactive query panel and graph view webviews, the Claude-powered
 * authoring assistant, push-to-platform (with quick-diff against the pushed
 * snapshot), the promotion diff, the map explorer sidebar, .rbird extraction,
 * MCP served-graph registration, guided authoring (＋ concept / relationship /
 * instance / fact / rule / condition), and a connection status bar item.
 */
import * as vscode from "vscode";
import { registerDiagnostics } from "./diagnostics";
import { registerPlatformDiagnostics } from "./platformDiagnostics";
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
import { registerEditorFeatures, registerInlayHints } from "./editorFeatures";
import { registerTests, RAINBIRD_FILES_GLOB } from "./tests";
import { NlPanel } from "./nlPanel";
import { semanticDiff } from "./semanticDiff";
import { promotionDiff } from "./promotionDiff";
import { registerQuickDiff } from "./quickDiff";
import { registerCompareSource } from "./compareSource";
import { registerPlatformSource } from "./platform";
import { bindKmId, openMapByKmId } from "./platform";
import { registerAuthoring } from "./authoring";
import { registerLanguageDetection } from "./languageDetection";
import { registerFormatting } from "./formatting";
import { registerEditApplierProviders } from "./editApplier";
import { buildIndex } from "./mapIndex";
import { relationshipAt } from "./authoringModel";

export function activate(context: vscode.ExtensionContext): void {
  registerLanguageDetection(context);
  registerDiagnostics(context);
  registerPlatformDiagnostics(context);
  registerCompletions(context);

  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 90);
  status.name = "Rainbird";
  status.command = "rainbird.connect";
  // The extension also starts with VS Code (onStartupFinished) so that RBLang pasted into
  // any window is recognised. Show the environment only where Rainbird is in use: the
  // folder holds maps or saved tests, or an RBLang document is open.
  let rainbirdFolder = false;
  const updateStatus = () => {
    const apiUrl = vscode.workspace.getConfiguration("rainbird").get<string>("apiUrl") ?? "";
    const env = apiUrl.includes("enterprise") ? "Enterprise" : apiUrl.includes("api.rainbird.ai") ? "Community" : "Custom";
    status.text = `$(circuit-board) Rainbird: ${env}`;
    status.tooltip = `Rainbird environment: ${apiUrl}\nClick to change environment / API key`;
    const inUse = rainbirdFolder || vscode.workspace.textDocuments.some((d) => d.languageId === "rblang");
    if (inUse) status.show();
    else status.hide();
  };
  updateStatus();
  void vscode.workspace.findFiles(RAINBIRD_FILES_GLOB, "**/node_modules/**", 1).then(
    (found) => {
      rainbirdFolder = found.length > 0;
      updateStatus();
    },
    () => undefined
  );

  registerLanguageFeatures(context);
  registerEditorFeatures(context);
  registerFormatting(context);
  registerTests(context);
  registerInlayHints(context);
  registerQuickDiff(context);
  registerPlatformSource(context);
  registerCompareSource(context);
  registerAuthoring(context);
  registerEditApplierProviders(context);

  const assistant = new AssistantViewProvider(context);
  const mapTree = new MapTreeProvider(context);
  const platformMaps = new PlatformMapsProvider(context);

  context.subscriptions.push(
    status,
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("rainbird")) updateStatus();
    }),
    vscode.workspace.onDidOpenTextDocument(() => updateStatus()),
    vscode.workspace.onDidCloseTextDocument(() => updateStatus()),

    vscode.window.registerWebviewViewProvider(AssistantViewProvider.viewId, assistant, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.window.registerTreeDataProvider(MapTreeProvider.viewId, mapTree),
    vscode.window.registerTreeDataProvider(PlatformMapsProvider.viewId, platformMaps),

    vscode.commands.registerCommand("rainbird.connect", () => connect(context)),
    vscode.commands.registerCommand("rainbird.setEvidenceKey", () => setEvidenceKey(context)),
    vscode.commands.registerCommand("rainbird.runQuery", () => runQuery(context)),
    // ▶ in an RBLang editor's title bar passes that editor's Uri: query its map,
    // with the relationship under its cursor preselected.
    vscode.commands.registerCommand("rainbird.openQueryPanel", (arg?: unknown) => {
      const uri = arg instanceof vscode.Uri ? arg : undefined;
      return QueryPanel.open(context, undefined, goalAtCursor(uri), uri);
    }),
    vscode.commands.registerCommand("rainbird.openQueryPanelWithGoal", (goal?: string) =>
      QueryPanel.open(context, undefined, goal)
    ),
    vscode.commands.registerCommand("rainbird.openQueryPanelWithKm", (kmId?: string) =>
      QueryPanel.open(context, kmId)
    ),
    vscode.commands.registerCommand("rainbird.openGraphView", () => GraphView.open(context)),
    vscode.commands.registerCommand("rainbird.openNlPanel", () => NlPanel.open(context)),
    vscode.commands.registerCommand("rainbird.semanticDiff", () => semanticDiff()),
    vscode.commands.registerCommand("rainbird.promotionDiff", () => promotionDiff(context, QueryPanel.lastRecord())),
    vscode.commands.registerCommand("rainbird.pushMap", () => pushMap(context)),
    vscode.commands.registerCommand("rainbird.setAnthropicKey", () => setAnthropicKey(context)),
    vscode.commands.registerCommand("rainbird.assistantNewChat", () => assistant.newChat()),
    vscode.commands.registerCommand("rainbird.explainSelection", () =>
      assistant.ask("Explain the selected RBLang: what it means for the map's reasoning, which rules fire when, what the engine will ask, and how certainty flows.")
    ),
    vscode.commands.registerCommand("rainbird.mapsRefresh", () => platformMaps.refresh()),
    vscode.commands.registerCommand("rainbird.mapsAdd", () => platformMaps.addManual()),
    vscode.commands.registerCommand("rainbird.mapsCopyKmId", (node) => platformMaps.copyKmId(node)),
    vscode.commands.registerCommand("rainbird.mapsRemove", (node) => platformMaps.remove(node)),
    vscode.commands.registerCommand("rainbird.mapsOpenFile", (node) => platformMaps.openFile(node)),
    vscode.commands.registerCommand("rainbird.mapsOpen", (node) => platformMaps.openRblang(node)),
    vscode.commands.registerCommand("rainbird.mapsQuery", (node) => platformMaps.query(node)),
    vscode.commands.registerCommand("rainbird.mapsReload", (node) => platformMaps.reload(node)),
    vscode.commands.registerCommand("rainbird.openMapByKmId", (kmId?: unknown) =>
      openMapByKmId(context, typeof kmId === "string" ? kmId : undefined)
    ),
    // From the editor context menu, or with the extracted file's Uri after Extract RBLang.
    vscode.commands.registerCommand("rainbird.bindKmId", (uri?: unknown) =>
      bindKmId(context, uri instanceof vscode.Uri ? uri : undefined)
    ),
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
      await showEvidenceTree(client, sessionId, factId, () => getEvidenceKey(context));
    }),

    vscode.commands.registerCommand("rainbird.getStarted", () =>
      vscode.commands.executeCommand("workbench.action.openWalkthrough", `${context.extension.id}#rainbird.gettingStarted`, false)
    ),
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

/**
 * The relationship under the cursor, preselected in the query panel (G-2): in
 * the editor whose title-bar ▶ was pressed (its Uri is the command argument;
 * the active editor first when it shows that file), else in the active RBLang
 * editor. Read before the panel takes focus.
 */
function goalAtCursor(uri: vscode.Uri | undefined): string | undefined {
  const active = vscode.window.activeTextEditor;
  const editor = uri
    ? [active, ...vscode.window.visibleTextEditors].find((e) => e?.document.uri.toString() === uri.toString())
    : active;
  if (!editor || editor.document.languageId !== "rblang") return undefined;
  const doc = editor.document;
  return relationshipAt(buildIndex(doc.getText()), doc.offsetAt(editor.selection.active));
}
