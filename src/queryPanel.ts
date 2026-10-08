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
  ApiError,
  EngineResponse,
  Fact,
  Question,
  RainbirdClient,
  StartTarget,
  describeTarget,
  startOptions,
  unknownMapMessage,
} from "./api";
import { getClient, getEvidenceKey } from "./queryRunner";
import { getAnthropicClient, streamChat } from "./anthropic";
import { EXPLAIN_SYSTEM_PROMPT } from "./knowledge";
import { GraphView } from "./graphView";
import { saveSessionAsTest, SessionRecord } from "./tests";
import { recordKnownMap, SNAPSHOT_SCHEME } from "./mapsTree";
import { promotionDiff } from "./promotionDiff";
import { parseFacts } from "./facts";
import { render } from "./queryPanelHtml";
import { activeRblangUri, fileKmId, PLATFORM_SCHEME, promptKmId, resolveKmIdFor } from "./platform";
import { sameKmId } from "./kmId";
import {
  lastGoalFor,
  noMapNote,
  panelGoals,
  PanelGoal,
  preselectGoal,
  unknownGoalNote,
  withLastGoal,
} from "./queryWebview/setup";
import { QuestionFlow } from "./queryWebview/questions";
import type { OpenMap, QuestionFlowHost } from "./queryWebview/questions";
import { appendRainbirdLog } from "./platformDiagnostics";
import { writeDocument } from "./editApplier";
import { ExpandedEvidence, overlayFromEvidence } from "./evidenceModel";
import { describeEvidence, renderEvidenceHtml } from "./evidenceRender";
import { currentApiUrl, openOrCopyEvidenceLink } from "./evidenceLinks";
import { showEvidenceTree } from "./evidenceView";

/** A message from the webview: always a `type`, plus fields that depend on it. */
interface WebviewMessage {
  type?: string;
  [field: string]: unknown;
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

  // ── Session (shared by every region) ──
  private client?: RainbirdClient;
  private sessionId?: string;
  private record?: SessionRecord;
  private kmId?: string;

  // ── Setup region: map, goal, target, facts ──
  /** The RBLang file the panel queries (title-bar ▶, else the file in use); undefined for a map chosen by ID alone. */
  private targetUri?: vscode.Uri;
  /** The file of the last ▶ whose map prompt was cancelled: “Choose map…” asks for its map again instead of dropping it. */
  private pendingTarget?: vscode.Uri;
  /** The goal list of the last init: only names the map declares are remembered as its last goal. */
  private goals: PanelGoal[] = [];
  /** Where that list came from, for the "no relationship named exactly" note. */
  private goalsFrom: "editor" | "platform" | "none" = "none";
  /** Bumped by every init, so a slower earlier one cannot post over a newer one. */
  private initSeq = 0;
  /** Bumped by every start and whenever a fresh setup card replaces the session (init, New query): a superseded start posts nothing more. */
  private sessionSeq = 0;
  /** True while start() waits for /start, /inject and /query: ▶ asks before replacing it, as it does for pending questions. */
  private starting = false;

  // ── Questions region ──
  /** The question cards' steps and their state, VS Code-free (src/queryWebview/questions.ts); questionFlowHost() connects them to this panel. */
  private readonly flow = new QuestionFlow(this.questionFlowHost());
  /** The current question group (first question + extraQuestions), in wire order. */
  private get questions(): Question[] {
    return this.flow.questions;
  }
  private set questions(group: Question[]) {
    this.flow.questions = group;
  }

  // ── Results region: evidence, explanations, overlay ──
  /**
   * Complete evidence trees of the current session by result factID: Show evidence, Explain, Show on graph
   * and Open in panel share them. A tree with facts that could not be loaded is not kept.
   */
  private readonly trees = new Map<string, ExpandedEvidence>();
  /** Trees being fetched, by factID: a request made meanwhile waits for the same fetch instead of starting another. */
  private readonly treeLoads = new Map<string, { sessionId: string; evidenceKey?: string; tree: Promise<ExpandedEvidence> }>();
  /** The latest evidence() call per factID. Only its answer is posted, so an older, slower one cannot replace it. */
  private readonly evidenceCalls = new Map<string, number>();

  static async open(context: vscode.ExtensionContext, kmIdOverride?: string, goal?: string, target?: vscode.Uri): Promise<void> {
    // kmIdOverride (Maps view, Open Map's "Run query") wins over the file's own
    // map; goal (cursor or CodeLens) is preselected. The file to query is
    // captured before the panel takes focus: `target`, the editor whose
    // title-bar ▶ was pressed, else the RBLang file in use — possibly a hidden
    // tab, such as the .rbl behind the Welcome page's walkthrough.
    const fileUri = target ?? activeRblangUri();
    const current = QueryPanel.current;
    if (current) {
      current.panel.reveal();
      if (current.questions.length > 0 || current.starting) {
        const choice = await vscode.window.showWarningMessage(
          "A query is in progress — start a new one?",
          { modal: true },
          "Start new"
        );
        if (choice !== "Start new" || QueryPanel.current !== current) return;
      }
      await current.init({ kmIdOverride, target: fileUri, goal });
      return;
    }
    const panel = vscode.window.createWebviewPanel("rainbirdQuery", "Rainbird Query", vscode.ViewColumn.Beside, {
      enableScripts: true,
      retainContextWhenHidden: true,
    });
    QueryPanel.current = new QueryPanel(context, panel);
    await QueryPanel.current.init({ kmIdOverride, target: fileUri, goal });
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
    panel.webview.onDidReceiveMessage(async (msg: WebviewMessage) => {
      try {
        // Each region handles its own message types and returns true when it did.
        if (await this.onSetupMessage(msg)) return;
        if (await this.onQuestionMessage(msg)) return;
        await this.onResultMessage(msg);
      } catch (error) {
        this.post({ type: "error", message: (error as Error).message });
      }
    });
  }

  /** Setup region: start a query, load facts from a file, change the map, forget the session on New query. */
  private async onSetupMessage(msg: WebviewMessage): Promise<boolean> {
    switch (msg.type) {
      case "start":
        await this.start(msg as StartMessage);
        return true;
      case "pickFacts":
        await this.pickFacts();
        return true;
      case "changeKm":
        await this.changeKm();
        return true;
      case "newQuery":
        // The webview replaced the session on screen with a fresh setup card.
        this.dropSession();
        return true;
    }
    return false;
  }

  /** Questions region: answer the current question group, step back one answer, answer an automatic skip instead, make a relationship inject-only (QuestionFlow.onMessage). */
  private async onQuestionMessage(msg: WebviewMessage): Promise<boolean> {
    return this.flow.onMessage(msg);
  }

  /** Results region: evidence, AI explanation, graph overlay, save as test, compare versions. */
  private async onResultMessage(msg: WebviewMessage): Promise<boolean> {
    switch (msg.type) {
      case "evidence":
        await this.evidence(String(msg.factId ?? ""));
        return true;
      case "explain":
        await this.explain(String(msg.factId ?? ""));
        return true;
      case "overlay":
        await this.overlay(String(msg.factId ?? ""));
        return true;
      case "evidenceAction":
        await this.evidenceAction(String(msg.action ?? ""), String(msg.factId ?? ""));
        return true;
      case "saveTest":
        if (this.record) await saveSessionAsTest(this.record);
        return true;
      case "compare":
        await promotionDiff(this.context, QueryPanel.lastRecord());
        return true;
    }
    return false;
  }

  private post(message: unknown): void {
    void this.panel.webview.postMessage(message);
  }

  /**
   * Resolve the map and its goal list and show a fresh setup card. `target` is
   * the RBLang file to query (default: the current one), kept only once its map
   * is resolved; `goal` is preselected when the map declares it.
   */
  private async init(opts: { kmIdOverride?: string; target?: vscode.Uri; goal?: string } = {}): Promise<void> {
    const seq = ++this.initSeq;
    const { kmIdOverride, goal } = opts;
    let uri = "target" in opts ? opts.target : this.targetUri;
    // Until this init commits, the session on screen keeps its client, map and file.
    const client = await getClient(this.context);
    if (seq !== this.initSeq) return;
    if (!client) {
      this.pendingTarget = uri;
      this.post({ type: "error", message: "Not connected — run “Rainbird: Connect” first." });
      return;
    }

    // One kmID precedence (O-2): the override, then the file's own map (its
    // binding), then the setting for its folder, then a prompt (remembered for
    // the folder). Held on the instance: start(), the session record and the
    // header all use it, and it is never re-read from the setting.
    const kmId = await resolveKmIdFor(this.context, { uri, override: kmIdOverride, prompt: true, title: "Run Query: which map?" });
    if (seq !== this.initSeq) return;
    if (!kmId) {
      // Kept aside, so “Choose map…” / “Change…” asks for this file's map again (and
      // remembers the answer for its folder) instead of dropping the file.
      this.pendingTarget = uri;
      this.post({
        type: "error",
        message: noMapNote({ current: this.kmId, file: uri && QueryPanel.baseName(uri), retry: !this.bindableTarget() }),
      });
      return;
    }
    // An explicit map wins, and the open file's goals are its goals only when the file is that map.
    if (uri && kmIdOverride && !sameKmId(await resolveKmIdFor(this.context, { uri, prompt: false }), kmId)) uri = undefined;

    // The goal list: the file's text (read even from a hidden tab), else the
    // platform draft — a Studio-authored map, or a file with no relationships.
    let list: { goals: PanelGoal[]; askableMixed: boolean } = { goals: [], askableMixed: false };
    if (uri) {
      try {
        list = panelGoals((await vscode.workspace.openTextDocument(uri)).getText());
      } catch {
        uri = undefined; // closed or deleted since
      }
    }
    let goalsFrom: "editor" | "platform" | "none" = list.goals.length ? "editor" : "none";
    // Set when the platform has no map with this ID: the setup card says so before any query is tried.
    let mapNote: string | undefined;
    if (!list.goals.length) {
      try {
        list = panelGoals((await client.getFile(kmId)).rblang);
        goalsFrom = list.goals.length ? "platform" : "none";
      } catch (error) {
        // Verified live: /analysis/file answers 404 for an unknown or malformed kmID, or one from another environment.
        if (error instanceof ApiError && error.status === 404) {
          mapNote = `${unknownMapMessage(kmId, currentApiUrl())} Click “Change…” at the top to query another map.`;
        }
        // Otherwise not readable — the panel falls back to a free-text goal.
      }
    }
    if (seq !== this.initSeq) return;
    this.client = client;
    this.targetUri = uri;
    this.pendingTarget = undefined;
    this.kmId = kmId;
    this.goals = list.goals;
    this.goalsFrom = goalsFrom;

    // A fresh setup card replaces any question card, so no query is in progress any more.
    this.dropSession();

    // The relationship at the cursor (or a CodeLens's) wins over the last goal run against this map.
    const remembered = lastGoalFor(this.context.globalState.get(QueryPanel.lastGoalsKey()), kmId, list.goals);
    const preselect = preselectGoal(list.goals, goal, remembered);

    const file = this.bindableTarget();
    this.post({
      type: "init",
      goals: list.goals,
      goalsFrom,
      askableMixed: list.askableMixed,
      kmId,
      mapNote,
      preselect: preselect?.goal,
      preselectFrom: preselect?.from,
      // Only a file “Change…” can bind is named: its tooltip then says so.
      fileName: file && QueryPanel.baseName(file),
      apiUrl: vscode.workspace.getConfiguration("rainbird").get<string>("apiUrl") ?? "",
      useDraft: vscode.workspace.getConfiguration("rainbird", uri).get<boolean>("useDraft") ?? true,
    });
  }

  /**
   * "Change…" beside the map badge (O-5). For a file: run “Bind Open File to a
   * Knowledge Map ID…” on it, and start over when its binding changed. After ▶
   * in a file whose map prompt was cancelled: ask for that file's map again.
   * Otherwise (a map chosen by ID, or a read-only platform or snapshot
   * document, which is a map itself and cannot be bound): ask for a kmID and
   * query that map.
   */
  private async changeKm(): Promise<void> {
    const file = this.bindableTarget();
    if (file) {
      const before = fileKmId(this.context, file);
      await vscode.commands.executeCommand("rainbird.bindKmId", file);
      const after = fileKmId(this.context, file);
      if (after && !sameKmId(after, before)) await this.init({ target: file });
      return;
    }
    if (this.pendingTarget) {
      await this.init({ target: this.pendingTarget });
      return;
    }
    const next = await promptKmId(this.context, { title: "Query which map?", current: this.kmId });
    if (next) await this.init({ kmIdOverride: next, target: undefined });
  }

  /** The panel's file when it can be pushed or bound: platform and snapshot documents are read-only copies of a map. */
  private bindableTarget(): vscode.Uri | undefined {
    const uri = this.targetUri;
    return uri && uri.scheme !== PLATFORM_SCHEME && uri.scheme !== SNAPSHOT_SCHEME ? uri : undefined;
  }

  /** A file's name for the panel's copy. */
  private static baseName(uri: vscode.Uri): string {
    return uri.path.split("/").pop() || uri.toString();
  }

  /**
   * A fresh setup card replaced the session on screen (init, or New query in
   * the webview): no query is in progress any more, and a start still waiting
   * for the engine posts nothing when it returns.
   */
  private dropSession(): void {
    this.sessionSeq++;
    this.starting = false;
    this.questions = [];
  }

  /** Remember the goal last run against a map (G-3); never throws. */
  private async rememberGoal(kmId: string, goal: string): Promise<void> {
    const key = QueryPanel.lastGoalsKey();
    try {
      await this.context.globalState.update(key, withLastGoal(this.context.globalState.get(key), kmId, goal));
    } catch (error) {
      console.warn("Rainbird: could not remember the last goal:", error);
    }
  }

  /** globalState key mapping kmID → last goal, per environment like the Maps registry. */
  private static lastGoalsKey(): string {
    const apiUrl = vscode.workspace.getConfiguration("rainbird").get<string>("apiUrl") ?? "https://api.rainbird.ai";
    return `rainbird.lastGoals.${apiUrl}`;
  }

  private async start(msg: StartMessage): Promise<void> {
    // The map and client init committed (O-2) — never the setting again, which may name another map.
    const kmId = this.kmId;
    const client = this.client;
    if (!kmId || !client) {
      this.post({
        type: "startError",
        message: kmId ? "Not connected — run “Rainbird: Connect” first." : "No map chosen yet — click “Choose map…” at the top.",
      });
      return;
    }
    const relationship = String(msg.relationship ?? "").trim();
    if (!relationship) {
      this.post({ type: "startError", message: "Pick a goal relationship." });
      return;
    }
    const subject = msg.subject ? String(msg.subject).trim() : undefined;
    const object = msg.object ? String(msg.object).trim() : undefined;
    // Verified live: /query with neither answers 400 "Please provide a string or numeric subject." (and object).
    // Checked here, before busy, so the setup card keeps everything typed.
    if (!subject && !object) {
      this.post({ type: "startError", message: "Fill the subject, the object or both: the engine cannot query a relationship with neither." });
      return;
    }
    const config = vscode.workspace.getConfiguration("rainbird", this.targetUri);
    const target = normaliseTarget(msg.target, config.get<boolean>("useDraft") ?? true);

    let facts: Fact[];
    try {
      facts = parseFacts(String(msg.facts ?? ""));
    } catch (error) {
      this.post({ type: "startError", message: (error as Error).message });
      return;
    }

    // G-3: the next panel for this map starts from this goal (names the map does not declare are not kept).
    if (this.goals.some((g) => g.name === relationship)) void this.rememberGoal(kmId, relationship);

    // This query supersedes any earlier one still starting. Until its first
    // question or result arrives, ▶ asks before replacing it.
    const seq = ++this.sessionSeq;
    this.starting = true;
    try {
      await this.startSession(seq, { client, kmId, relationship, subject, object, target, facts });
    } catch (error) {
      // Rejected facts, an unknown goal or map, a missing live version or version: the webview puts the
      // setup card back with everything typed, and shows why under it. A superseded start posts nothing.
      if (seq === this.sessionSeq) this.post({ type: "startError", message: (error as Error).message });
    } finally {
      if (seq === this.sessionSeq) this.starting = false;
    }
  }

  /**
   * start()'s round trip: /start, /inject and /query, then the first question
   * or result. Once superseded (a newer start, an init, or New query in the
   * webview) it posts nothing more, so a late answer never lands under a fresh
   * setup card, where answering it would continue the abandoned session.
   * Failures are thrown: start() posts them as startError, which puts the
   * setup card back.
   */
  private async startSession(
    seq: number,
    query: { client: RainbirdClient; kmId: string; relationship: string; subject?: string; object?: string; target: StartTarget; facts: Fact[] }
  ): Promise<void> {
    const { client, kmId, relationship, subject, object, target, facts } = query;
    const superseded = () => seq !== this.sessionSeq;
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
      sessionId = await client.start(kmId, startOptions(target));
    } catch (error) {
      if (superseded()) return;
      if (error instanceof ApiError && error.status === 404 && target.kind !== "draft") {
        throw new Error(
          `Could not start a ${describeTarget(target)} session on ${kmId} — ${
            target.kind === "version" ? `version ${target.version} does not exist` : "the map has no live version yet"
          }. Pick a different target.`
        );
      }
      throw error;
    }
    if (superseded()) return;
    this.sessionId = sessionId;
    // Listed under Maps only now that the engine accepted the ID (an unknown one fails at /start above).
    void recordKnownMap(this.context, { kmId, source: "queried" });

    // Show which map this session actually hit — catches "my kmID points at a
    // different map than my open file" before the 400 does.
    void client
      .sessionInfo(sessionId)
      .then((info) => {
        if (this.sessionId !== sessionId || superseded()) return; // a newer query or a fresh setup card superseded this one
        const nested = (info.km ?? info.kmVersion ?? info.version ?? {}) as Record<string, unknown>;
        const name = [info.name, nested.name, info.kmName].find((v): v is string => typeof v === "string");
        const status = [info.versionStatus, nested.versionStatus].find((v): v is string => typeof v === "string");
        if (name) this.post({ type: "mapInfo", name, status });
        if (target.kind === "live" && status === "Draft") {
          // A notice, not an error: it usually arrives while /query runs, and must neither clear the
          // spinner nor drop the transcript lines of answers waiting for the engine.
          this.post({
            type: "notice",
            message: "This map has no live version yet, so the engine served the draft instead. Publish a version in Studio and set it live to query a live version.",
          });
        }
      })
      .catch(() => {
        /* metadata is best-effort */
      });

    if (facts.length) {
      try {
        await client.inject(sessionId, facts);
      } catch (error) {
        if (superseded()) return;
        if (error instanceof ApiError && error.status === 400) {
          // The engine's own text ends in a full stop ("…: Lives In."): drop it before adding the sentence's own.
          const detail = (error.errMessages()?.join("; ") ?? error.body.slice(0, 200)).replace(/[.\s]+$/, "");
          throw new Error(
            `The engine rejected the injected facts: ${detail}. Relationship and instance names are case-sensitive and must match the map exactly.`
          );
        }
        throw error;
      }
      if (superseded()) return;
    }

    try {
      const response = await client.query(sessionId, {
        relationship,
        ...(subject ? { subject } : {}),
        ...(object ? { object } : {}),
      });
      if (superseded()) return;
      this.handleResponse(response);
    } catch (error) {
      if (superseded()) return;
      // Verified live: an unknown OR case-mismatched relationship yields
      // exactly `400 Bad request!`; structural problems return {"err": [...]}.
      if (error instanceof ApiError && error.status === 400) {
        const errMessages = error.errMessages();
        if (errMessages) {
          throw new Error(`The engine rejected the query: ${errMessages.join("; ")}`);
        }
        throw new Error(
          `${error.message}\n\n` +
            unknownGoalNote({ kmId, relationship, goalsFrom: this.goalsFrom, file: !!this.bindableTarget(), target })
        );
      }
      throw error;
    }
  }

  /**
   * Show the engine's reply: the result, or the next question group, after
   * answering "No more" automatically for a group the injected facts cover
   * (QuestionFlow.handleResponse). Never rejects, so start() need not await it.
   */
  private async handleResponse(response: EngineResponse): Promise<void> {
    await this.flow.handleResponse(response);
  }

  /** The question flow's view of this panel: the session, the engine, the webview, the settings, the output channel and the open maps. */
  private questionFlowHost(): QuestionFlowHost {
    return {
      session: () => ({ engine: this.client, sessionId: this.sessionId, record: this.record }),
      post: (message) => this.post(message),
      setting: (name) => vscode.workspace.getConfiguration("rainbird").get(name),
      log: (title, lines) => appendRainbirdLog(title, lines),
      openMaps: () => {
        // The panel's own file first (init opened it, so it is loaded even when no editor shows it), then
        // the visible editors' maps. Platform and snapshot documents are read-only, so they are left out.
        const own = this.bindableTarget()?.toString();
        const docs = [
          ...vscode.workspace.textDocuments.filter((doc) => doc.uri.toString() === own),
          ...vscode.window.visibleTextEditors.map((editor) => editor.document),
        ];
        return docs
          .filter((doc, i) => docs.findIndex((other) => other.uri.toString() === doc.uri.toString()) === i)
          .filter((doc) => doc.languageId === "rblang" && doc.uri.scheme !== PLATFORM_SCHEME && doc.uri.scheme !== SNAPSHOT_SCHEME)
          .map(
            (doc): OpenMap => ({
              name: doc.uri.path.split("/").pop() || doc.uri.toString(),
              text: () => doc.getText(),
              write: (text) => writeDocument(doc, text),
            })
          );
      },
      confirm: async (message, action) => (await vscode.window.showWarningMessage(message, { modal: true }, action)) === action,
      notify: (kind, message) => {
        void (kind === "error" ? vscode.window.showErrorMessage(message) : vscode.window.showWarningMessage(message));
      },
    };
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

  /**
   * The expanded evidence tree for a result: every fact it rests on, fetched once per session and cached.
   * Requests made while it loads (Show evidence, Retry, Explain, Show on graph) share that fetch, which
   * can take up to 200 GETs.
   */
  private async getTree(factId: string): Promise<ExpandedEvidence> {
    const client = this.client;
    const sessionId = this.sessionId;
    const record = this.record;
    if (!client || !sessionId) throw new Error("No active session.");
    const evidenceKey = await getEvidenceKey(this.context);
    const cached = this.trees.get(factId);
    if (cached) return cached;
    // Not a fetch for another session, nor one made with a different evidence key (it may be the locked one).
    const pending = this.treeLoads.get(factId);
    if (pending && pending.sessionId === sessionId && pending.evidenceKey === evidenceKey) return pending.tree;
    const load = { sessionId, evidenceKey, tree: client.fullEvidence(factId, sessionId, evidenceKey) };
    this.treeLoads.set(factId, load);
    try {
      const tree = await load.tree;
      // Not kept when a query started meanwhile (start() replaces the record before the session ID), nor
      // when some facts could not be loaded: the next request tries those again.
      if (this.record === record && this.sessionId === sessionId && !tree.meta?.errors) this.trees.set(factId, tree);
      return tree;
    } finally {
      if (this.treeLoads.get(factId) === load) this.treeLoads.delete(factId);
    }
  }

  /**
   * "Show evidence": the tree as HTML from the shared renderer, for the result's slot in the webview,
   * marked partial when some of its facts could not be loaded. A locked map (401 / 403) gets the locked
   * card, which offers "Set evidence key…"; an expired session (404) says so; any other failure shows its
   * message with Retry.
   */
  private async evidence(factId: string): Promise<void> {
    if (!factId) return;
    const call = (this.evidenceCalls.get(factId) ?? 0) + 1;
    this.evidenceCalls.set(factId, call);
    let reply: { html?: string; partial?: boolean; locked?: boolean; expired?: boolean; error?: string };
    try {
      const tree = await this.getTree(factId);
      reply = { html: renderEvidenceHtml(tree, { toolbar: { studio: true, copyLink: true, openPanel: true } }) };
      if (tree.meta?.errors) reply.partial = true;
    } catch (error) {
      if (this.evidenceLocked(error)) reply = { locked: true };
      else if (this.sessionExpired(error)) reply = { expired: true, error: this.evidenceFailure(error) };
      else reply = { error: (error as Error).message };
    }
    // Superseded, say by the retry after a new evidence key: the newer call answers instead.
    if (this.evidenceCalls.get(factId) === call) this.post({ type: "evidence", factId, ...reply });
  }

  /**
   * Stream a plain-English narrative of why the engine decided this, from the evidence tree, with the
   * source of the panel's own map file. A map chosen by Knowledge Map ID has no file, and gets no source:
   * another open .rbl would be a different map, whose rules the model would then cite.
   */
  private async explain(factId: string): Promise<void> {
    if (!factId) return;
    // The map of the session that produced this result.
    const mapUri = this.targetUri;
    const client = await getAnthropicClient(this.context);
    if (!client) {
      this.post({ type: "explainDelta", factId, text: "No Anthropic API key set — run “Rainbird: Set Anthropic API Key”." });
      // failed: the webview gives the Explain (AI) link back, so it can be clicked again once there is a key.
      this.post({ type: "explainDone", factId, failed: true });
      return;
    }
    let failed = false;
    try {
      const tree = await this.getTree(factId);
      let source = "";
      if (mapUri) {
        // Read even from a hidden tab; platform and snapshot documents are the queried map too.
        let text: string | undefined;
        try {
          text = (await vscode.workspace.openTextDocument(mapUri)).getText();
        } catch {
          // Closed or deleted: explain from the tree alone.
        }
        if (text !== undefined) {
          source = `\n\nThe map's RBLang source (${QueryPanel.baseName(mapUri)}) for reference:\n${text.slice(0, 20000)}`;
        }
      }
      const prompt = `Explain this decision.\n\n${this.evidenceForExplain(tree)}${source}`;
      await streamChat(
        client,
        [{ role: "user", content: prompt }],
        (delta) => this.post({ type: "explainDelta", factId, text: delta }),
        undefined,
        { system: EXPLAIN_SYSTEM_PROMPT, effort: "medium" }
      );
    } catch (error) {
      failed = true;
      this.post({ type: "explainDelta", factId, text: `\n(Explanation failed: ${this.evidenceFailure(error)})` });
    }
    this.post({ type: "explainDone", factId, ...(failed ? { failed: true } : {}) });
  }

  /** Project the evidence for a result onto the graph view. */
  private async overlay(factId: string): Promise<void> {
    if (!factId) return;
    try {
      GraphView.showOverlay(overlayFromEvidence(await this.getTree(factId)));
    } catch (error) {
      this.post({ type: "error", message: `Could not build the graph overlay: ${this.evidenceFailure(error)}` });
    }
  }

  /**
   * The evidence tree's toolbar and the locked card. Open in Studio and Copy link need only the factID
   * and the session, so they work whether or not the tree could be loaded; Open in panel hands over the
   * cached tree (the standalone view fetches it itself when there is none).
   */
  private async evidenceAction(action: string, factId: string): Promise<void> {
    const client = this.client;
    const sessionId = this.sessionId;
    if (!factId || !client || !sessionId) return;
    switch (action) {
      case "openStudio":
      case "copyLink":
        await openOrCopyEvidenceLink(action === "openStudio" ? "open" : "copy", {
          apiUrl: currentApiUrl(),
          factId,
          sessionId,
          usedEvidenceKey: !!(await getEvidenceKey(this.context)),
        });
        return;
      case "openPanel":
        await showEvidenceTree(client, sessionId, factId, () => getEvidenceKey(this.context), this.trees.get(factId));
        return;
      case "setKey":
        await this.unlockEvidence(factId);
        return;
    }
  }

  /**
   * "Set evidence key…" on the locked card: run rainbird.setEvidenceKey and load the tree again only when
   * the stored key changed. Cancelled or unchanged, a retry would hit the same lock: the webview leaves the
   * slot as it is (a tree loaded meanwhile through Retry is kept) and re-enables the card's buttons.
   */
  private async unlockEvidence(factId: string): Promise<void> {
    let changed = false;
    try {
      const before = await getEvidenceKey(this.context);
      await vscode.commands.executeCommand("rainbird.setEvidenceKey");
      changed = (await getEvidenceKey(this.context)) !== before;
    } finally {
      this.post({ type: "evidenceKey", factId, changed });
    }
    if (changed) await this.evidence(factId);
  }

  /** 401 / 403 from the evidence API: the map's Evidence Tree Link is off and the right evidence key was not sent. */
  private evidenceLocked(error: unknown): boolean {
    return error instanceof ApiError && (error.status === 401 || error.status === 403);
  }

  /** 404 from the evidence API: the session has expired (or never had this fact), so retrying cannot help. */
  private sessionExpired(error: unknown): boolean {
    return error instanceof ApiError && error.status === 404;
  }

  /**
   * Why a tree could not be loaded, for Explain, Show on graph and the evidence card. A locked map points
   * at the result's evidence, whose locked card can unlock it; an expired session at a new query.
   */
  private evidenceFailure(error: unknown): string {
    if (this.evidenceLocked(error)) {
      return "Evidence is locked for this map. Unlock it from the result's evidence with Set evidence key… or Retry, then try again.";
    }
    if (this.sessionExpired(error)) return "This session has expired — click “New query” to start again.";
    return (error as Error).message;
  }

  /**
   * The evidence for Explain (AI): the expanded tree as JSON, the shape EXPLAIN_SYSTEM_PROMPT describes.
   * A tree whose JSON would not fit goes as the plain-text outline instead (the one the assistant's
   * get_evidence tool reads): it keeps every condition and input in far fewer characters, where JSON
   * cut off part-way would lose the end of the tree.
   */
  private evidenceForExplain(tree: ExpandedEvidence): string {
    const max = 40000;
    const json = JSON.stringify(tree);
    if (json.length <= max) return `Evidence tree (JSON):\n${json}`;
    return `Evidence tree, as a plain-text outline because its JSON is ${json.length} characters long:\n${describeEvidence(tree, { maxChars: max })}`;
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
