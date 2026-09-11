/**
 * Natural-language querying via Rainbird's own beta POST /nl/interact —
 * no external LLM key needed, data stays on Rainbird's path (Anthropic via
 * AWS Bedrock, EU-processed). Documented contract: start a normal session,
 * then {sessionID, userPrompt} per turn; responses carry responseType
 * question|result|error (or "" on validation failures), questions[],
 * results[], and facts{injected, invalid, unmatched} — all camelCase (live-
 * verified; the docs' Pascal-case claim was not observed). Unmatched facts
 * double as a vocabulary-gap signal for the map. A raw-JSON expander stays
 * on every reply as the beta contract may drift.
 */
import * as vscode from "vscode";
import { RainbirdClient } from "./api";
import { getClient } from "./queryRunner";

export class NlPanel {
  private static current?: NlPanel;

  private client?: RainbirdClient;
  private kmId?: string;
  private sessionId?: string;

  static async open(context: vscode.ExtensionContext): Promise<void> {
    if (NlPanel.current) {
      NlPanel.current.panel.reveal();
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      "rainbirdNl",
      "Rainbird NL (beta)",
      vscode.ViewColumn.Beside,
      { enableScripts: true, retainContextWhenHidden: true }
    );
    NlPanel.current = new NlPanel(context, panel);
    await NlPanel.current.init();
  }

  private constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly panel: vscode.WebviewPanel
  ) {
    panel.webview.html = render();
    panel.onDidDispose(() => {
      NlPanel.current = undefined;
    });
    panel.webview.onDidReceiveMessage(async (msg) => {
      if (msg.type === "send") await this.send(String(msg.text ?? ""));
      if (msg.type === "reset") {
        this.sessionId = undefined;
        this.post({ type: "reset" });
      }
    });
  }

  private post(message: unknown): void {
    void this.panel.webview.postMessage(message);
  }

  private async init(): Promise<void> {
    this.client = await getClient(this.context);
    if (!this.client) {
      this.post({ type: "error", message: "Not connected — run “Rainbird: Connect” first." });
      return;
    }
    const config = vscode.workspace.getConfiguration("rainbird");
    this.kmId = config.get<string>("knowledgeMapId");
    if (!this.kmId) {
      this.kmId = await vscode.window.showInputBox({ prompt: "Knowledge Map ID for NL interaction" });
      if (!this.kmId) return;
    }
    this.post({ type: "init", kmId: this.kmId });
  }

  /** One NL session per conversation; ↺ starts a fresh one. */
  private async ensureSession(): Promise<string | undefined> {
    if (this.sessionId) return this.sessionId;
    if (!this.client || !this.kmId) return undefined;
    const useDraft = vscode.workspace.getConfiguration("rainbird").get<boolean>("useDraft") ?? true;
    this.sessionId = await this.client.start(this.kmId, { useDraft });
    return this.sessionId;
  }

  private async send(text: string): Promise<void> {
    if (!this.client || !this.kmId || !text.trim()) return;
    this.post({ type: "user", text });
    this.post({ type: "busy" });
    try {
      const sessionId = await this.ensureSession();
      if (!sessionId) throw new Error("Could not start a session.");
      const raw = await this.client.nlInteract(sessionId, text);

      const responseType = typeof raw.responseType === "string" && raw.responseType ? raw.responseType : "error";
      const err = raw.error as Record<string, unknown> | undefined;
      let headline: string | undefined;
      if (responseType === "question") {
        const questions = (raw.questions as Record<string, unknown>[]) ?? [];
        headline = questions
          .map((q) => String(q?.prompt ?? ""))
          .filter(Boolean)
          .join("\n");
      } else if (responseType === "result") {
        const results = (raw.results as Record<string, unknown>[]) ?? [];
        headline = results
          .map(
            (r) =>
              `${r.subject} ${r.relationship ?? r.relationshipType} ${r.object}${r.certainty !== undefined ? ` (${r.certainty}%)` : ""}`
          )
          .join("\n");
      }
      // Validation failures come back with responseType "" — render the
      // chat-friendly message whenever an error object is present.
      if (!headline && err) {
        headline = String(err.suggestedChatResponse ?? err.message ?? "The NL engine returned an error.");
      }

      // A dead/expired session (404, code 28) can never recover — drop it so
      // the next message starts fresh.
      if (err && (err.code === 28 || err.statusCode === 404)) {
        this.sessionId = undefined;
        headline = `${headline ?? ""}\n(The session had expired — send your message again to start a fresh one.)`.trim();
      }

      // Fact-extraction report: what the LLM injected, and — the useful lint
      // signal — what it could not match to the map's vocabulary.
      const facts = raw.facts as Record<string, unknown[]> | undefined;
      let factNote: string | undefined;
      if (facts) {
        const parts: string[] = [];
        if (facts.injected?.length) parts.push(`${facts.injected.length} fact${facts.injected.length > 1 ? "s" : ""} extracted`);
        if (facts.unmatched?.length) parts.push(`${facts.unmatched.length} unmatched (vocabulary gap?)`);
        if (facts.invalid?.length) parts.push(`${facts.invalid.length} invalid`);
        factNote = parts.join(" · ") || undefined;
      }

      this.post({ type: "reply", responseType, headline, factNote, raw });
    } catch (error) {
      this.post({ type: "error", message: (error as Error).message });
    }
  }
}

export function render(): string {
  const nonce = String(Math.random()).slice(2);
  return /* html */ `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
  * { box-sizing: border-box; }
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); margin: 0;
         display: flex; flex-direction: column; height: 100vh; }
  #head { display: flex; justify-content: space-between; align-items: center; padding: .6rem .8rem;
          border-bottom: 1px solid var(--vscode-panel-border); }
  #head b { font-size: .95em; }
  .badge { font-size: .75em; opacity: .65; }
  #log { flex: 1; overflow-y: auto; padding: .7rem .8rem; }
  .msg { margin-bottom: .7rem; line-height: 1.45; max-width: 90%; }
  .msg.user { background: var(--vscode-input-background); border: 1px solid var(--vscode-panel-border);
              border-radius: 8px; padding: .4rem .6rem; margin-left: auto; white-space: pre-wrap; }
  .msg.bot { white-space: pre-wrap; }
  .kind { font-size: .72em; text-transform: uppercase; letter-spacing: .05em; opacity: .55; display: block; }
  .msg.err { color: var(--vscode-errorForeground); font-size: .9em; }
  details { font-size: .78em; opacity: .75; margin-top: .3rem; }
  pre { background: var(--vscode-textCodeBlock-background); padding: .4rem; border-radius: 4px; overflow-x: auto; }
  #composer { display: flex; gap: .4rem; padding: .6rem .8rem; border-top: 1px solid var(--vscode-panel-border); }
  input { flex: 1; background: var(--vscode-input-background); color: var(--vscode-input-foreground);
          border: 1px solid var(--vscode-input-border, transparent); border-radius: 6px; padding: .4rem .55rem; }
  button { background: var(--vscode-button-background); color: var(--vscode-button-foreground);
           border: none; border-radius: 5px; padding: .35rem .8rem; cursor: pointer; }
  #reset { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
  .spin { opacity: .6; font-style: italic; }
  #empty { opacity: .6; font-size: .88em; padding: .5rem; line-height: 1.5; }
</style>
</head>
<body>
<div id="head"><b>Natural language (Rainbird /nl/interact · beta)</b><span class="badge" id="km"></span></div>
<div id="log"><div id="empty">Talk to the map in plain language — facts are extracted and the engine reasons over them.<br><br>Try: <em>“Fred lives in France. What languages does he speak?”</em></div></div>
<div id="composer">
  <input id="input" placeholder="Tell the engine facts, then ask a question…">
  <button id="send">Send</button>
  <button id="reset" title="Start a new NL session">↺</button>
</div>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const log = document.getElementById('log');
  const input = document.getElementById('input');
  let busyEl = null;

  function esc(s) { return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
  function el(html) { const d = document.createElement('div'); d.innerHTML = html; return d.firstElementChild; }
  function scroll() { log.scrollTop = log.scrollHeight; }
  function clearBusy() { if (busyEl) { busyEl.remove(); busyEl = null; } }
  function empty() { const e = document.getElementById('empty'); if (e) e.remove(); }

  function send() {
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    vscode.postMessage({ type: 'send', text });
  }
  document.getElementById('send').addEventListener('click', send);
  document.getElementById('reset').addEventListener('click', () => vscode.postMessage({ type: 'reset' }));
  input.addEventListener('keydown', e => { if (e.key === 'Enter') send(); });

  window.addEventListener('message', e => {
    const m = e.data;
    switch (m.type) {
      case 'init':
        document.getElementById('km').textContent = m.kmId;
        break;
      case 'user':
        empty();
        log.appendChild(el('<div class="msg user">' + esc(m.text) + '</div>')); scroll();
        break;
      case 'busy':
        clearBusy();
        busyEl = el('<div class="msg bot spin">Thinking…</div>');
        log.appendChild(busyEl); scroll();
        break;
      case 'reply': {
        clearBusy();
        const raw = '<details><summary>raw response</summary><pre>' + esc(JSON.stringify(m.raw, null, 2)) + '</pre></details>';
        const facts = m.factNote ? '<span class="kind">' + esc(m.factNote) + '</span>' : '';
        log.appendChild(el('<div class="msg bot"><span class="kind">' + esc(m.responseType) + '</span>'
          + (m.headline ? esc(m.headline) : '(no recognised fields — see raw response)') + facts + raw + '</div>'));
        scroll();
        break;
      }
      case 'error':
        clearBusy();
        log.appendChild(el('<div class="msg err">' + esc(m.message) + '</div>')); scroll();
        break;
      case 'reset':
        log.innerHTML = '<div id="empty">New NL session started.</div>';
        break;
    }
  });
</script>
</body>
</html>`;
}
