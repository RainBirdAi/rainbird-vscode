/**
 * The AI Assistant sidebar: a webview view whose script lives in
 * media/assistant/. This provider renders the shell, routes messages between
 * the webview and the AssistantSession, and exposes `ask()` for commands such
 * as "Explain with AI" — which focuses the view and waits for it to be ready
 * before sending, so it works even when the sidebar was never opened.
 */
import * as vscode from "vscode";
import { setAnthropicKey } from "./anthropic";
import { AssistantSession, OutboundMessage } from "./assistantSession";

export class AssistantViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewId = "rainbird.assistant";

  private view?: vscode.WebviewView;
  private session: AssistantSession;
  private ready?: Promise<void>;
  private markReady?: () => void;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.session = new AssistantSession(context);
    this.resetReady();
    context.subscriptions.push(
      vscode.window.onDidChangeActiveTextEditor(() => void this.pushState()),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration("rainbird.ai")) void this.pushState();
      })
    );
  }

  private resetReady(): void {
    this.ready = new Promise<void>((resolve) => (this.markReady = resolve));
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    const media = vscode.Uri.joinPath(this.context.extensionUri, "media", "assistant");
    view.webview.options = { enableScripts: true, localResourceRoots: [media] };
    view.webview.html = this.render(view.webview, media);

    view.webview.onDidReceiveMessage(async (msg) => {
      switch (msg.type) {
        case "ready":
          this.markReady?.();
          await this.pushState();
          break;
        case "send":
          await this.session.runTurn(String(msg.text ?? ""), (m) => this.post(m));
          await this.pushState();
          break;
        case "stop":
          this.session.stop();
          break;
        case "insert":
          await insertIntoEditor(String(msg.code ?? ""), false);
          break;
        case "replaceFile":
          await insertIntoEditor(String(msg.code ?? ""), true);
          break;
        case "copy":
          await vscode.env.clipboard.writeText(String(msg.code ?? ""));
          vscode.window.setStatusBarMessage("RBLang copied to clipboard", 3000);
          break;
        case "setKey":
          await setAnthropicKey(this.context);
          await this.pushState();
          break;
        case "newChat":
          this.newChat();
          break;
        case "showDiff":
          await this.session.showDiff(String(msg.turnId));
          break;
        case "undoTurn": {
          const ok = await this.session.undoTurn(String(msg.turnId));
          this.post({ type: "hint", text: ok ? "Reverted this turn's changes." : "Nothing to undo for that turn." });
          break;
        }
        case "acceptProposal": {
          const ok = await this.session.acceptProposal();
          this.post({ type: "hint", text: ok ? "Applied the proposed changes." : "The proposal was not applied." });
          break;
        }
        case "rejectProposal":
          this.session.rejectProposal();
          this.post({ type: "hint", text: "Discarded the proposal." });
          break;
        case "openSettings":
          await vscode.commands.executeCommand("workbench.action.openSettings", "rainbird.ai");
          break;
      }
    });
    view.onDidDispose(() => {
      this.view = undefined;
      this.resetReady();
    });
  }

  private post(message: OutboundMessage): void {
    void this.view?.webview.postMessage(message);
  }

  private async pushState(): Promise<void> {
    if (!this.view) return;
    this.post(await this.session.state());
  }

  newChat(): void {
    this.session.reset();
    this.post({ type: "reset" });
    void this.pushState();
  }

  /** Entry point for commands (e.g. "Explain with AI") that pre-fill a prompt. Focuses the view first and waits for it. */
  async ask(prompt: string): Promise<void> {
    await vscode.commands.executeCommand(`${AssistantViewProvider.viewId}.focus`);
    await Promise.race([this.ready, new Promise((r) => setTimeout(r, 3000))]);
    await this.session.runTurn(prompt, (m) => this.post(m));
    await this.pushState();
  }

  private render(webview: vscode.Webview, media: vscode.Uri): string {
    const nonce = String(Math.random()).slice(2) + Date.now().toString(36);
    const script = webview.asWebviewUri(vscode.Uri.joinPath(media, "main.js"));
    const style = webview.asWebviewUri(vscode.Uri.joinPath(media, "style.css"));
    return /* html */ `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; font-src ${webview.cspSource};">
<link rel="stylesheet" href="${style}">
</head>
<body>
<div id="log"><div id="empty"></div></div>
<div id="composer">
  <div id="chips"></div>
  <div id="inputrow">
    <textarea id="input" rows="2" placeholder="Ask about this map, or describe the change you want…"></textarea>
    <button class="primary" id="send" title="Send (Enter)">Send</button>
  </div>
  <div id="status"><span id="statusText"></span><span id="usage"></span></div>
</div>
<script nonce="${nonce}" src="${script}"></script>
</body>
</html>`;
  }
}

async function insertIntoEditor(code: string, replaceFile: boolean): Promise<void> {
  let editor = vscode.window.activeTextEditor;
  if (!editor || editor.document.languageId !== "rblang") {
    editor = vscode.window.visibleTextEditors.find((e) => e.document.languageId === "rblang");
  }
  if (!editor) {
    const doc = await vscode.workspace.openTextDocument({ language: "rblang", content: code });
    await vscode.window.showTextDocument(doc);
    return;
  }
  const doc = editor.document;
  await editor.edit((edit) => {
    if (replaceFile) {
      edit.replace(new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length)), code);
    } else if (!editor!.selection.isEmpty) {
      edit.replace(editor!.selection, code);
    } else {
      edit.insert(editor!.selection.active, code);
    }
  });
  await vscode.window.showTextDocument(doc, editor.viewColumn);
}
