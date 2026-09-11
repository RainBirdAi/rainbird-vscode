/**
 * Interactive query panel: a webview that drives the engine's full
 * Match → Infer → Ask loop with question cards (grouped questions answered
 * together, yes/no, options, multi-select, certainty sliders, skip, free text,
 * undo), optional fact injection, a draft / live / version target, result
 * cards with certainty bars, inline evidence trees, an AI narrative, a graph
 * overlay, "save as test" and "compare with another version".
 */
import * as vscode from "vscode";
import {
  Answer,
  ApiError,
  EngineResponse,
  EvidenceNode,
  Fact,
  Question,
  RainbirdClient,
  ResultItem,
  StartTarget,
  describeTarget,
  startOptions,
} from "./api";
import { buildIndex } from "./mapIndex";
import { getClient, getEvidenceKey } from "./queryRunner";
import { getAnthropicClient, streamChat } from "./anthropic";
import { EvidenceOverlay, GraphView } from "./graphView";
import { saveSessionAsTest, SessionRecord } from "./tests";
import { recordKnownMap } from "./mapsTree";
import { promotionDiff } from "./promotionDiff";
import { parseFacts } from "./facts";

type EvidenceTree = EvidenceNode & { children?: EvidenceTree[] };

/** One answer as chosen in the webview, matched to a question by position in the group. */
interface AnswerPayload {
  kind: "yesno" | "unknown" | "value" | "multi";
  answer?: "yes" | "no";
  value?: string;
  values?: string[];
  certainty?: number;
}

interface StartMessage {
  relationship?: unknown;
  subject?: unknown;
  object?: unknown;
  target?: { kind?: unknown; version?: unknown };
  facts?: unknown;
}

export class QueryPanel {
  private static current?: QueryPanel;

  private client?: RainbirdClient;
  private sessionId?: string;
  /** The current question group (first question + extraQuestions), in wire order. */
  private questions: Question[] = [];
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

  /** The last completed session (goal, facts, answers, results) — the promotion diff replays it. */
  static lastRecord(): SessionRecord | undefined {
    const record = QueryPanel.current?.record;
    return record?.results ? record : undefined;
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
            await this.start(msg as StartMessage);
            break;
          case "answer":
            await this.answer((msg.payloads as AnswerPayload[] | undefined) ?? [msg.payload as AnswerPayload]);
            break;
          case "undo":
            await this.undo();
            break;
          case "pickFacts":
            await this.pickFacts();
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
          case "compare":
            await promotionDiff(this.context, QueryPanel.lastRecord());
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

    const toGoals = (text: string) =>
      [...buildIndex(text).relationships.entries()].map(([name, rel]) => ({
        name,
        subject: rel.subject,
        object: rel.object,
        plural: rel.plural,
      }));
    let goals = editor ? toGoals(editor.document.getText()) : [];
    let goalsFrom: "editor" | "platform" | "none" = editor ? "editor" : "none";
    if (!goals.length) {
      // No .rbl open (Studio-authored map): read the goal list from the platform draft.
      try {
        goals = toGoals((await this.client.getFile(kmId)).rblang);
        goalsFrom = goals.length ? "platform" : "none";
      } catch {
        // Not readable — the panel falls back to a free-text goal.
      }
    }

    recordKnownMap(this.context, { kmId, source: "queried" });
    this.post({
      type: "init",
      goals,
      goalsFrom,
      kmId,
      preselect: this.pendingGoal,
      apiUrl: vscode.workspace.getConfiguration("rainbird").get<string>("apiUrl") ?? "",
      useDraft: config.get<boolean>("useDraft") ?? true,
    });
    this.pendingGoal = undefined;
  }

  private async start(msg: StartMessage): Promise<void> {
    if (!this.client) return;
    const relationship = String(msg.relationship ?? "").trim();
    if (!relationship) return;
    const subject = msg.subject ? String(msg.subject).trim() : undefined;
    const object = msg.object ? String(msg.object).trim() : undefined;
    const config = vscode.workspace.getConfiguration("rainbird");
    const kmId = config.get<string>("knowledgeMapId");
    if (!kmId) return;
    const target = normaliseTarget(msg.target, config.get<boolean>("useDraft") ?? true);

    let facts: Fact[];
    try {
      facts = parseFacts(String(msg.facts ?? ""));
    } catch (error) {
      this.post({ type: "startError", message: (error as Error).message });
      return;
    }

    this.post({ type: "busy" });
    this.post({ type: "session", target: describeTarget(target) });
    this.record = {
      kmId,
      goal: { relationship, ...(subject ? { subject } : {}), ...(object ? { object } : {}) },
      answers: [],
      target,
      ...(facts.length ? { facts } : {}),
    };
    this.trees.clear();
    this.questions = [];

    let sessionId: string;
    try {
      sessionId = await this.client.start(kmId, startOptions(target));
    } catch (error) {
      if (error instanceof ApiError && error.status === 404 && target.kind !== "draft") {
        throw new Error(
          `Could not start a ${describeTarget(target)} session on ${kmId} — ${
            target.kind === "version" ? `version ${target.version} does not exist` : "the map has no live version yet"
          }. Pick a different target.`
        );
      }
      throw error;
    }
    this.sessionId = sessionId;

    // Show which map this session actually hit — catches "my kmID points at a
    // different map than my open file" before the 400 does.
    void this.client
      .sessionInfo(sessionId)
      .then((info) => {
        if (this.sessionId !== sessionId) return; // a newer query superseded this one
        const nested = (info.km ?? info.kmVersion ?? info.version ?? {}) as Record<string, unknown>;
        const name = [info.name, nested.name, info.kmName].find((v): v is string => typeof v === "string");
        const status = [info.versionStatus, nested.versionStatus].find((v): v is string => typeof v === "string");
        if (name) this.post({ type: "mapInfo", name, status });
        if (target.kind === "live" && status === "Draft") {
          this.post({
            type: "error",
            message: "This map has no live version yet, so the engine served the draft instead. Publish a version in Studio and set it live to query a live version.",
          });
        }
      })
      .catch(() => {
        /* metadata is best-effort */
      });

    if (facts.length) {
      try {
        await this.client.inject(sessionId, facts);
      } catch (error) {
        if (error instanceof ApiError && error.status === 400) {
          const detail = error.errMessages()?.join("; ") ?? error.body.slice(0, 200);
          throw new Error(
            `The engine rejected the injected facts: ${detail}. Relationship and instance names are case-sensitive and must match the map exactly.`
          );
        }
        throw error;
      }
    }

    try {
      const response = await this.client.query(sessionId, {
        relationship,
        ...(subject ? { subject } : {}),
        ...(object ? { object } : {}),
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

  /** Translate one webview payload into wire answers for one question. */
  private toAnswers(q: Question, payload: AnswerPayload): Answer[] {
    const certainty = payload.certainty ?? 100;
    // 'Second Form Subject' asks for the SUBJECT of the triple; every other
    // form asks for (or confirms) the object.
    const askingForSubject = q.type === "Second Form Subject";
    const coerce = (v: string) => (q.dataType === "number" ? Number(v) : q.dataType === "truth" ? v === "true" : v);
    const fill = (value: string | number | boolean): Answer =>
      askingForSubject
        ? { relationship: q.relationship, subject: String(value), object: q.object, certainty }
        : { relationship: q.relationship, subject: q.subject, object: value, certainty };

    switch (payload.kind) {
      case "unknown":
        return [{ relationship: q.relationship, subject: q.subject, object: q.object, unanswered: true }];
      case "yesno":
        return [{ relationship: q.relationship, subject: q.subject, object: q.object, answer: payload.answer, certainty }];
      case "multi":
        return (payload.values ?? []).map((v) => fill(coerce(v)));
      default:
        return [fill(coerce(payload.value ?? ""))];
    }
  }

  /** One payload per question in the current group, in order; all go out in a single /response call. */
  private async answer(payloads: AnswerPayload[]): Promise<void> {
    if (!this.client || !this.sessionId || !this.questions.length) return;
    const group = this.questions;
    const answers: Answer[] = [];
    payloads.forEach((payload, i) => {
      const q = group[i];
      if (q && payload) answers.push(...this.toAnswers(q, payload));
    });
    if (!answers.length) return;

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
          questions: group,
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

  /** POST /undo — step the session back one answer; the engine re-asks (or re-decides). */
  private async undo(): Promise<void> {
    if (!this.client || !this.sessionId) return;
    const before = this.questions;
    this.post({ type: "busy" });
    try {
      const response = await this.client.undo(this.sessionId);
      this.record?.answers.pop();
      this.handleResponse(response);
    } catch (error) {
      if (error instanceof ApiError && error.status === 400) {
        const detail = error.errMessages()?.join("; ") ?? error.body.slice(0, 160);
        this.post({ type: "error", message: `The engine could not undo: ${detail || "nothing to undo"}.` });
        if (before.length) this.post({ type: "question", questions: before });
        return;
      }
      if (error instanceof ApiError && error.status === 404) {
        throw new Error("This session has expired — click “New query” to start again.");
      }
      throw error;
    }
  }

  private handleResponse(response: EngineResponse): void {
    if (response.kind === "question") {
      this.questions = [response.question, ...(response.extraQuestions ?? [])];
      this.post({ type: "question", questions: this.questions });
    } else {
      this.questions = [];
      if (this.record) this.record.results = response.result as ResultItem[];
      this.post({ type: "result", results: response.result, sessionId: this.sessionId });
    }
  }

  /** Load a facts fixture (.facts.json / .json / .csv) into the setup card. */
  private async pickFacts(): Promise<void> {
    const picked = await vscode.window.showOpenDialog({
      title: "Facts to inject",
      filters: { "Facts (JSON or CSV)": ["json", "csv", "txt"] },
      canSelectMany: false,
    });
    if (!picked?.[0]) return;
    const raw = await vscode.workspace.fs.readFile(picked[0]);
    const text = Buffer.from(raw).toString("utf8");
    try {
      const count = parseFacts(text).length;
      this.post({ type: "factsText", text, note: `${count} fact${count === 1 ? "" : "s"} from ${picked[0].path.split("/").pop()}` });
    } catch (error) {
      this.post({ type: "factsText", text, note: `⚠ ${(error as Error).message}` });
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

function normaliseTarget(raw: StartMessage["target"], useDraft: boolean): StartTarget {
  const kind = raw?.kind;
  if (kind === "live") return { kind: "live" };
  if (kind === "version") {
    const version = Number(raw?.version);
    if (Number.isInteger(version) && version > 0) return { kind: "version", version };
  }
  if (kind === "draft") return { kind: "draft" };
  return useDraft ? { kind: "draft" } : { kind: "live" };
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
  select, input[type=text], input[type=number], input[type=date], textarea {
    width: 100%; background: var(--vscode-input-background); color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border, transparent); border-radius: 5px; padding: .35rem .5rem; }
  textarea { font-family: var(--vscode-editor-font-family); font-size: .85em; resize: vertical; margin-top: .3rem; }
  button { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground);
           border: none; border-radius: 5px; padding: .35rem .8rem; cursor: pointer; margin: .15rem .3rem .15rem 0; }
  button:hover { background: var(--vscode-button-secondaryHoverBackground); }
  button:disabled { opacity: .5; cursor: default; }
  button.primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
  button.primary:hover { background: var(--vscode-button-hoverBackground); }
  .chip { border-radius: 12px; }
  .chip.on { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
  .cfrow { display: flex; align-items: center; gap: .6rem; margin-top: .6rem; font-size: .85em; }
  .cfrow input { flex: 1; }
  .row2 { display: flex; gap: .6rem; }
  .row2 > div { flex: 1; min-width: 0; }
  .hint { font-size: .78em; opacity: .6; margin-top: .3rem; line-height: 1.4; }
  details.facts { margin-top: .6rem; font-size: .9em; }
  details.facts summary { cursor: pointer; opacity: .85; }
  .factsNote { font-size: .8em; opacity: .7; margin-left: .4rem; }
  .transcript { opacity: .75; font-size: .85em; border-left: 2px solid var(--vscode-panel-border);
                padding: .15rem .6rem; margin-bottom: .45rem; }
  .transcript b { opacity: .9; }
  .q.sub { border-top: 1px solid var(--vscode-panel-border); padding-top: .55rem; margin-top: .55rem; }
  .q.sub .prompt { font-weight: 500; }
  .q.done .ctl { opacity: .45; pointer-events: none; }
  .chosen { font-size: .85em; margin-top: .3rem; color: var(--vscode-charts-green, #73c991); }
  .chosen a { color: var(--vscode-textLink-foreground); cursor: pointer; margin-left: .5em; font-size: .9em; }
  .foot { margin-top: .7rem; display: flex; align-items: center; gap: .3rem; flex-wrap: wrap; }
  .foot .back { margin-left: auto; opacity: .8; }
  .result { display: flex; flex-direction: column; gap: .3rem; margin-bottom: .6rem; }
  .fact { font-weight: 600; }
  .bar { height: 6px; border-radius: 3px; background: var(--vscode-panel-border); overflow: hidden; }
  .bar > div { height: 100%; background: var(--vscode-charts-green, #73c991); }
  .pct { font-size: .8em; opacity: .75; }
  .src { display: inline-block; border-radius: 3px; padding: 0 .4em; font-size: .78em; color: #fff; margin-right: .4em; }
  details.ev { margin-left: 1rem; border-left: 2px solid var(--vscode-panel-border); padding-left: .6rem; margin-top: .25rem; }
  details.ev summary { cursor: pointer; margin: .25rem 0; }
  .cond { opacity: .8; font-size: .85em; margin: .1rem 0 .1rem 1rem; }
  .err { color: var(--vscode-errorForeground); }
  .err:empty { display: none; }
  .startErr { font-size: .85em; margin-top: .5rem; }
  .spin { opacity: .6; font-style: italic; }
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
  let goals = [], goalsFrom = 'none', busyEl = null, preselect = null, defaultTarget = 'draft', pendingSetup = null;

  function esc(s) { return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
  function el(html) { const d = document.createElement('div'); d.innerHTML = html; return d.firstElementChild; }
  function clearBusy() { if (busyEl) { busyEl.remove(); busyEl = null; } }
  function busy() {
    if (pendingSetup) { addTranscript('Goal', pendingSetup.dataset.summary || ''); pendingSetup.remove(); pendingSetup = null; }
    clearBusy(); busyEl = el('<div class="card spin">Rainbird is reasoning…</div>'); flow.appendChild(busyEl); busyEl.scrollIntoView({block:'end'});
  }
  function addTranscript(label, text) {
    flow.appendChild(el('<div class="transcript"><b>' + esc(label) + ':</b> ' + esc(text) + '</div>'));
  }

  function setup() {
    flow.innerHTML = '';
    pendingSetup = null;
    const options = goals.map(g => '<option value="' + esc(g.name) + '">' + esc(g.name) + ' (' + esc(g.subject) + ' → ' + esc(g.object) + ')</option>').join('');
    const card = el('<div class="card">'
      + '<div class="prompt">What should Rainbird work out?</div>'
      + (goals.length
          ? '<label>Goal relationship (from ' + (goalsFrom === 'platform' ? 'the platform draft' : 'the open map') + ')</label><select class="goal">' + options + '</select>'
          : '<label>Goal relationship</label><input type="text" class="goal" placeholder="e.g. speaks">')
      + '<div class="row2">'
      + '<div><label>Subject (optional)</label><input type="text" class="subject" placeholder="e.g. Fred"></div>'
      + '<div><label>Object (optional)</label><input type="text" class="object" placeholder="e.g. French"></div>'
      + '</div>'
      + '<div class="hint">Leave both empty to ask “who / which”. Fill the subject for “what does Fred …”. Fill both to ask how certain one specific fact is.</div>'
      + '<div class="row2">'
      + '<div><label>Run against</label><select class="target">'
      + '<option value="draft">Draft (working copy)</option><option value="live">Live version</option><option value="version">A specific version…</option></select></div>'
      + '<div class="verwrap" style="display:none"><label>Version number</label><input type="number" class="version" min="1" placeholder="e.g. 3"></div>'
      + '</div>'
      + '<details class="facts"><summary>Facts to inject before the query (optional)</summary>'
      + '<textarea class="factsText" rows="4" placeholder="JSON: [{&quot;subject&quot;:&quot;Fred&quot;,&quot;relationship&quot;:&quot;lives in&quot;,&quot;object&quot;:&quot;France&quot;,&quot;certainty&quot;:100}]&#10;or CSV, one per line: Fred,lives in,France,100"></textarea>'
      + '<div><button class="loadFacts">Load from file…</button><span class="factsNote"></span></div></details>'
      + '<div class="err startErr"></div>'
      + '<div style="margin-top:.7rem"><button class="primary go">Start query</button></div>'
      + '</div>');
    flow.appendChild(card);
    const goalEl = card.querySelector('.goal');
    if (preselect) { goalEl.value = preselect; preselect = null; }
    const targetEl = card.querySelector('.target');
    targetEl.value = defaultTarget;
    targetEl.addEventListener('change', () => { card.querySelector('.verwrap').style.display = targetEl.value === 'version' ? '' : 'none'; });
    card.querySelector('.loadFacts').addEventListener('click', () => vscode.postMessage({ type: 'pickFacts' }));
    card.querySelector('.go').addEventListener('click', () => {
      const goal = goalEl.value.trim();
      const errSlot = card.querySelector('.startErr');
      errSlot.textContent = '';
      if (!goal) { errSlot.textContent = 'Pick a goal relationship.'; return; }
      const subject = card.querySelector('.subject').value.trim();
      const object = card.querySelector('.object').value.trim();
      const kind = targetEl.value;
      const version = Number(card.querySelector('.version').value);
      if (kind === 'version' && !(Number.isInteger(version) && version > 0)) { errSlot.textContent = 'Enter a version number.'; return; }
      const facts = card.querySelector('.factsText').value;
      const target = kind === 'version' ? { kind, version } : { kind };
      card.dataset.summary = goal + (subject ? ' — subject: ' + subject : '') + (object ? ' — object: ' + object : '')
        + ' · ' + (kind === 'version' ? 'version ' + version : kind) + (facts.trim() ? ' · with injected facts' : '');
      pendingSetup = card;
      const go = card.querySelector('.go'); go.disabled = true; go.textContent = 'Starting…';
      vscode.postMessage({ type: 'start', relationship: goal, subject: subject || undefined, object: object || undefined, target, facts });
    });
  }

  function cfControl(q) {
    return q.allowCF
      ? '<div class="cfrow">Certainty <input type="range" class="cf" min="0" max="100" value="100"><span class="cfv">100%</span></div>'
      : '';
  }
  function readCf(block) {
    const cf = block.querySelector('.cf');
    return cf ? Number(cf.value) : 100;
  }

  function controlsFor(q) {
    const opts = (q.concepts || []).map(c => c.name);
    let controls = '';
    if (q.type === 'First Form') {
      controls += '<div><button class="primary" data-yn="yes">Yes</button><button data-yn="no">No</button>'
        + (q.allowUnknown ? '<button data-unknown="1">Don\\u2019t know</button>' : '') + '</div>' + cfControl(q);
    } else if (opts.length && q.plural) {
      controls += '<div class="chips">' + opts.map(o => '<button class="chip" data-opt="' + esc(o) + '">' + esc(o) + '</button>').join('') + '</div>'
        + cfControl(q)
        + '<div style="margin-top:.55rem"><button class="primary" data-act="submitMulti">Submit</button>'
        + (q.allowUnknown ? '<button data-unknown="1">Don\\u2019t know</button>' : '') + '</div>';
    } else if (opts.length) {
      controls += '<div>' + opts.map(o => '<button data-pick="' + esc(o) + '">' + esc(o) + '</button>').join('') + '</div>'
        + (q.canAdd && q.canAdd !== 'none'
            ? '<label>Or something else</label><input type="text" class="other" placeholder="Type your own answer…">'
            : '')
        + cfControl(q)
        + '<div style="margin-top:.55rem">'
        + (q.canAdd && q.canAdd !== 'none' ? '<button class="primary" data-act="submitOther">Submit</button>' : '')
        + (q.allowUnknown ? '<button data-unknown="1">Don\\u2019t know</button>' : '') + '</div>';
    } else {
      const itype = q.dataType === 'number' ? 'number' : q.dataType === 'date' ? 'date' : 'text';
      controls += (q.dataType === 'truth'
          ? '<div><button class="primary" data-truth="true">True</button><button data-truth="false">False</button></div>'
          : '<input type="' + itype + '" class="val" placeholder="' + esc(q.dataType) + '">')
        + cfControl(q)
        + '<div style="margin-top:.55rem">'
        + (q.dataType !== 'truth' ? '<button class="primary" data-act="submitVal">Submit</button>' : '')
        + (q.allowUnknown ? '<button data-unknown="1">Don\\u2019t know</button>' : '') + '</div>';
    }
    return '<div class="ctl">' + controls + '</div>';
  }

  function describeAnswer(text, payload) {
    return text + (payload.certainty !== undefined && payload.certainty !== 100 ? ' (' + payload.certainty + '%)' : '');
  }

  // One card per question group. A single question submits on click; a group
  // collects one answer per question and submits them together, because the
  // engine expects every question of a group answered in one /response call.
  function questionGroup(questions, note) {
    clearBusy();
    const single = questions.length === 1;
    const card = el('<div class="card">'
      + (note ? '<div class="err" style="font-size:.82em;margin-bottom:.5rem">' + esc(note) + '</div>' : '')
      + (single ? '' : '<div class="prompt">' + questions.length + ' related questions — answer all, then submit</div>')
      + questions.map((q, i) => '<div class="q' + (single ? '' : ' sub') + '" data-i="' + i + '"><div class="prompt">' + esc(q.prompt) + '</div>' + controlsFor(q) + '<div class="chosen"></div></div>').join('')
      + '<div class="foot">' + (single ? '' : '<button class="primary submitAll" disabled>Submit answers</button>')
      + '<button class="back" title="Undo the previous answer">↶ Back</button></div>'
      + '</div>');
    flow.appendChild(card);
    card.scrollIntoView({ block: 'end' });
    const pending = questions.map(() => null);

    card.querySelectorAll('.cf').forEach(cf => cf.addEventListener('input', () => { cf.parentElement.querySelector('.cfv').textContent = cf.value + '%'; }));

    const settle = (i, text, payload) => {
      if (single) {
        card.remove();
        addTranscript(questions[0].prompt, describeAnswer(text, payload));
        vscode.postMessage({ type: 'answer', payloads: [payload] });
        return;
      }
      pending[i] = { text, payload };
      const block = card.querySelector('.q[data-i="' + i + '"]');
      block.classList.add('done');
      block.querySelector('.chosen').innerHTML = '✓ ' + esc(describeAnswer(text, payload)) + '<a class="change">change</a>';
      card.querySelector('.submitAll').disabled = pending.some(p => !p);
    };

    card.addEventListener('click', e => {
      const t = e.target;
      if (!t || !t.classList) return;
      if (t.classList.contains('back')) { card.remove(); addTranscript('↶', 'back one step'); vscode.postMessage({ type: 'undo' }); return; }
      if (t.classList.contains('submitAll')) {
        if (pending.some(p => !p)) return;
        card.remove();
        questions.forEach((q, i) => addTranscript(q.prompt, describeAnswer(pending[i].text, pending[i].payload)));
        vscode.postMessage({ type: 'answer', payloads: pending.map(p => p.payload) });
        return;
      }
      if (t.classList.contains('change')) {
        const block = t.closest('.q'); const i = Number(block.dataset.i);
        pending[i] = null; block.classList.remove('done'); block.querySelector('.chosen').innerHTML = '';
        card.querySelector('.submitAll').disabled = true;
        return;
      }
      const block = t.closest('.q');
      if (!block || block.classList.contains('done')) return;
      const i = Number(block.dataset.i);
      const cf = readCf(block);
      const d = t.dataset || {};
      if (d.yn) settle(i, d.yn, { kind: 'yesno', answer: d.yn, certainty: cf });
      else if (d.unknown) settle(i, "don\\u2019t know", { kind: 'unknown' });
      else if (d.pick) settle(i, d.pick, { kind: 'value', value: d.pick, certainty: cf });
      else if (d.truth) settle(i, d.truth, { kind: 'value', value: d.truth, certainty: cf });
      else if (d.opt) t.classList.toggle('on');
      else if (d.act === 'submitMulti') {
        const values = [...block.querySelectorAll('.chip.on')].map(c => c.dataset.opt);
        if (values.length) settle(i, values.join(', '), { kind: 'multi', values, certainty: cf });
      } else if (d.act === 'submitOther') {
        const v = block.querySelector('.other').value.trim();
        if (v) settle(i, v, { kind: 'value', value: v, certainty: cf });
      } else if (d.act === 'submitVal') {
        const v = block.querySelector('.val').value.trim();
        if (v) settle(i, v, { kind: 'value', value: v, certainty: cf });
      }
    });
    card.addEventListener('keydown', e => {
      if (e.key !== 'Enter') return;
      const block = e.target && e.target.closest ? e.target.closest('.q') : null;
      if (!block) return;
      const btn = block.querySelector('[data-act="submitVal"]') || block.querySelector('[data-act="submitOther"]');
      if (btn) btn.click();
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
    return body ? '<details class="ev" open><summary>' + head + '</summary>' + body + '</details>' : '<div>' + head + '</div>';
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
    card.innerHTML += '<div class="foot"><button class="primary" id="again">Run another query</button>'
      + (results.length ? '<button id="saveTest">Save as test</button><button id="compare" title="Replay this session against another version and diff the outcome">Compare with another version…</button>' : '')
      + '<button class="back" title="Undo the last answer and continue">↶ Back</button></div>';
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
      } else if (t.id === 'compare') {
        vscode.postMessage({ type: 'compare' });
      } else if (t.classList && t.classList.contains('back')) {
        card.remove(); addTranscript('↶', 'back one step'); vscode.postMessage({ type: 'undo' });
      } else if (t.id === 'again') setup();
    });
  }

  document.getElementById('newQuery').addEventListener('click', () => setup());

  window.addEventListener('message', e => {
    const m = e.data;
    switch (m.type) {
      case 'init': {
        goals = m.goals || [];
        goalsFrom = m.goalsFrom || 'none';
        preselect = m.preselect || null;
        defaultTarget = m.useDraft ? 'draft' : 'live';
        const km = document.getElementById('km');
        km.dataset.km = m.kmId;
        km.dataset.base = defaultTarget + ' · ' + m.kmId;
        km.textContent = km.dataset.base;
        km.title = m.apiUrl + ' — ' + m.kmId;
        setup();
        break;
      }
      case 'session': {
        const km = document.getElementById('km');
        km.dataset.base = m.target + ' · ' + (km.dataset.km || '');
        km.textContent = km.dataset.base;
        break;
      }
      case 'startError': {
        if (pendingSetup) {
          pendingSetup.querySelector('.startErr').textContent = m.message;
          const go = pendingSetup.querySelector('.go'); go.disabled = false; go.textContent = 'Start query';
          pendingSetup = null;
        } else {
          flow.appendChild(el('<div class="card err">' + esc(m.message) + '</div>'));
        }
        break;
      }
      case 'factsText': {
        const area = flow.querySelector('.factsText');
        if (area) {
          area.value = m.text;
          area.closest('details').open = true;
          const note = flow.querySelector('.factsNote');
          if (note) note.textContent = m.note || '';
        }
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
      case 'question': questionGroup(m.questions || [m.question], m.note); break;
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
