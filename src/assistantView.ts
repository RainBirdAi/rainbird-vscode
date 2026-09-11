/**
 * Rainbird AI assistant: a sidebar chat that generates, explains and fixes
 * RBLang using Claude. Generated code is linted with the extension's own
 * diagnostics engine before it is offered, and can be inserted into the
 * editor in one click — describe-logic-in, validated-RBLang-out.
 */
import * as vscode from "vscode";
import type Anthropic from "@anthropic-ai/sdk";
import { getAnthropicClient, setAnthropicKey, streamAgent, getModel } from "./anthropic";
import { buildTools } from "./assistantTools";
import { collectIssues, LintIssue } from "./diagnostics";

const MAX_FILE_CONTEXT = 30_000;

export class AssistantViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewId = "rainbird.assistant";

  private view?: vscode.WebviewView;
  private history: Anthropic.Beta.BetaMessageParam[] = [];
  private abort?: AbortController;

  constructor(private readonly context: vscode.ExtensionContext) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true };
    view.webview.html = this.render();

    view.webview.onDidReceiveMessage(async (msg) => {
      switch (msg.type) {
        case "send":
          await this.handleSend(String(msg.text ?? ""));
          break;
        case "stop":
          this.abort?.abort();
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
          break;
      }
    });
  }

  newChat(): void {
    this.abort?.abort();
    this.history = [];
    this.view?.webview.postMessage({ type: "reset" });
  }

  /** Entry point for commands (e.g. "Explain selection") that pre-fill a prompt. */
  ask(prompt: string): void {
    this.view?.show?.(true);
    void this.handleSend(prompt);
  }

  private async handleSend(text: string): Promise<void> {
    const view = this.view;
    if (!view || !text.trim()) return;

    const client = await getAnthropicClient(this.context);
    if (!client) {
      view.webview.postMessage({ type: "error", message: "No Anthropic API key set. Click ⚙ to add one." });
      return;
    }

    const { content, contextNote } = withEditorContext(text);
    const checkpoint = this.history.length;
    this.history.push({ role: "user", content });
    view.webview.postMessage({ type: "user", text, contextNote });
    view.webview.postMessage({ type: "start", model: getModel() });

    this.abort = new AbortController();
    try {
      const full = await streamAgent(
        client,
        this.history,
        buildTools(this.context),
        {
          onText: (delta) => view.webview.postMessage({ type: "delta", text: delta }),
          onTool: (name, detail) => view.webview.postMessage({ type: "tool", text: `${name}(${detail})` }),
        },
        this.abort.signal
      );
      view.webview.postMessage({ type: "done", text: full, lints: lintCodeBlocks(full) });
    } catch (error) {
      // Keep history consistent: the turn failed, so roll back to before it.
      this.history.length = checkpoint;
      const message = (error as Error).name === "AbortError" ? "Stopped." : (error as Error).message;
      view.webview.postMessage({ type: "error", message });
    }
  }

  private render(): string {
    const nonce = String(Math.random()).slice(2);
    return /* html */ `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
  * { box-sizing: border-box; }
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); padding: 0; margin: 0;
         display: flex; flex-direction: column; height: 100vh; }
  #log { flex: 1; overflow-y: auto; padding: .6rem .6rem 0; }
  .msg { margin-bottom: .75rem; line-height: 1.45; }
  .msg.user { background: var(--vscode-input-background); border: 1px solid var(--vscode-panel-border);
              border-radius: 8px; padding: .45rem .6rem; white-space: pre-wrap; }
  .ctx { opacity: .6; font-size: .8em; margin-top: .25rem; }
  .msg.assistant { padding: 0 .1rem; }
  .msg.assistant p { margin: .3rem 0; white-space: pre-wrap; }
  .msg.error { color: var(--vscode-errorForeground); font-size: .9em; }
  .thinking { opacity: .6; font-style: italic; }
  pre { background: var(--vscode-textCodeBlock-background); border: 1px solid var(--vscode-panel-border);
        border-radius: 6px; padding: .5rem; overflow-x: auto; font-family: var(--vscode-editor-font-family);
        font-size: .9em; margin: .35rem 0 0; }
  .codewrap { margin: .4rem 0; }
  .codebar { display: flex; gap: .35rem; align-items: center; margin-top: .3rem; flex-wrap: wrap; }
  button { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground);
           border: none; border-radius: 4px; padding: .2rem .55rem; cursor: pointer; font-size: .82em; }
  button:hover { background: var(--vscode-button-secondaryHoverBackground); }
  button.primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
  button.primary:hover { background: var(--vscode-button-hoverBackground); }
  .lint { font-size: .82em; margin-top: .3rem; }
  .lint.bad { color: var(--vscode-errorForeground); }
  .lint.ok { color: var(--vscode-testing-iconPassed, #73c991); }
  .lint ul { margin: .2rem 0 0 1.1rem; padding: 0; }
  .tool { font-size: .8em; opacity: .65; font-family: var(--vscode-editor-font-family); margin: .25rem 0; }
  #composer { border-top: 1px solid var(--vscode-panel-border); padding: .5rem .6rem .6rem; }
  #chips { display: flex; gap: .3rem; flex-wrap: wrap; margin-bottom: .45rem; }
  .chip { font-size: .78em; border-radius: 10px; padding: .15rem .55rem; }
  #inputrow { display: flex; gap: .4rem; align-items: flex-end; }
  textarea { flex: 1; resize: none; background: var(--vscode-input-background); color: var(--vscode-input-foreground);
             border: 1px solid var(--vscode-input-border, transparent); border-radius: 6px; padding: .4rem .5rem;
             font-family: inherit; font-size: .9em; min-height: 2.2rem; max-height: 9rem; }
  textarea:focus { outline: 1px solid var(--vscode-focusBorder); }
  #status { font-size: .75em; opacity: .55; margin-top: .3rem; }
  #empty { opacity: .65; font-size: .88em; padding: 1rem .4rem; line-height: 1.5; }
</style>
</head>
<body>
<div id="log">
  <div id="empty">Describe the decision logic you want and get a valid knowledge map back — generated against the same schema the linter enforces.<br><br>Try: <em>“Build a map that decides whether an employee may work remotely from another country, based on role, tenure and data-sensitivity.”</em></div>
</div>
<div id="composer">
  <div id="chips">
    <button class="chip" data-fill="Explain what this map does and which rules fire when.">Explain map</button>
    <button class="chip" data-fill="Find and fix every problem in this map. Return the corrected RBLang.">Fix problems</button>
    <button class="chip" data-fill="Add a rule to this map that ">Add a rule…</button>
  </div>
  <div id="inputrow">
    <textarea id="input" rows="2" placeholder="Describe logic, ask for an explanation, or paste requirements…"></textarea>
    <button class="primary" id="send">Send</button>
  </div>
  <div id="status"></div>
</div>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const log = document.getElementById('log');
  const input = document.getElementById('input');
  const sendBtn = document.getElementById('send');
  const status = document.getElementById('status');
  let streamEl = null, streamText = '', busy = false, toolLines = [];

  function toolHtml() {
    return toolLines.map(t => '<div class="tool">⚙ ' + esc(t) + '</div>').join('');
  }

  function esc(s) { return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
  function scroll() { log.scrollTop = log.scrollHeight; }
  function empty() { const e = document.getElementById('empty'); if (e) e.remove(); }

  function renderMarkdown(text, lints) {
    const parts = text.split(/\`\`\`(?:rblang|xml)?\\n?/);
    let html = '', code = 0;
    for (let i = 0; i < parts.length; i++) {
      if (i % 2 === 0) {
        const t = parts[i].trim();
        if (t) html += '<p>' + esc(t) + '</p>';
      } else {
        const c = parts[i].replace(/\\n$/, '');
        const issues = (lints && lints[code]) || [];
        const errs = issues.filter(x => x.severity === 'error');
        let lintHtml;
        if (!issues.length) lintHtml = '<div class="lint ok">✓ passes the RBLang linter</div>';
        else lintHtml = '<div class="lint bad">⚠ ' + issues.length + ' lint issue' + (issues.length>1?'s':'')
          + '<ul>' + issues.map(x => '<li>line ' + (x.line+1) + ': ' + esc(x.message) + '</li>').join('') + '</ul></div>';
        html += '<div class="codewrap"><pre>' + esc(c) + '</pre>'
          + '<div class="codebar">'
          + '<button class="primary" data-act="insert" data-code="' + encodeURIComponent(c) + '">Insert</button>'
          + '<button data-act="replaceFile" data-code="' + encodeURIComponent(c) + '">Replace file</button>'
          + '<button data-act="copy" data-code="' + encodeURIComponent(c) + '">Copy</button>'
          + (errs.length ? '<button data-act="fix" data-issues="' + encodeURIComponent(JSON.stringify(errs.map(x => 'line ' + (x.line+1) + ': ' + x.message))) + '">Ask to fix</button>' : '')
          + '</div>' + lintHtml + '</div>';
        code++;
      }
    }
    return html || '<p></p>';
  }

  function setBusy(b) {
    busy = b;
    sendBtn.textContent = b ? 'Stop' : 'Send';
    status.textContent = b ? 'Generating…' : '';
  }

  function send() {
    if (busy) { vscode.postMessage({ type: 'stop' }); return; }
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    vscode.postMessage({ type: 'send', text });
  }

  sendBtn.addEventListener('click', send);
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
  });
  document.getElementById('chips').addEventListener('click', e => {
    const fill = e.target && e.target.dataset && e.target.dataset.fill;
    if (fill) { input.value = fill; input.focus(); }
  });
  log.addEventListener('click', e => {
    const el = e.target;
    if (!el || !el.dataset || !el.dataset.act) return;
    if (el.dataset.act === 'fix') {
      const issues = JSON.parse(decodeURIComponent(el.dataset.issues));
      vscode.postMessage({ type: 'send', text: 'Your last RBLang has lint errors — fix them and return the corrected map:\\n' + issues.join('\\n') });
    } else {
      vscode.postMessage({ type: el.dataset.act, code: decodeURIComponent(el.dataset.code) });
    }
  });

  window.addEventListener('message', e => {
    const m = e.data;
    switch (m.type) {
      case 'user': {
        empty();
        const div = document.createElement('div');
        div.className = 'msg user';
        div.textContent = m.text;
        if (m.contextNote) {
          const c = document.createElement('div');
          c.className = 'ctx';
          c.textContent = m.contextNote;
          div.appendChild(c);
        }
        log.appendChild(div); scroll();
        break;
      }
      case 'start': {
        setBusy(true);
        streamText = ''; toolLines = [];
        streamEl = document.createElement('div');
        streamEl.className = 'msg assistant';
        streamEl.innerHTML = '<p class="thinking">Thinking…</p>';
        log.appendChild(streamEl); scroll();
        break;
      }
      case 'delta': {
        streamText += m.text;
        if (streamEl) { streamEl.innerHTML = toolHtml() + '<p>' + esc(streamText) + '</p>'; scroll(); }
        break;
      }
      case 'tool': {
        toolLines.push(m.text);
        if (streamEl) { streamEl.innerHTML = toolHtml() + '<p>' + esc(streamText) + '</p>'; scroll(); }
        break;
      }
      case 'done': {
        setBusy(false);
        if (streamEl) { streamEl.innerHTML = toolHtml() + renderMarkdown(m.text, m.lints); streamEl = null; scroll(); }
        break;
      }
      case 'error': {
        setBusy(false);
        if (streamEl && !streamText) { streamEl.remove(); }
        streamEl = null;
        const div = document.createElement('div');
        div.className = 'msg error';
        div.textContent = m.message;
        log.appendChild(div); scroll();
        break;
      }
      case 'reset': {
        setBusy(false);
        streamEl = null; streamText = '';
        log.innerHTML = '';
        break;
      }
    }
  });
</script>
</body>
</html>`;
  }
}

/** Attach the active RBLang file (or selection) to the prompt as context. */
function withEditorContext(text: string): { content: string; contextNote?: string } {
  const editor = vscode.window.activeTextEditor ?? vscode.window.visibleTextEditors.find((e) => e.document.languageId === "rblang");
  if (!editor || editor.document.languageId !== "rblang") return { content: text };

  const doc = editor.document;
  const selection = !editor.selection.isEmpty ? doc.getText(editor.selection) : undefined;
  const fileName = doc.uri.path.split("/").pop() ?? "untitled.rbl";
  const body = doc.getText().slice(0, MAX_FILE_CONTEXT);

  let content = `<active-file name="${fileName}">\n${body}\n</active-file>\n`;
  if (selection) content += `<selection>\n${selection.slice(0, MAX_FILE_CONTEXT)}\n</selection>\n`;
  content += `\n${text}`;
  return {
    content,
    contextNote: selection ? `📎 ${fileName} (selection attached)` : `📎 ${fileName}`,
  };
}

/** Lint every ```rblang block in the assistant's reply, in order. */
function lintCodeBlocks(text: string): LintIssue[][] {
  const lints: LintIssue[][] = [];
  const re = /```(?:rblang|xml)?\n([\s\S]*?)```/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    lints.push(collectIssues(m[1]));
  }
  return lints;
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
