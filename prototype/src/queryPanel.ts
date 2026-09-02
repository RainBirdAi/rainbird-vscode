/**
 * Interactive query panel: a webview that drives the engine's Match → Infer →
 * Ask loop as a conversation of question cards — yes/no buttons, option chips,
 * multi-select, certainty sliders — with a running transcript, result cards
 * with certainty bars, and inline evidence trees. The rich replacement for
 * the QuickPick-based `Rainbird: Run Query…`.
 */
import * as vscode from "vscode";
import { Answer, ApiError, EvidenceNode, Question, RainbirdClient, ResultItem } from "./api";
import { getClient, getEvidenceKey } from "./queryRunner";
import { buildIndex } from "./mapIndex";
import { GraphView, EvidenceOverlay } from "./graphView";
import { getAnthropicClient, streamChat } from "./anthropic";
import { saveSessionAsTest, SessionRecord } from "./tests";
import { recordKnownMap } from "./mapsTree";

interface AnswerPayload {
  kind: "yesno" | "value" | "multi" | "unknown";
  answer?: "yes" | "no";
  value?: string;
  values?: string[];
  certainty?: number;
}

type EvidenceTree = EvidenceNode & { children: EvidenceTree[] };

export class QueryPanel {
  private static current?: QueryPanel;

  private client?: RainbirdClient;
  private sessionId?: string;
  private question?: Question;
  private record?: SessionRecord;
  private pendingGoal?: string;
  private readonly trees = new Map<string, EvidenceTree>();

  static async open(context: vscode.ExtensionContext, kmIdOverride?: string, goal?: string): Promise<void> {
    if (QueryPanel.current) {
      QueryPanel.current.pendingGoal = goal;
      QueryPanel.current.panel.reveal();
      await QueryPanel.current.init(kmIdOverride);
      return;
    }
    const panel = vscode.window.createWebviewPanel("rainbirdQuery", "Rainbird Query", vscode.ViewColumn.Beside, {
      enableScripts: true,
      retainContextWhenHidden: true,
    });
    QueryPanel.current = new QueryPanel(context, panel);
    QueryPanel.current.pendingGoal = goal;
    await QueryPanel.current.init(kmIdOverride);
  }

  private constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly panel: vscode.WebviewPanel
  ) {
    panel.webview.html = render();
    panel.onDidDispose(() => {
      QueryPanel.current = undefined;
    });
    panel.webview.onDidReceiveMessage(async (msg) => {
      try {
        switch (msg.type) {
          case "start":
            await this.start(String(msg.relationship ?? ""), msg.subject ? String(msg.subject) : undefined);
            break;
          case "answer":
            await this.answer(msg.payload as AnswerPayload);
            break;
          case "evidence":
            await this.evidence(String(msg.factId ?? ""));
            break;
          case "explain":
            await this.explain(String(msg.factId ?? ""));
            break;
          case "overlay":
            await this.overlay(String(msg.factId ?? ""));
            break;
          case "saveTest":
            if (this.record) await saveSessionAsTest(this.record);
            break;
          case "changeKm":
            await this.init();
            break;
        }
      } catch (error) {
        this.post({ type: "error", message: (error as Error).message });
      }
    });
  }

  private post(message: unknown): void {
    void this.panel.webview.postMessage(message);
  }

  private async init(kmIdOverride?: string): Promise<void> {
    this.client = await getClient(this.context);
    if (!this.client) {
      this.post({ type: "error", message: "Not connected — run “Rainbird: Connect” first." });
      return;
    }

    const editor = vscode.window.visibleTextEditors.find((e) => e.document.languageId === "rblang");
    const config = vscode.workspace.getConfiguration("rainbird", editor?.document.uri);
    let kmId = kmIdOverride || config.get<string>("knowledgeMapId");
    if (!kmId) {
      kmId = await vscode.window.showInputBox({
        prompt: "Knowledge Map ID (from the Publish page in Studio)",
        ignoreFocusOut: true,
      });
      if (!kmId) return;
      await config.update("knowledgeMapId", kmId, vscode.ConfigurationTarget.Workspace);
    }
    if (kmIdOverride) {
      await config.update("knowledgeMapId", kmIdOverride, vscode.ConfigurationTarget.Workspace);
    }

    const goals = editor
      ? [...buildIndex(editor.document.getText()).relationships.entries()].map(([name, rel]) => ({
          name,
          subject: rel.subject,
          object: rel.object,
          plural: rel.plural,
        }))
      : [];

    recordKnownMap(this.context, { kmId, source: "queried" });
    this.post({
      type: "init",
      goals,
      kmId,
      preselect: this.pendingGoal,
      apiUrl: vscode.workspace.getConfiguration("rainbird").get<string>("apiUrl") ?? "",
      useDraft: config.get<boolean>("useDraft") ?? true,
    });
    this.pendingGoal = undefined;
  }

  private async start(relationship: string, subject?: string): Promise<void> {
    if (!this.client || !relationship) return;
    const config = vscode.workspace.getConfiguration("rainbird");
    const kmId = config.get<string>("knowledgeMapId");
    if (!kmId) return;

    this.post({ type: "busy" });
    this.record = { kmId, goal: { relationship, ...(subject ? { subject } : {}) }, answers: [] };
    this.trees.clear();
    const sessionId = await this.client.start(kmId, { useDraft: config.get<boolean>("useDraft") ?? true });
    this.sessionId = sessionId;

    // Show which map this session actually hit — catches "my kmID points at a
    // different map than my open file" before the 400 does.
    void this.client
      .sessionInfo(sessionId)
      .then((info) => {
        if (this.sessionId !== sessionId) return; // a newer query superseded this one
        const nested = (info.kmVersion ?? info.version ?? {}) as Record<string, unknown>;
        const name = [info.name, nested.name, info.kmName].find((v): v is string => typeof v === "string");
        const status = [info.versionStatus, nested.versionStatus].find((v): v is string => typeof v === "string");
        if (name) this.post({ type: "mapInfo", name, status });
      })
      .catch(() => {
        /* metadata is best-effort */
      });

    try {
      const response = await this.client.query(sessionId, {
        relationship,
        ...(subject ? { subject } : {}),
      });
      this.handleResponse(response);
    } catch (error) {
      // Verified live: an unknown OR case-mismatched relationship yields
      // exactly `400 Bad request!`; structural problems return {"err": [...]}.
      if (error instanceof ApiError && error.status === 400) {
        const errMessages = error.errMessages();
        if (errMessages) {
          throw new Error(`The engine rejected the query: ${errMessages.join("; ")}`);
        }
        throw new Error(
          `${error.message}\n\nThe map (${kmId}) has no relationship named exactly "${relationship}" — names are case-sensitive. ` +
            `The goal list comes from your open .rbl file; check the map name in the header above. If it's a different map, ` +
            `push the open file first (cloud icon) or point rainbird.knowledgeMapId at the right map.`
        );
      }
      throw error;
    }
  }

  private async answer(payload: AnswerPayload): Promise<void> {
    if (!this.client || !this.sessionId || !this.question) return;
    const q = this.question;
    const certainty = payload.certainty ?? 100;
    // 'Second Form Subject' asks for the SUBJECT of the triple; every other
    // form asks for (or confirms) the object.
    const askingForSubject = q.type === "Second Form Subject";
    const fill = (value: string | number | boolean): Answer =>
      askingForSubject
        ? { relationship: q.relationship, subject: String(value), object: q.object, certainty }
        : { relationship: q.relationship, subject: q.subject, object: value, certainty };

    let answers: Answer[];
    switch (payload.kind) {
      case "unknown":
        answers = [{ relationship: q.relationship, subject: q.subject, object: q.object, unanswered: true }];
        break;
      case "yesno":
        answers = [{ relationship: q.relationship, subject: q.subject, object: q.object, answer: payload.answer, certainty }];
        break;
      case "multi": {
        const coerce = (v: string) => (q.dataType === "number" ? Number(v) : q.dataType === "truth" ? v === "true" : v);
        answers = (payload.values ?? []).map((v) => fill(coerce(v)));
        break;
      }
      default: {
        const value = payload.value ?? "";
        answers = [fill(q.dataType === "number" ? Number(value) : q.dataType === "truth" ? value === "true" : value)];
      }
    }

    this.post({ type: "busy" });
    try {
      const response = await this.client.respond(this.sessionId, answers);
      this.record?.answers.push(answers);
      this.handleResponse(response);
    } catch (error) {
      // Only a 400 means "the answer was rejected" — re-ask with the engine's
      // own validation messages. Anything else (404 dead session, network) is
      // unrecoverable by retrying, so let the generic error card render.
      if (error instanceof ApiError && error.status === 400) {
        const detail = error.errMessages()?.join("; ") ?? error.body.slice(0, 160);
        this.post({
          type: "question",
          question: q,
          extras: 0,
          note: `That answer was rejected (${detail}). Try a different answer.`,
        });
        return;
      }
      if (error instanceof ApiError && error.status === 404) {
        throw new Error("This session has expired — click “New query” to start again.");
      }
      throw error;
    }
  }

  private handleResponse(response: { kind: "question"; question: Question; extraQuestions?: Question[] } | { kind: "result"; result: unknown[] }): void {
    if (response.kind === "question") {
      this.question = response.question;
      this.post({ type: "question", question: response.question, extras: response.extraQuestions?.length ?? 0 });
    } else {
      this.question = undefined;
      if (this.record) this.record.results = response.result as ResultItem[];
      this.post({ type: "result", results: response.result, sessionId: this.sessionId });
    }
  }

  private async getTree(factId: string): Promise<EvidenceTree> {
    if (!this.client || !this.sessionId) throw new Error("No active session.");
    const cached = this.trees.get(factId);
    if (cached) return cached;
    const evidenceKey = await getEvidenceKey(this.context);
    // fullEvidence populates children recursively; the declared type is one level deep.
    const tree = (await this.client.fullEvidence(factId, this.sessionId, evidenceKey)) as EvidenceTree;
    this.trees.set(factId, tree);
    return tree;
  }

  private async evidence(factId: string): Promise<void> {
    if (!factId) return;
    try {
      this.post({ type: "evidence", factId, tree: await this.getTree(factId) });
    } catch (error) {
      const message = (error as Error).message;
      this.post({
        type: "evidence",
        factId,
        error: /40[13]/.test(message)
          ? "Evidence is locked for this map — enable the Evidence Tree Link in Studio (Publish → API Management), or run “Rainbird: Set Evidence Key” and retry."
          : message,
      });
    }
  }

  /** Stream a plain-English narrative of why the engine decided this, from the evidence tree. */
  private async explain(factId: string): Promise<void> {
    if (!factId) return;
    const client = await getAnthropicClient(this.context);
    if (!client) {
      this.post({ type: "explainDelta", factId, text: "No Anthropic API key set — run “Rainbird: Set Anthropic API Key”." });
      this.post({ type: "explainDone", factId });
      return;
    }
    try {
      const tree = await this.getTree(factId);
      const editor = vscode.window.visibleTextEditors.find((e) => e.document.languageId === "rblang");
      const source = editor ? `\n\nThe map's RBLang source for reference:\n${editor.document.getText().slice(0, 20000)}` : "";
      const prompt = `Explain this Rainbird decision to a business user in plain English: why did the engine conclude what it did, which facts and rules contributed, and why is the certainty what it is? Be concise (a short paragraph, then a brief bullet per contributing fact — mark each as told-to-us / inferred-by-rule / from-datasource). No code blocks.\n\nEvidence tree (JSON):\n${JSON.stringify(tree).slice(0, 40000)}${source}`;
      await streamChat(client, [{ role: "user", content: prompt }], (delta) =>
        this.post({ type: "explainDelta", factId, text: delta })
      );
    } catch (error) {
      this.post({ type: "explainDelta", factId, text: `\n(Explanation failed: ${(error as Error).message})` });
    }
    this.post({ type: "explainDone", factId });
  }

  /** Project the evidence for a result onto the graph view. */
  private async overlay(factId: string): Promise<void> {
    if (!factId) return;
    try {
      const tree = await this.getTree(factId);
      const overlay: EvidenceOverlay = { rels: [], instances: [] };
      const rels = new Map<string, number>();
      const instances = new Set<string>();
      const visit = (node: EvidenceTree) => {
        if (node.fact) {
          const rel = node.fact.relationship?.type;
          if (rel) rels.set(rel, Math.max(rels.get(rel) ?? 0, node.fact.certainty ?? 0));
          if (node.fact.subject?.value) instances.add(String(node.fact.subject.value));
          if (node.fact.object?.value) instances.add(String(node.fact.object.value));
        }
        for (const c of node.rule?.conditions ?? []) {
          if (c.relationship) rels.set(c.relationship, Math.max(rels.get(c.relationship) ?? 0, c.certainty ?? 0));
          if (c.subject && !c.subject.startsWith("%")) instances.add(c.subject);
          if (c.object && !String(c.object).startsWith("%")) instances.add(String(c.object));
        }
        node.children?.forEach(visit);
      };
      visit(tree);
      overlay.rels = [...rels.entries()].map(([name, certainty]) => ({ name, certainty }));
      overlay.instances = [...instances];
      GraphView.showOverlay(overlay);
    } catch (error) {
      this.post({ type: "error", message: `Could not build the graph overlay: ${(error as Error).message}` });
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
         padding: 1rem; max-width: 640px; }
  h2 { font-size: 1.05em; font-weight: 600; margin: 0; }
  #head { display: flex; align-items: center; justify-content: space-between; margin-bottom: .9rem; gap: .5rem; }
  .badge { font-size: .75em; opacity: .7; border: 1px solid var(--vscode-panel-border); border-radius: 10px;
           padding: .1rem .5rem; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 45%; }
  .card { background: var(--vscode-editorWidget-background); border: 1px solid var(--vscode-panel-border);
          border-radius: 8px; padding: .8rem .9rem; margin-bottom: .7rem; }
  .card .prompt { font-weight: 600; margin-bottom: .6rem; line-height: 1.4; }
  label { display: block; font-size: .82em; opacity: .8; margin: .5rem 0 .2rem; }
  select, input[type=text], input[type=number], input[type=date] {
    width: 100%; background: var(--vscode-input-background); color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border, transparent); border-radius: 5px; padding: .35rem .5rem; }
  button { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground);
           border: none; border-radius: 5px; padding: .35rem .8rem; cursor: pointer; margin: .15rem .3rem .15rem 0; }
  button:hover { background: var(--vscode-button-secondaryHoverBackground); }
  button.primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
  button.primary:hover { background: var(--vscode-button-hoverBackground); }
  .chip { border-radius: 12px; }
  .chip.on { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
  .cfrow { display: flex; align-items: center; gap: .6rem; margin-top: .6rem; font-size: .85em; }
  .cfrow input { flex: 1; }
  .transcript { opacity: .75; font-size: .85em; border-left: 2px solid var(--vscode-panel-border);
                padding: .15rem .6rem; margin-bottom: .45rem; }
  .transcript b { opacity: .9; }
  .result { display: flex; flex-direction: column; gap: .3rem; margin-bottom: .6rem; }
  .fact { font-weight: 600; }
  .bar { height: 6px; border-radius: 3px; background: var(--vscode-panel-border); overflow: hidden; }
  .bar > div { height: 100%; background: var(--vscode-charts-green, #73c991); }
  .pct { font-size: .8em; opacity: .75; }
  .src { display: inline-block; border-radius: 3px; padding: 0 .4em; font-size: .78em; color: #fff; margin-right: .4em; }
  details { margin-left: 1rem; border-left: 2px solid var(--vscode-panel-border); padding-left: .6rem; margin-top: .25rem; }
  summary { cursor: pointer; margin: .25rem 0; }
  .cond { opacity: .8; font-size: .85em; margin: .1rem 0 .1rem 1rem; }
  .err { color: var(--vscode-errorForeground); }
  .spin { opacity: .6; font-style: italic; }
  .extras { font-size: .78em; opacity: .6; margin-top: .4rem; }
  .acts { font-size: .8em; margin-top: .15rem; }
  .acts a { color: var(--vscode-textLink-foreground); margin-right: .8em; cursor: pointer; }
  .explain { font-size: .88em; line-height: 1.45; white-space: pre-wrap; border-left: 2px solid var(--vscode-charts-blue, #4d8fd1);
             padding: .3rem .6rem; margin-top: .35rem; }
  .explain:empty { display: none; }
</style>
</head>
<body>
<div id="head">
  <h2>Rainbird Query</h2>
  <span class="badge" id="km"></span>
  <button id="newQuery">New query</button>
</div>
<div id="flow"></div>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const flow = document.getElementById('flow');
  const SRC = { rule:'#3b5bdb', answer:'#e03131', injection:'#5c940d', datasource:'#2b8a3e', knowledgemap:'#e8590c', synthesis:'#1c7ed6' };
  let goals = [], busyEl = null, preselect = null;

  function esc(s) { return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
  function el(html) { const d = document.createElement('div'); d.innerHTML = html; return d.firstElementChild; }
  function clearBusy() { if (busyEl) { busyEl.remove(); busyEl = null; } }
  function busy() { clearBusy(); busyEl = el('<div class="card spin">Rainbird is reasoning…</div>'); flow.appendChild(busyEl); busyEl.scrollIntoView({block:'end'}); }

  function setup() {
    flow.innerHTML = '';
    const options = goals.map(g => '<option value="' + esc(g.name) + '">' + esc(g.name) + ' (' + esc(g.subject) + ' → ' + esc(g.object) + ')</option>').join('');
    const card = el('<div class="card">'
      + '<div class="prompt">What should Rainbird work out?</div>'
      + (goals.length
          ? '<label>Goal relationship (from the open map)</label><select id="goal">' + options + '</select>'
          : '<label>Goal relationship</label><input type="text" id="goal" placeholder="e.g. speaks">')
      + '<label>Subject (optional — leave empty to ask “who/which”)</label><input type="text" id="subject" placeholder="e.g. Fred">'
      + '<div style="margin-top:.7rem"><button class="primary" id="go">Start query</button></div>'
      + '</div>');
    flow.appendChild(card);
    if (preselect) { card.querySelector('#goal').value = preselect; preselect = null; }
    card.querySelector('#go').addEventListener('click', () => {
      const goal = card.querySelector('#goal').value.trim();
      if (!goal) return;
      const subject = card.querySelector('#subject').value.trim();
      card.remove();
      addTranscript('Goal', goal + (subject ? ' — subject: ' + subject : ''));
      vscode.postMessage({ type: 'start', relationship: goal, subject: subject || undefined });
    });
  }

  function addTranscript(label, text) {
    flow.appendChild(el('<div class="transcript"><b>' + esc(label) + ':</b> ' + esc(text) + '</div>'));
  }

  function cfControl(q) {
    return q.allowCF
      ? '<div class="cfrow">Certainty <input type="range" id="cf" min="0" max="100" value="100"><span id="cfv">100%</span></div>'
      : '';
  }
  function readCf(card) {
    const cf = card.querySelector('#cf');
    return cf ? Number(cf.value) : 100;
  }

  function questionCard(q, extras, note) {
    clearBusy();
    let controls = note ? '<div class="err" style="font-size:.82em;margin-bottom:.5rem">' + esc(note) + '</div>' : '';
    const opts = (q.concepts || []).map(c => c.name);

    if (q.type === 'First Form') {
      controls += '<div><button class="primary" data-yn="yes">Yes</button><button data-yn="no">No</button>'
        + (q.allowUnknown ? '<button data-unknown="1">Don\\u2019t know</button>' : '') + '</div>' + cfControl(q);
    } else if (opts.length && q.plural) {
      controls += '<div id="chips">' + opts.map(o => '<button class="chip" data-opt="' + esc(o) + '">' + esc(o) + '</button>').join('') + '</div>'
        + cfControl(q)
        + '<div style="margin-top:.55rem"><button class="primary" id="submitMulti">Submit</button>'
        + (q.allowUnknown ? '<button data-unknown="1">Don\\u2019t know</button>' : '') + '</div>';
    } else if (opts.length) {
      controls += '<div>' + opts.map(o => '<button data-pick="' + esc(o) + '">' + esc(o) + '</button>').join('') + '</div>'
        + (q.canAdd && q.canAdd !== 'none'
            ? '<label>Or something else</label><input type="text" id="other" placeholder="Type your own answer…">'
            : '')
        + cfControl(q)
        + '<div style="margin-top:.55rem">'
        + (q.canAdd && q.canAdd !== 'none' ? '<button class="primary" id="submitOther">Submit</button>' : '')
        + (q.allowUnknown ? '<button data-unknown="1">Don\\u2019t know</button>' : '') + '</div>';
    } else {
      const itype = q.dataType === 'number' ? 'number' : q.dataType === 'date' ? 'date' : 'text';
      controls += (q.dataType === 'truth'
          ? '<div><button class="primary" data-truth="true">True</button><button data-truth="false">False</button></div>'
          : '<input type="' + itype + '" id="val" placeholder="' + esc(q.dataType) + '">')
        + cfControl(q)
        + '<div style="margin-top:.55rem">'
        + (q.dataType !== 'truth' ? '<button class="primary" id="submitVal">Submit</button>' : '')
        + (q.allowUnknown ? '<button data-unknown="1">Don\\u2019t know</button>' : '') + '</div>';
    }

    const card = el('<div class="card"><div class="prompt">' + esc(q.prompt) + '</div>' + controls
      + (extras ? '<div class="extras">+' + extras + ' related question' + (extras>1?'s':'') + ' queued</div>' : '')
      + '</div>');
    flow.appendChild(card);
    card.scrollIntoView({ block: 'end' });

    const cfInput = card.querySelector('#cf');
    if (cfInput) cfInput.addEventListener('input', () => { card.querySelector('#cfv').textContent = cfInput.value + '%'; });

    const finish = (answerText, payload) => {
      card.remove();
      addTranscript(q.prompt, answerText + (payload.certainty !== undefined && payload.certainty !== 100 ? ' (' + payload.certainty + '%)' : ''));
      vscode.postMessage({ type: 'answer', payload });
    };

    card.addEventListener('click', e => {
      const t = e.target;
      if (!t || !t.dataset) return;
      const cf = readCf(card);
      if (t.dataset.yn) finish(t.dataset.yn, { kind: 'yesno', answer: t.dataset.yn, certainty: cf });
      else if (t.dataset.unknown) finish("don\\u2019t know", { kind: 'unknown' });
      else if (t.dataset.pick) finish(t.dataset.pick, { kind: 'value', value: t.dataset.pick, certainty: cf });
      else if (t.dataset.truth) finish(t.dataset.truth, { kind: 'value', value: t.dataset.truth, certainty: cf });
      else if (t.dataset.opt) t.classList.toggle('on');
      else if (t.id === 'submitMulti') {
        const values = [...card.querySelectorAll('.chip.on')].map(c => c.dataset.opt);
        if (values.length) finish(values.join(', '), { kind: 'multi', values, certainty: cf });
      } else if (t.id === 'submitOther') {
        const v = card.querySelector('#other').value.trim();
        if (v) finish(v, { kind: 'value', value: v, certainty: cf });
      } else if (t.id === 'submitVal') {
        const v = card.querySelector('#val').value.trim();
        if (v) finish(v, { kind: 'value', value: v, certainty: cf });
      }
    });
    card.addEventListener('keydown', e => {
      if (e.key === 'Enter') {
        const btn = card.querySelector('#submitVal') || card.querySelector('#submitOther');
        if (btn) btn.click();
      }
    });
    const first = card.querySelector('input');
    if (first) first.focus();
  }

  function evidenceNode(n) {
    const colour = SRC[n.source] || '#868e96';
    const f = n.fact
      ? esc(n.fact.subject && n.fact.subject.value) + ' <em>' + esc(n.fact.relationship && n.fact.relationship.type) + '</em> ' + esc(n.fact.object && n.fact.object.value)
      : esc(n.factID);
    const pct = n.fact ? ' <span class="pct">' + n.fact.certainty + '%</span>' : '';
    const head = '<span class="src" style="background:' + colour + '">' + esc(n.source) + '</span>' + f + pct;
    const conds = ((n.rule && n.rule.conditions) || []).filter(c => !c.factID).map(c => {
      const text = c.expression && c.expression.text
        ? 'expr: ' + esc(c.expression.text) + ' → ' + esc(String(c.expression.value ?? ''))
        : esc(c.subject) + ' ' + esc(c.relationship) + ' ' + esc(c.object);
      return '<div class="cond">• ' + text + (c.wasMet === false ? ' (not met)' : '') + '</div>';
    }).join('');
    const kids = (n.children || []).map(evidenceNode).join('');
    const body = conds + kids;
    return body ? '<details open><summary>' + head + '</summary>' + body + '</details>' : '<div>' + head + '</div>';
  }

  function resultCards(results, sessionId) {
    clearBusy();
    const card = el('<div class="card"></div>');
    if (!results.length) {
      card.innerHTML = '<div class="prompt">No results</div><div>The engine could not derive an answer from what it was told.</div>';
    } else {
      card.innerHTML = '<div class="prompt">Result' + (results.length > 1 ? 's' : '') + '</div>'
        + results.map(r =>
          '<div class="result"><span class="fact">' + esc(r.subject) + ' ' + esc(r.relationship) + ' ' + esc(String(r.object)) + '</span>'
          + '<div class="bar"><div style="width:' + Math.max(0, Math.min(100, r.certainty)) + '%"></div></div>'
          + '<span class="pct">' + r.certainty + '% certain</span>'
          + '<div class="acts">'
          + '<a data-ev="' + esc(r.factID) + '">Show evidence</a>'
          + '<a data-explain="' + esc(r.factID) + '">Explain (AI)</a>'
          + '<a data-overlay="' + esc(r.factID) + '">Show on graph</a>'
          + '</div>'
          + '<div class="explain" id="ex-' + esc(r.factID) + '"></div>'
          + '<div class="evtree" id="ev-' + esc(r.factID) + '"></div></div>').join('');
    }
    card.innerHTML += '<div style="margin-top:.5rem"><button class="primary" id="again">Run another query</button>'
      + (results.length ? '<button id="saveTest">Save as test</button>' : '') + '</div>';
    flow.appendChild(card);
    card.scrollIntoView({ block: 'end' });
    card.addEventListener('click', e => {
      const t = e.target;
      if (!t) return;
      if (t.dataset && t.dataset.ev) {
        t.textContent = 'Loading evidence…';
        vscode.postMessage({ type: 'evidence', factId: t.dataset.ev });
      } else if (t.dataset && t.dataset.explain) {
        const slot = document.getElementById('ex-' + t.dataset.explain);
        if (slot) slot.textContent = '…';
        t.remove();
        vscode.postMessage({ type: 'explain', factId: t.dataset.explain });
      } else if (t.dataset && t.dataset.overlay) {
        vscode.postMessage({ type: 'overlay', factId: t.dataset.overlay });
      } else if (t.id === 'saveTest') {
        vscode.postMessage({ type: 'saveTest' });
      } else if (t.id === 'again') setup();
    });
  }

  document.getElementById('newQuery').addEventListener('click', () => setup());

  window.addEventListener('message', e => {
    const m = e.data;
    switch (m.type) {
      case 'init': {
        goals = m.goals || [];
        preselect = m.preselect || null;
        const km = document.getElementById('km');
        km.dataset.base = (m.useDraft ? 'draft · ' : 'live · ') + m.kmId;
        km.textContent = km.dataset.base;
        km.title = m.apiUrl + ' — ' + m.kmId;
        setup();
        break;
      }
      case 'explainDelta': {
        const slot = document.getElementById('ex-' + m.factId);
        if (slot) {
          if (slot.textContent === '…') slot.textContent = '';
          slot.textContent += m.text;
          slot.scrollIntoView({ block: 'nearest' });
        }
        break;
      }
      case 'explainDone': break;
      case 'mapInfo': {
        const km = document.getElementById('km');
        km.textContent = m.name + (m.status ? ' (' + m.status + ')' : '') + ' — ' + (km.dataset.base || km.textContent);
        break;
      }
      case 'busy': busy(); break;
      case 'question': questionCard(m.question, m.extras, m.note); break;
      case 'result': resultCards(m.results || [], m.sessionId); break;
      case 'evidence': {
        clearBusy();
        const slot = document.getElementById('ev-' + m.factId);
        if (slot) slot.innerHTML = m.error ? '<div class="err">' + esc(m.error) + '</div>' : evidenceNode(m.tree);
        const link = document.querySelector('[data-ev="' + m.factId + '"]');
        if (link) link.remove();
        break;
      }
      case 'error': {
        clearBusy();
        flow.appendChild(el('<div class="card err">' + esc(m.message) + '</div>'));
        break;
      }
    }
  });
</script>
</body>
</html>`;
}
