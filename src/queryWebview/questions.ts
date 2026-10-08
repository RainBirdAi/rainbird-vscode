/**
 * Query panel, questions region: the card for each question group, and the
 * host side of the region. The host side is VS Code-free, so it is unit-tested
 * next to the webview behaviour:
 * - decorateQuestions() is what each question carries to the webview;
 * - answersFor() turns the payloads that come back into one checked /response batch;
 * - QuestionFlow runs the region's steps (ask, answer, Back, automatic "No
 *   more" and Answer instead, Make inject-only) against a QuestionFlowHost
 *   that QueryPanel implements with the engine, the webview and VS Code.
 *
 * Controls follow the question's kind (controlKind: yes/no, truth, number,
 * date, string), never whether the engine happened to send concepts: number
 * and date questions always get a typed field, with known values only as
 * suggestions that fill it. A single question answers in one click (typed
 * values with Submit or Enter). A group is a form: its controls hold state,
 * and one "Submit answers" checks every question and sends them together, as
 * the engine requires. Transcript lines are written only once the engine has
 * accepted the answers (the next question group or the result arrives) and
 * dropped when they are rejected.
 *
 * Messages handled: question, autoSkipped, injectOnlyDone, plus result and
 * error to settle the transcript. Messages posted: answer, undo,
 * answerInstead, makeInjectOnly.
 *
 * The script calls the shared helpers base.ts inlines (controlKind,
 * optionsFor, coerceAnswer, parseHumanDate, describeDate, canSkip,
 * skipLabel, …). Its own names stay inside one function, so they cannot
 * collide with the other regions' (all regions share one <script>).
 */
import { ApiError } from "../api";
import type { Answer, EngineResponse, Fact, Question, ResultItem } from "../api";
import { answerFor, canAddHere, coerceAnswer, controlKind, knownSuggestions, optionsFor, readDateOrder, rejectionNote } from "../answers";
import type { AnswerOption, CoerceResult, ControlKind, DateOrder } from "../answers";
import {
  autoSkipPlan,
  canSkip,
  knownEntries,
  nearMiss,
  questionKey,
  readAutoSkipMode,
  skipAnswer,
  skipLabel,
  skipRejectedNote,
  skipTitle,
} from "../questionSkip";
import type { AutoSkipDecision, KnownEntry } from "../questionSkip";
import { buildIndex } from "../mapIndex";
import { applyOperations } from "../mapEdits";

/** One answer as the question card sends it, matched to a question by its position in the group. */
export interface AnswerPayload {
  /** "skip" answers unanswered: true (the card's No more / Keep known answer / Don’t know); "unknown" is its older name. */
  kind: "yesno" | "skip" | "unknown" | "value" | "multi";
  answer?: "yes" | "no";
  /** For a date, the YYYY-MM-DD the card read; the host checks this value and never re-reads `raw`. */
  value?: string;
  values?: string[];
  certainty?: number;
  /** A date answer's text as typed, sent with every date: it pre-fills the card if the answer is rejected. */
  raw?: string;
}

/** What the host adds to each question it posts. The webview works the same fields out itself when one is missing. */
export interface QuestionCardMeta {
  _kind: ControlKind;
  /** De-duplicated, formatted options: a closed choice for string questions, suggestions for number and date questions. */
  _options: AnswerOption[];
  /** Number and date questions: known values offered as fill-in chips. */
  _suggestions: string[];
  /** Whether a value that is not offered may be typed (canAddHere). */
  _canAdd: boolean;
  /** The engine's known answers, marked when this session's injected facts supply them. */
  known: KnownEntry[];
  /** Whether to show the skip button: canSkip(q), unless the engine already refused this question's skip. */
  canSkip: boolean;
  skipLabel: string;
  skipTitle: string;
  /** Facts injected for a name that differs only by case: why they do not cover this question. */
  nearMiss?: string;
  /** Start with the skip chosen (a group member the injected facts cover; the rest of the group still needs answers). */
  preSkip: boolean;
  /** rainbird.query.dateOrder: which reading of an ambiguous numeric date is listed first. */
  dateOrder: DateOrder;
}

export type CardQuestion = Question & QuestionCardMeta;

export interface CardContext {
  /** Facts injected this session. */
  facts?: Fact[];
  /** questionKey()s whose skip the engine refused this session: their skip button is not offered again. */
  refusedSkips?: ReadonlySet<string>;
  /** autoSkipPlan() for the group, in group order. */
  plan?: readonly AutoSkipDecision[];
  dateOrder?: DateOrder;
}

/** The `question` message's questions: each one with the meta its card needs. */
export function decorateQuestions(group: Question[], ctx: CardContext = {}): CardQuestion[] {
  const facts = ctx.facts ?? [];
  return group.map((q, i): CardQuestion => {
    const skippable = canSkip(q) && !(ctx.refusedSkips?.has(questionKey(q)) ?? false);
    const near = nearMiss(q, facts);
    return {
      ...q,
      _kind: controlKind(q),
      _options: optionsFor(q),
      _suggestions: knownSuggestions(q),
      _canAdd: canAddHere(q),
      known: knownEntries(q, facts),
      canSkip: skippable,
      skipLabel: skipLabel(q),
      skipTitle: skipTitle(q),
      ...(near ? { nearMiss: near.message } : {}),
      preSkip: skippable && ctx.plan?.[i]?.skip === true,
      dateOrder: ctx.dateOrder ?? "day-first",
    };
  });
}

/** A value that does not fit its question, found before anything was sent. `index` is the question's position in the group. */
export class AnswerCheckError extends Error {
  constructor(
    message: string,
    readonly index: number
  ) {
    super(message);
    this.name = "AnswerCheckError";
  }
}

/** Whether a payload skips its question (unanswered: true). */
export function isSkipPayload(payload: AnswerPayload | undefined): boolean {
  return !!payload && (payload.kind === "skip" || payload.kind === "unknown");
}

/**
 * Check one picked or typed value for q (coerceAnswer). A value the engine
 * itself offered for a string question is taken as it is: instance names in
 * the map may contain characters a typed answer may not.
 */
export function checkValue(q: Question, raw: unknown, dateOrder?: DateOrder): CoerceResult {
  if (controlKind(q) === "string" && typeof raw === "string") {
    const offered = optionsFor(q).find((o) => o.value === raw);
    if (offered) return { ok: true, value: offered.value };
  }
  return coerceAnswer(q, raw, { dateOrder });
}

/** Certainty 1–100 (the API's range); 100 when the card sent none. */
function certaintyOf(raw: unknown): number {
  const n = typeof raw === "number" ? raw : typeof raw === "string" && raw.trim() !== "" ? Number(raw) : NaN;
  return isFinite(n) ? Math.min(100, Math.max(1, Math.round(n))) : 100;
}

/**
 * One /response batch for a question group from the card's payloads, one per
 * question in group order: a skip becomes skipAnswer(q); every value is
 * checked first (a First Form answer must be yes or no, so answerFor() never
 * throws) and then built with answerFor(). Throws AnswerCheckError, naming
 * the question, for a missing or unfit value — before any API call.
 */
export function answersFor(group: Question[], payloads: readonly (AnswerPayload | undefined)[], dateOrder?: DateOrder): Answer[] {
  const out: Answer[] = [];
  group.forEach((q, index) => {
    const payload = payloads[index];
    if (!payload || typeof payload !== "object") throw new AnswerCheckError("Answer this question.", index);
    if (isSkipPayload(payload)) {
      out.push(skipAnswer(q));
      return;
    }
    const fit = (raw: unknown): string | number | boolean => {
      const checked = checkValue(q, raw, dateOrder);
      if (!checked.ok) throw new AnswerCheckError(checked.error, index);
      return checked.value;
    };
    const certainty = certaintyOf(payload.certainty);
    if (payload.kind === "yesno") {
      out.push(answerFor(q, fit(payload.answer), certainty));
    } else if (payload.kind === "multi") {
      const values = Array.isArray(payload.values) ? payload.values : [];
      if (!values.length) throw new AnswerCheckError("Choose at least one option.", index);
      const seen = new Set<string>();
      for (const raw of values) {
        const value = fit(raw);
        const key = typeof value + ":" + String(value);
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(answerFor(q, value, certainty));
      }
    } else {
      out.push(answerFor(q, fit(payload.value), certainty));
    }
  });
  return out;
}

/** The note when a card could not be sent because a value does not fit: the reason, and in a group which question. */
export function checkNote(group: Question[], error: AnswerCheckError): string {
  const q = group[error.index];
  return group.length > 1 && q ? `“${q.prompt}”: ${error.message}` : error.message;
}

/** GQ-2: a group whose batch the engine rejected. The 400 does not say which answer failed, so every answer is kept. */
export function groupRejectedNote(detail: string): string {
  return `One of these answers was rejected${detail ? ` (${detail})` : ""}. Your answers are kept — fix the one in question and click Submit answers again.`;
}

/**
 * The note on a card asked again because the engine did not reply to its
 * answers (network failure, 5xx): the session may still be alive, so the
 * answers are kept to send again.
 */
export function noReplyNote(detail: string, group: Question[]): string {
  const why = `Rainbird did not reply${detail ? ` (${detail})` : ""}.`;
  return group.length > 1
    ? `${why} Your answers are kept: click Submit answers to send them again.`
    : `${why} Give your answer again to resend it.`;
}

/**
 * The note on a card asked because the engine did not reply to the panel's
 * automatic skip. The covered questions start on the skip, so one click sends
 * it again.
 */
export function autoSkipFailedNote(detail: string, group: Question[]): string {
  const labels = [...new Set(group.map((q) => skipLabel(q)))];
  const label = labels.length === 1 ? labels[0] : "No more";
  const why = `Rainbird did not reply when the panel answered “${label}” for you${detail ? ` (${detail})` : ""}.`;
  return group.length > 1
    ? `${why} The questions start on “${label}”: click Submit answers to send it again, or change an answer first.`
    : `${why} Click “${label}” to send it again, or answer the question.`;
}

/** “a”, “a” and “b”, “a”, “b” and “c” — with the given quotes. */
function listOf(items: readonly string[], open = "“", close = "”"): string {
  const quoted = items.map((item) => open + item + close);
  return quoted.length > 1 ? `${quoted.slice(0, -1).join(", ")} and ${quoted[quoted.length - 1]}` : quoted.join("");
}

/**
 * The note on a card asked again because the engine refused its batch (HTTP
 * 400). When the batch skipped questions a skip is the likely cause (the
 * engine accepts one only with allowUnknown or known answers): the P-1 copy
 * (skipRejectedNote), naming the questions in a group, in the plural when
 * several skips were refused together, and introduced by a sentence of its
 * own when the skips were automatic. Otherwise rejectionNote() for one
 * question, the GQ-2 copy for a group.
 */
export function refusedNote(
  detail: string,
  group: Question[],
  payloads: readonly (AnswerPayload | undefined)[],
  automatic = false
): string {
  const skipped = group.filter((_, i) => isSkipPayload(payloads[i]));
  if (!skipped.length) return group.length === 1 && group[0] ? rejectionNote(detail, group[0]) : groupRejectedNote(detail);
  const labels = [...new Set(skipped.map((q) => skipLabel(q)))];
  const how = labels.length === 1 ? `answered “${labels[0]}”` : "skipped";
  const intro = !automatic ? "" : skipped.length === 1 ? `This question was going to be ${how} automatically. ` : `These questions were going to be ${how} automatically. `;
  const others = skipped.length < group.length;
  if (skipped.length === 1) {
    const q = skipped[0];
    const action = others ? `Answer “${q.prompt}” below instead and click Submit answers again — your other answers are kept.` : "Pick an answer below.";
    return intro + skipRejectedNote(detail, q, action);
  }
  // Several skips refused in one batch: the 400 does not say which, so every one is withdrawn.
  const action = others
    ? `Answer ${listOf(skipped.map((q) => q.prompt))} below instead and click Submit answers again — your other answers are kept.`
    : automatic
      ? "Answer them below, then click Submit answers."
      : "Answer them below instead, then click Submit answers.";
  const rels = [...new Set(skipped.map((q) => q.relationship))];
  const advice =
    rels.length === 1
      ? `If "${rels[0]}" should only ever be fed by injected facts, set askable="none" on it in the map`
      : `If ${listOf(rels, '"', '"')} should only ever be fed by injected facts, set askable="none" on them in the map`;
  return (
    intro +
    `The engine would not let ${automatic ? "them" : "these questions"} be skipped${detail ? ` (${detail})` : ""}. ${action} ` +
    `${advice} — only if every session injects those facts; otherwise rules that need them get no result.`
  );
}

/** One line of the transcript card for an automatic "No more". */
export interface AutoSkipItem {
  prompt: string;
  /** The skip label sent ("No more"). */
  label: string;
  /** "injected": this session's injected facts cover the question; "known": the engine already knew answers. */
  reason: "injected" | "known";
  values: string[];
}

/** The `autoSkipped` message's items for a group answered "No more" automatically. */
export function autoSkipItems(group: Question[], plan: readonly AutoSkipDecision[]): AutoSkipItem[] {
  return group.map((q, i) => ({
    prompt: q.prompt,
    label: skipLabel(q),
    reason: plan[i]?.reason === "known" ? "known" : "injected",
    values: plan[i]?.values ?? [],
  }));
}

/** The confirmation before "Make “<rel>” inject-only…" edits the open map. */
export function injectOnlyPrompt(relationship: string, file: string): string {
  return (
    `Set askable="none" on “${relationship}” in ${file}? Do this only if every session injects these facts; otherwise rules that need them get no result. ` +
    "Push creates a new map (new kmID), or paste the change into Studio and re-publish."
  );
}

/** The confirmation's button. */
export const INJECT_ONLY_ACTION = 'Set askable="none"';

/** A value as indented JSON lines for the Rainbird output channel (rainbird.query.logQuestions). */
export function jsonLines(value: unknown): string[] {
  return (JSON.stringify(value, null, 2) ?? String(value)).split("\n");
}

// ── Host side: the region's steps ──

/** The engine calls the region makes; RainbirdClient has them. */
export interface QuestionEngine {
  respond(sessionId: string, answers: Answer[]): Promise<EngineResponse>;
  undo(sessionId: string): Promise<EngineResponse>;
}

/** What the region reads and writes of the session record (SessionRecord has it). */
export interface QuestionRecord {
  /** One batch per /response call: Save as test and the promotion diff replay them. */
  answers: Answer[][];
  /** Facts injected this session. */
  facts?: Fact[];
  /** The engine's answer to the query; only while the session is finished. */
  results?: ResultItem[];
}

/** An RBLang document in a visible editor: where "Make … inject-only…" changes the map. */
export interface OpenMap {
  /** The file name, for the confirmation and the note on the card. */
  name: string;
  text(): string;
  /** Replace the document's text as one undoable edit, without saving; false when the editor refused it. */
  write(text: string): Promise<boolean>;
}

/** What the region needs from the panel. QueryPanel implements it with the engine, the webview and VS Code; the tests with fakes. */
export interface QuestionFlowHost {
  /** The session as it is now. The setup region replaces it when a query starts: the record first, then the session ID. */
  session(): { engine?: QuestionEngine; sessionId?: string; record?: QuestionRecord };
  /** Post a message to the webview. */
  post(message: Record<string, unknown>): void;
  /** A rainbird.* setting: query.dateOrder, query.autoSkipPluralQuestions or query.logQuestions. */
  setting(name: string): unknown;
  /** A titled block in the Rainbird output channel. */
  log(title: string, lines: string[]): void;
  /** The RBLang documents in visible editors. */
  openMaps(): OpenMap[];
  /** A modal warning with one action button; true when the user chose it. */
  confirm(message: string, action: string): Promise<boolean>;
  /** A notification that needs no answer. */
  notify(kind: "warning" | "error", message: string): void;
}

/** What a question message carries besides the questions: the plan behind preSkip, a note, the rejected answers to pre-fill, and the relationships to offer Make inject-only for. */
interface AskExtra {
  plan?: readonly AutoSkipDecision[];
  note?: string;
  previous?: readonly (AnswerPayload | undefined)[];
  injectOnly?: string[];
}

const SESSION_EXPIRED = "This session has expired — click “New query” to start again.";
/** Automatic "No more" batches in a row before a group is shown anyway: a second guard, after each question being skipped automatically at most once per session. */
const MAX_AUTO_ROUNDS = 20;

function errorDetail(error: ApiError): string {
  return error.errMessages()?.join("; ") ?? error.body.slice(0, 160);
}

/**
 * The questions region's steps, VS Code-free: show the engine's reply (after
 * answering "No more" automatically for a group the injected facts cover,
 * setting rainbird.query.autoSkipPluralQuestions), send a card's answers,
 * step back, Answer instead, and Make inject-only. QueryPanel passes it the
 * webview's messages (onMessage) and the engine's first reply (handleResponse).
 *
 * Every step that waits for the engine checks afterwards that the panel is
 * still on the session and the question group it started from: a new query
 * (or a fresh setup card) may have replaced them meanwhile, and a late reply
 * must not touch the new session's record or post into its flow.
 */
export class QuestionFlow {
  /** The current question group (first question + extraQuestions), in wire order; [] when none is open. */
  questions: Question[] = [];
  /** questionKey()s not to answer "No more" automatically again this session: tried once, refused, stepped back over or answered instead. */
  readonly noAutoSkip = new Set<string>();
  /** questionKey()s whose skip the engine refused this session: their card no longer offers the skip. */
  readonly refusedSkips = new Set<string>();
  /** The latest automatic "No more" batch; Answer instead undoes it while it is still the last batch. */
  private autoBatch?: { answers: Answer[]; keys: string[] };
  /** The session the skip state above belongs to. */
  private skipState?: { record?: QuestionRecord; sessionId?: string };

  constructor(private readonly host: QuestionFlowHost) {}

  /** The region's webview messages; false for any other type. */
  async onMessage(msg: { type?: unknown; [field: string]: unknown }): Promise<boolean> {
    switch (msg.type) {
      case "answer":
        await this.answer(Array.isArray(msg.payloads) ? (msg.payloads as AnswerPayload[]) : [msg.payload as AnswerPayload]);
        return true;
      case "undo":
        await this.undo();
        return true;
      case "answerInstead":
        await this.answerInstead();
        return true;
      case "makeInjectOnly":
        await this.makeInjectOnly(String(msg.relationship ?? ""));
        return true;
    }
    return false;
  }

  /** The payloads as one /response batch for the group (answersFor, with rainbird.query.dateOrder). Throws AnswerCheckError before anything is sent. */
  toAnswers(group: Question[], payloads: readonly (AnswerPayload | undefined)[]): Answer[] {
    return answersFor(group, payloads, this.dateOrder());
  }

  /** One payload per question of the current group, in order; all go out in a single /response call. */
  async answer(payloads: readonly (AnswerPayload | undefined)[]): Promise<void> {
    const { engine, sessionId, record } = this.host.session();
    const group = this.questions;
    if (!engine || !sessionId || !group.length) return;
    let answers: Answer[];
    try {
      answers = this.toAnswers(group, payloads);
    } catch (error) {
      if (!(error instanceof AnswerCheckError)) throw error;
      // Caught before any API call: ask again, keeping what was entered.
      this.postQuestions(group, { note: checkNote(group, error), previous: payloads });
      return;
    }

    this.host.post({ type: "busy" });
    this.logAnswers(answers);
    let response: EngineResponse;
    try {
      response = await engine.respond(sessionId, answers);
    } catch (error) {
      if (!this.stillOn(record, sessionId, group)) return;
      // Only a 400 means "the answer was rejected": ask again with the engine's
      // own validation messages and the answers kept. A 404 means the session
      // is gone: the error card says so. Anything else (network, 5xx) leaves
      // the session possibly alive: ask again with the answers kept, to resend.
      if (error instanceof ApiError && error.status === 400) {
        // A refused batch that skipped questions: the skip is the likely cause, so
        // it is neither offered nor tried automatically again this session.
        const skipped = group.filter((_, i) => isSkipPayload(payloads[i]));
        for (const q of skipped) {
          this.noAutoSkip.add(questionKey(q));
          this.refusedSkips.add(questionKey(q));
        }
        this.postQuestions(group, {
          note: refusedNote(errorDetail(error), group, payloads),
          previous: payloads,
          injectOnly: this.injectOnlyOffers(skipped),
        });
        return;
      }
      if (error instanceof ApiError && error.status === 404) {
        this.sessionGone();
        throw new Error(SESSION_EXPIRED);
      }
      // Nothing recorded, and the group stays open: ▶ still asks before replacing a session that may be alive.
      this.postQuestions(group, { note: noReplyNote((error as Error).message, group), previous: payloads });
      return;
    }
    if (!this.stillOn(record, sessionId, group)) return;
    record?.answers.push(answers);
    await this.handleResponse(response);
  }

  /**
   * POST /undo: step the session back one batch; the engine asks again (or
   * decides again). When it cannot step back, what Back removed from the page
   * is shown again under the error: the question group, or the result.
   */
  async undo(): Promise<void> {
    const { engine, sessionId, record } = this.host.session();
    if (!engine || !sessionId) return;
    const before = this.questions;
    this.host.post({ type: "busy" });
    let response: EngineResponse;
    try {
      response = await engine.undo(sessionId);
    } catch (error) {
      if (!this.stillOn(record, sessionId, before)) return;
      if (error instanceof ApiError && error.status === 404) {
        this.sessionGone();
        throw new Error(SESSION_EXPIRED);
      }
      if (error instanceof ApiError && error.status === 400) {
        this.host.post({ type: "error", message: `The engine could not undo: ${errorDetail(error) || "nothing to undo"}.` });
      } else {
        const detail = (error as Error).message;
        this.host.post({ type: "error", message: `Could not step back: Rainbird did not reply${detail ? ` (${detail})` : ""}.` });
      }
      // Back removed the card: put back the question group, or the result with its actions (a result the engine
      // answered straight from /query has nothing to undo).
      if (before.length) this.postQuestions(before);
      else if (record?.results) this.host.post({ type: "result", results: record.results, sessionId });
      return;
    }
    if (!this.stillOn(record, sessionId, before)) return;
    // Stepping back over a skip must not skip it again by itself: the question is asked.
    for (const a of record?.answers.pop() ?? []) {
      if (a.unanswered) this.noAutoSkip.add(questionKey(a));
    }
    this.autoBatch = undefined;
    await this.handleResponse(response);
  }

  /**
   * Show the engine's reply: the result, or the next question group. A group
   * whose every question the injected facts cover is answered "No more" here,
   * without a card, and the engine's reply to that is handled the same way.
   * Never rejects, so callers need not await it: failures become an error card
   * (or, when the engine did not reply to the automatic answer, the group's card).
   */
  async handleResponse(response: EngineResponse): Promise<void> {
    const { sessionId, record } = this.host.session();
    if (this.skipState?.record !== record || this.skipState?.sessionId !== sessionId) {
      // A new session: the previous session's skip state does not apply.
      this.skipState = { record, sessionId };
      this.noAutoSkip.clear();
      this.refusedSkips.clear();
      this.autoBatch = undefined;
    }
    try {
      let next: EngineResponse | undefined = response;
      // Every automatic skip adds its questions to noAutoSkip, so the loop ends; the round cap is a second guard.
      for (let round = 0; next && this.isCurrent(record, sessionId); round++) {
        if (next.kind !== "question") {
          this.questions = [];
          if (record) record.results = next.result;
          this.host.post({ type: "result", results: next.result, sessionId });
          return;
        }
        const group = [next.question, ...(next.extraQuestions ?? [])];
        this.questions = group;
        // Asked again (after Back or Answer instead): the session is not finished, so an earlier result is not its result.
        if (record) delete record.results;
        if (this.logging()) this.host.log("Question", jsonLines({ question: next.question, extraQuestions: next.extraQuestions ?? [] }));
        const plan = this.autoSkipPlanFor(group);
        const automatic = plan.every((decision) => decision.skip) && round < MAX_AUTO_ROUNDS && !!this.host.session().engine && !!sessionId;
        if (!automatic) {
          // Members the injected facts cover start on "No more"; a partial batch is never sent.
          this.postQuestions(group, { plan });
          return;
        }
        next = await this.autoSkip(group, plan);
      }
    } catch (error) {
      if (!this.isCurrent(record, sessionId)) return;
      const expired = error instanceof ApiError && error.status === 404;
      if (expired) this.sessionGone();
      this.host.post({ type: "error", message: expired ? SESSION_EXPIRED : (error as Error).message });
    }
  }

  /** Post a question group with each question's card meta (decorateQuestions): every question message goes through here. */
  postQuestions(group: Question[], extra: AskExtra = {}): void {
    const { plan, injectOnly, ...rest } = extra;
    this.host.post({
      type: "question",
      questions: decorateQuestions(group, {
        facts: this.host.session().record?.facts ?? [],
        refusedSkips: this.refusedSkips,
        plan: plan ?? this.autoSkipPlanFor(group),
        dateOrder: this.dateOrder(),
      }),
      ...rest,
      ...(injectOnly?.length ? { injectOnly } : {}),
    });
  }

  /** "Answer instead" on an automatic "No more": undo that batch and ask its questions, this time without the automatic answer. */
  async answerInstead(): Promise<void> {
    const { sessionId, record } = this.host.session();
    const auto = this.autoBatch;
    const batches = record?.answers ?? [];
    if (!auto || batches[batches.length - 1] !== auto.answers) {
      // Only while the automatic batch is the latest step (the webview disables the link otherwise): restore what was showing.
      this.host.post({ type: "error", message: "That automatic answer is no longer the latest step. Use Back to step back to it." });
      if (this.questions.length) this.postQuestions(this.questions);
      else if (record?.results) this.host.post({ type: "result", results: record.results, sessionId });
      return;
    }
    auto.keys.forEach((key) => this.noAutoSkip.add(key));
    await this.undo();
  }

  /**
   * P-5: after the engine refused a skip, set askable="none" on the
   * relationship in the open map, so the engine never asks it — one undoable
   * edit, not saved, after a confirmation that says what that costs.
   */
  async makeInjectOnly(relationship: string): Promise<void> {
    if (!relationship) return;
    const map = this.mapDeclaring(relationship);
    if (!map) {
      this.host.notify("warning", `Open the RBLang file that declares “${relationship}” beside the query panel, then try again.`);
      return;
    }
    if (!(await this.host.confirm(injectOnlyPrompt(relationship, map.name), INJECT_ONLY_ACTION))) return;
    let text: string;
    try {
      text = applyOperations(map.text(), [
        { op: "set_attribute", selector: { kind: "rel", name: relationship }, attr: "askable", value: "none" },
      ]).text;
    } catch (error) {
      this.host.notify("error", `Could not set askable="none" on “${relationship}”: ${(error as Error).message}`);
      return;
    }
    if (!(await map.write(text))) {
      this.host.notify("error", `VS Code could not change ${map.name}.`);
      return;
    }
    this.host.post({ type: "injectOnlyDone", relationship, file: map.name });
  }

  /**
   * Answer "No more" for a whole group: one ordinary batch, recorded like any
   * other and shown in the transcript with Answer instead. Returns the
   * engine's reply, or undefined when there is nothing more to do here: the
   * engine refused the skip (then the group is asked, with the skip
   * withdrawn), it did not reply (then the group is asked, starting on the
   * skip, to send again), or the panel moved on meanwhile. A 404 is thrown
   * for handleResponse to report.
   */
  private async autoSkip(group: Question[], plan: readonly AutoSkipDecision[]): Promise<EngineResponse | undefined> {
    const { engine, sessionId, record } = this.host.session();
    if (!engine || !sessionId) return undefined;
    const answers = group.map((q) => skipAnswer(q));
    const keys = group.map((q) => questionKey(q));
    // At most once per question and session: if the engine asks it again, it is shown.
    keys.forEach((key) => this.noAutoSkip.add(key));
    this.logAnswers(answers);
    let reply: EngineResponse;
    try {
      reply = await engine.respond(sessionId, answers);
    } catch (error) {
      if (!this.stillOn(record, sessionId, group)) return undefined;
      if (error instanceof ApiError && error.status === 400) {
        keys.forEach((key) => this.refusedSkips.add(key));
        this.postQuestions(group, {
          note: refusedNote(errorDetail(error), group, group.map(() => ({ kind: "skip" as const })), true),
          injectOnly: this.injectOnlyOffers(group),
        });
        return undefined;
      }
      if (error instanceof ApiError && error.status === 404) throw error;
      // No reply: nothing recorded, and the session may still be alive. A question message (not an error) also writes the
      // transcript line of the answer the engine accepted just before.
      this.postQuestions(group, { plan, note: autoSkipFailedNote((error as Error).message, group) });
      return undefined;
    }
    if (!this.stillOn(record, sessionId, group)) return undefined;
    record?.answers.push(answers);
    this.autoBatch = { answers, keys };
    this.host.post({ type: "autoSkipped", items: autoSkipItems(group, plan) });
    return reply;
  }

  /**
   * The engine no longer knows the session (404): no question group is open
   * any more, so ▶ starts a new query without asking about this one, and
   * Answer instead has nothing left to undo.
   */
  private sessionGone(): void {
    this.questions = [];
    this.autoBatch = undefined;
  }

  /** Whether the panel is still on this session: start() replaces the record, then the session ID. */
  private isCurrent(record: QuestionRecord | undefined, sessionId: string | undefined): boolean {
    const now = this.host.session();
    return now.record === record && now.sessionId === sessionId;
  }

  /** isCurrent, and the question group is still the one a step started from (a fresh setup card clears it). */
  private stillOn(record: QuestionRecord | undefined, sessionId: string | undefined, group: Question[]): boolean {
    return this.isCurrent(record, sessionId) && this.questions === group;
  }

  /** Which questions of a group to answer "No more" automatically (autoSkipPlan, per the setting). */
  private autoSkipPlanFor(group: Question[]): AutoSkipDecision[] {
    return autoSkipPlan(group, {
      mode: readAutoSkipMode(this.host.setting("query.autoSkipPluralQuestions")),
      injected: this.host.session().record?.facts ?? [],
      noAutoSkip: this.noAutoSkip,
    });
  }

  private dateOrder(): DateOrder {
    return readDateOrder(this.host.setting("query.dateOrder"));
  }

  /** rainbird.query.logQuestions: the raw questions and the answers sent go to the Rainbird output channel. */
  private logging(): boolean {
    return this.host.setting("query.logQuestions") === true;
  }

  private logAnswers(answers: Answer[]): void {
    if (this.logging()) this.host.log("Response sent", jsonLines(answers));
  }

  /** The first open map that declares the relationship: where "Make … inject-only…" edits and the change can be seen. */
  private mapDeclaring(relationship: string): OpenMap | undefined {
    return this.host.openMaps().find((map) => buildIndex(map.text()).relationships.has(relationship));
  }

  /** The relationships of these questions that an open map declares: the refusal note offers "Make … inject-only…" for them. */
  private injectOnlyOffers(questions: Question[]): string[] {
    return [...new Set(questions.map((q) => q.relationship))].filter((rel) => this.mapDeclaring(rel) !== undefined);
  }
}

export const QUESTIONS_CSS = /* css */ `
  .chip { border-radius: 12px; }
  .qcard .ctl button.on { background: var(--vscode-button-background); color: var(--vscode-button-foreground);
                          box-shadow: inset 0 0 0 1px var(--vscode-focusBorder); }
  .qcard .chip.known:disabled { opacity: .8; cursor: default; }
  .qcard .chips:empty { display: none; }
  .qcard .cfrow { display: flex; align-items: center; gap: .6rem; margin: .45rem 0 .35rem; font-size: .85em; }
  .qcard .cfrow input { flex: 1; }
  .qcard .q.sub { border-top: 1px solid var(--vscode-panel-border); padding-top: .55rem; margin-top: .55rem; }
  .qcard .q.sub .prompt { font-weight: 500; }
  .qcard .q.missing > .prompt { color: var(--vscode-errorForeground); }
  .qcard .q:focus { outline: none; }
  .qcard .note { font-size: .82em; margin-bottom: .5rem; line-height: 1.4; }
  .qcard .noteacts { margin: -.2rem 0 .5rem; }
  .qcard .knownLine { font-size: .82em; opacity: .8; margin: -.3rem 0 .5rem; }
  .qcard .nearmiss { font-size: .82em; margin: -.3rem 0 .5rem; color: var(--vscode-editorWarning-foreground); }
  .qcard .miss { font-size: .82em; margin-top: .3rem; }
  .qcard .groupErr { font-size: .82em; }
  .qcard .actions { margin-top: .55rem; }
  .qcard .filter { margin-bottom: .4rem; }
  .qcard .addrow, .qcard .daterow { display: flex; gap: .4rem; align-items: center; }
  .qcard .addrow input, .qcard .daterow input.val { flex: 1; min-width: 0; }
  .qcard .daterow input.cal { width: auto; flex: 0 0 auto; }
  .qcard .preview.bad { color: var(--vscode-errorForeground); opacity: 1; }
  .qcard .preview .datechoice { padding: .15rem .6rem; }
  .qcard .sugg { font-size: .8em; margin-top: .35rem; display: flex; flex-wrap: wrap; align-items: center; gap: .15rem .3rem; }
  .qcard .sugg span { opacity: .7; }
  .qcard .sugg .fill { padding: .05rem .55rem; margin: 0; border-radius: 10px; }
  .transcript.auto .linkish { background: none; padding: 0; margin: .2rem 0 0; color: var(--vscode-textLink-foreground); font-size: inherit; }
  .transcript.auto .linkish:hover { background: none; text-decoration: underline; }
  .transcript.auto .linkish:disabled { color: inherit; text-decoration: none; }
`;

export const QUESTIONS_SCRIPT = /* js */ `
  (function () {
    const hints = answerHints();
    // The transcript lines of the last submitted card ({ slot, lines }), kept aside until the engine accepts the answers.
    let pendingAnswers = null;
    // The transcript card of the latest automatic "No more", while Answer instead may still undo it.
    let liveAuto = null;
    let liveAutoReplies = 0;

    function cfControl(q) {
      return q.allowCF
        ? '<div class="cfrow"><span>Certainty</span><input type="range" class="cf" min="1" max="100" value="100" aria-label="Certainty"><span class="cfv">100%</span></div>'
        : '';
    }
    function readCf(block) {
      const cf = block.querySelector('.cf');
      return cf ? Number(cf.value) : 100;
    }
    function describeAnswer(text, payload) {
      return text + (payload.certainty !== undefined && payload.certainty !== 100 ? ' (' + payload.certainty + '%)' : '');
    }
    function transcriptLine(label, text) {
      return el('<div class="transcript"><b>' + esc(label) + ':</b> ' + esc(text) + '</div>');
    }
    function insertBeforeBusy(node) {
      if (busyEl && busyEl.parentNode === flow) flow.insertBefore(node, busyEl);
      else flow.appendChild(node);
    }

    // ── Transcript of a submitted card: written where the card was once the engine moves on, dropped on a rejection ──
    function flushPending() {
      const p = pendingAnswers;
      pendingAnswers = null;
      if (!p) return;
      const parent = p.slot.parentNode;
      if (parent) p.lines.forEach(line => parent.insertBefore(transcriptLine(line[0], line[1]), p.slot));
      p.slot.remove();
    }
    function dropPending() {
      if (pendingAnswers) pendingAnswers.slot.remove();
      pendingAnswers = null;
    }

    // ── Answer instead: only while the automatic batch is the latest step ──
    function retireAuto() {
      if (!liveAuto) return;
      liveAuto.querySelectorAll('[data-instead]').forEach(b => {
        b.disabled = true;
        b.title = 'No longer available: this automatic answer is no longer the latest step.';
      });
      liveAuto = null;
    }
    // The first question or result after the card is the engine's reply to the automatic batch: Answer instead opens then.
    function noteReply() {
      if (liveAuto && !liveAuto.isConnected) liveAuto = null; // a new query cleared the transcript
      if (!liveAuto) return;
      liveAutoReplies++;
      if (liveAutoReplies > 1) { retireAuto(); return; }
      liveAuto.querySelectorAll('[data-instead]').forEach(b => {
        b.disabled = false;
        b.title = 'Undo this automatic answer and ask the question';
      });
    }

    // ── Question meta: decorated by the host, worked out here when absent ──
    function knownList(q) {
      const asksSubject = q.type === 'Second Form Subject';
      const seen = new Set();
      const out = [];
      readKnownAnswers(q).forEach(k => {
        const raw = asksSubject ? k.subject : k.object;
        if (raw === undefined) return;
        const value = formatValue(asksSubject ? 'string' : q.dataType, raw);
        if (!value || seen.has(value)) return;
        seen.add(value);
        out.push({ value: value, certainty: k.certainty, injected: false });
      });
      return out;
    }
    function cardMeta(q) {
      return {
        kind: q._kind || controlKind(q),
        options: Array.isArray(q._options) ? q._options : optionsFor(q),
        suggestions: Array.isArray(q._suggestions) ? q._suggestions : knownSuggestions(q),
        canAdd: typeof q._canAdd === 'boolean' ? q._canAdd : canAddHere(q),
        known: Array.isArray(q.known) ? q.known : knownList(q),
        skippable: typeof q.canSkip === 'boolean' ? q.canSkip : canSkip(q),
        skipLabel: q.skipLabel || skipLabel(q),
        skipTitle: q.skipTitle || skipTitle(q),
        nearMiss: q.nearMiss || '',
        preSkip: q.preSkip === true,
        dateOrder: q.dateOrder === 'month-first' ? 'month-first' : 'day-first',
      };
    }
    function knownText(k) {
      const notes = [];
      if (k.injected) notes.push('injected');
      if (typeof k.certainty === 'number' && k.certainty < 100) notes.push(k.certainty + '%');
      return String(k.value) + (notes.length ? ' (' + notes.join(', ') + ')' : '');
    }

    // ── Markup ──
    function filterBox(n) {
      return '<input type="text" class="filter" autocomplete="off" placeholder="Filter ' + n + ' options…" aria-label="Filter the options">';
    }
    function actionsRow(inner) {
      return inner ? '<div class="actions">' + inner + '</div>' : '';
    }
    function suggestionsHtml(m) {
      const values = (m.suggestions || []).slice(0, 12);
      return values.length
        ? '<div class="sugg"><span>Suggestions:</span>' + values.map(v => '<button class="fill" data-fill="' + esc(v) + '" title="Fill in ' + esc(v) + '">' + esc(v) + '</button>').join('') + '</div>'
        : '';
    }
    // A group's buttons are toggles (aria-pressed); a single question's buttons answer at once.
    function stringControls(q, m, single, toggle, cf, skip, submit) {
      const opts = m.options;
      // A typed answer only where the map takes new values — or when the engine listed nothing to pick (it may not have listed the instances).
      const open = m.canAdd || !(q.concepts && q.concepts.length) || !opts.length;
      if (q.plural) {
        const knownValues = m.known.map(k => String(k.value));
        const locked = m.known.map(k => '<button class="chip on known" data-known="1" disabled aria-pressed="true" title="Already known: the engine keeps it, so it is not sent again">✓ ' + esc(k.value) + '</button>');
        const free = opts.filter(o => knownValues.indexOf(o.value) === -1);
        return (free.length > 8 ? filterBox(free.length) : '')
          + '<div class="chips">' + locked.join('') + free.map(o => '<button class="chip" data-opt="' + esc(o.value) + '" aria-pressed="false">' + esc(o.label) + '</button>').join('') + '</div>'
          + (open
            ? (locked.length || free.length ? '<label>Or something else</label>' : '')
              + '<div class="addrow"><input type="text" class="other" autocomplete="off" aria-label="' + esc(q.prompt) + '" placeholder="' + (locked.length || free.length ? 'Type another value…' : esc(hints.stringPlaceholder)) + '"><button data-act="add">Add</button></div>'
            : '')
          + cf + actionsRow(submit + skip);
      }
      if (!opts.length) {
        return '<input type="text" class="val" autocomplete="off" aria-label="' + esc(q.prompt) + '" placeholder="' + esc(hints.stringPlaceholder) + '">'
          + cf + actionsRow(submit + skip);
      }
      return (opts.length > 8 ? filterBox(opts.length) : '')
        + '<div class="choices">' + opts.map(o => '<button data-pick="' + esc(o.value) + '"' + toggle + '>' + esc(o.label) + '</button>').join('') + '</div>'
        + (open ? '<label>Or something else</label><input type="text" class="other" autocomplete="off" aria-label="' + esc(q.prompt) + '" placeholder="Type your own answer…">' : '')
        + cf + actionsRow((open ? submit : '') + skip);
    }
    function controlsHtml(q, m, single) {
      const toggle = single ? '' : ' aria-pressed="false"';
      // Yes / No and True / False look alike: a highlighted button would read as the recommended answer.
      const skip = m.skippable ? '<button class="skip" data-skip="1"' + toggle + ' title="' + esc(m.skipTitle) + '">' + esc(m.skipLabel) + '</button>' : '';
      const submit = single ? '<button class="primary" data-act="submit">Submit</button>' : '';
      const cf = cfControl(q);
      if (m.kind === 'yesno') {
        return cf + '<div class="choices"><button data-yn="yes"' + toggle + '>Yes</button><button data-yn="no"' + toggle + '>No</button>' + skip + '</div>';
      }
      if (m.kind === 'truth') {
        return cf + '<div class="choices"><button data-truth="true"' + toggle + '>True</button><button data-truth="false"' + toggle + '>False</button>' + skip + '</div>';
      }
      if (m.kind === 'number') {
        return '<input type="text" class="val num" inputmode="decimal" autocomplete="off" aria-label="' + esc(q.prompt) + '" placeholder="' + esc(hints.numberPlaceholder) + '">'
          + suggestionsHtml(m)
          + '<div class="hint">' + esc(hints.number) + '</div>'
          + cf + actionsRow(submit + skip);
      }
      if (m.kind === 'date') {
        return '<div class="daterow"><input type="text" class="val date" autocomplete="off" aria-label="' + esc(q.prompt) + '" placeholder="' + esc(hints.datePlaceholder) + '">'
          + '<input type="date" class="cal" title="Pick from a calendar" aria-label="Pick the date from a calendar"></div>'
          + '<div class="preview hint" aria-live="polite"></div>'
          + suggestionsHtml(m)
          + cf + actionsRow((single ? '<button class="primary" data-act="submit" disabled>Submit</button>' : '') + skip);
      }
      return stringControls(q, m, single, toggle, cf, skip, submit);
    }
    function blockHtml(q, m, i, single) {
      return '<div class="q' + (single ? '' : ' sub') + '" data-i="' + i + '" role="group" aria-label="' + esc(q.prompt) + '">'
        + '<div class="prompt">' + esc(q.prompt) + '</div>'
        + (m.known.length ? '<div class="knownLine">Already known: ' + esc(m.known.map(knownText).join(', ')) + '</div>' : '')
        + (m.nearMiss ? '<div class="nearmiss">' + esc(m.nearMiss) + '</div>' : '')
        + '<div class="ctl">' + controlsHtml(q, m, single) + '</div>'
        + '<div class="miss err" aria-live="polite"></div>'
        + '</div>';
    }

    // One card per question group.
    function questionCard(msg) {
      const questions = Array.isArray(msg.questions) ? msg.questions : msg.question ? [msg.question] : [];
      if (!questions.length) return;
      clearBusy();
      const single = questions.length === 1;
      const metas = questions.map(cardMeta);
      const offers = Array.isArray(msg.injectOnly) ? msg.injectOnly : [];
      const card = el('<div class="card qcard">'
        + (msg.note ? '<div class="err note">' + esc(msg.note) + '</div>' : '')
        + (offers.length ? '<div class="noteacts">' + offers.map(rel => '<button data-injectonly="' + esc(rel) + '">Make “' + esc(rel) + '” inject-only…</button>').join('') + '</div>' : '')
        + (single ? '' : '<div class="prompt">' + questions.length + ' related questions — answer each one, then click Submit answers</div>')
        + questions.map((q, i) => blockHtml(q, metas[i], i, single)).join('')
        + '<div class="foot">'
        + (single ? '' : '<button class="primary submitAll">Submit answers</button><span class="groupErr err" aria-live="polite"></span>')
        + '<button class="back" title="Undo the previous answer">↶ Back</button></div>'
        + '</div>');
      flow.appendChild(card);
      card.scrollIntoView({ block: 'end' });
      const entries = questions.map((q, i) => ({ q: q, m: metas[i], block: card.querySelector('.q[data-i="' + i + '"]') }));
      const entryOf = node => {
        const block = node && node.closest ? node.closest('.q') : null;
        return block ? entries[Number(block.dataset.i)] : null;
      };
      const ok = (text, payload) => ({ ok: true, text: text, payload: payload });

      // ── State of one question ──
      function syncAria(entry) {
        entry.block.querySelectorAll('button[aria-pressed]').forEach(b => {
          if (!b.hasAttribute('data-known')) b.setAttribute('aria-pressed', b.classList.contains('on') ? 'true' : 'false');
        });
      }
      function say(entry, message) {
        entry.block.querySelector('.miss').textContent = message;
      }
      function showMiss(entry, message) {
        entry.block.classList.add('missing');
        say(entry, message);
      }
      function clearMiss(entry) {
        entry.block.classList.remove('missing');
        say(entry, '');
        const err = card.querySelector('.groupErr');
        if (err && err.textContent) {
          const left = card.querySelectorAll('.q.missing').length;
          err.textContent = !left ? '' : left === 1 ? '1 question still needs an answer.' : left + ' questions still need an answer.';
        }
      }
      function unskip(entry) {
        const skip = entry.block.querySelector('[data-skip].on');
        if (skip) skip.classList.remove('on');
      }
      function clearChoices(entry) {
        const b = entry.block;
        b.querySelectorAll('[data-yn],[data-truth],[data-pick],[data-opt]').forEach(x => x.classList.remove('on'));
        b.querySelectorAll('.added').forEach(x => x.remove());
        b.querySelectorAll('input.val, input.other, input.cal').forEach(x => { x.value = ''; });
        updatePreview(entry);
      }
      // Group cards: Yes/No, True/False and picks act like radio buttons, chips toggle, and the skip button clears the question's other choices.
      function choose(entry, btn) {
        const b = entry.block;
        if (btn.hasAttribute('data-skip')) {
          const turnOn = !btn.classList.contains('on');
          if (turnOn) clearChoices(entry);
          btn.classList.toggle('on', turnOn);
        } else {
          unskip(entry);
          if (btn.hasAttribute('data-opt')) {
            btn.classList.toggle('on');
          } else {
            const was = btn.classList.contains('on');
            b.querySelectorAll('[data-yn],[data-truth],[data-pick]').forEach(x => x.classList.remove('on'));
            btn.classList.toggle('on', !was);
            if (btn.hasAttribute('data-pick')) { const other = b.querySelector('input.other'); if (other) other.value = ''; }
          }
        }
        syncAria(entry);
        clearMiss(entry);
      }
      function press(entry, btn) {
        if (btn && !btn.classList.contains('on')) choose(entry, btn);
      }
      // Typing counts as choosing: it clears the skip and, for a single-valued question, the picked option.
      function typed(entry, input) {
        unskip(entry);
        if (input && input.classList.contains('other') && !entry.q.plural) entry.block.querySelectorAll('[data-pick].on').forEach(x => x.classList.remove('on'));
        syncAria(entry);
        clearMiss(entry);
      }
      function isKnown(entry, value) {
        return entry.m.known.some(k => String(k.value) === value);
      }
      function addChip(entry, value) {
        const box = entry.block.querySelector('.chips');
        if (!box) return;
        box.appendChild(el('<button class="chip on added" data-opt="' + esc(value) + '" aria-pressed="true">' + esc(value) + '</button>'));
        unskip(entry);
        syncAria(entry);
        clearMiss(entry);
      }
      // Plural questions: "Or something else" adds a chip.
      function addOther(entry) {
        const input = entry.block.querySelector('input.other');
        const text = input ? input.value.trim() : '';
        if (!text) return;
        const checked = coerceAnswer(entry.q, text, {});
        if (!checked.ok) { showMiss(entry, checked.error); return; }
        const value = String(checked.value);
        input.value = '';
        if (isKnown(entry, value)) { say(entry, value + ' is already known.'); return; }
        const existing = [...entry.block.querySelectorAll('[data-opt]')].find(c => c.getAttribute('data-opt') === value);
        if (existing) press(entry, existing);
        else addChip(entry, value);
      }
      function fill(entry, value) {
        const input = entry.block.querySelector('input.val');
        if (!input) return;
        input.value = value;
        updatePreview(entry);
        typed(entry, input);
        input.focus();
      }
      // Dates: a live reading of what was typed. An ambiguous numeric date offers both readings and blocks Submit until one is chosen.
      function updatePreview(entry) {
        const b = entry.block;
        const input = b.querySelector('input.val.date');
        const out = b.querySelector('.preview');
        if (!input || !out) return;
        const text = input.value.trim();
        const parsed = text ? parseHumanDate(text, entry.m.dateOrder) : null;
        out.classList.toggle('bad', !!(parsed && parsed.error));
        out.innerHTML = !parsed ? ''
          : parsed.iso ? esc('Will send ' + parsed.iso + ' (' + describeDate(parsed.iso) + ')')
          : parsed.ambiguous ? '<span>Which date do you mean?</span> ' + parsed.ambiguous.map(d => '<button class="datechoice" data-iso="' + esc(d) + '">' + esc(describeDate(d, false)) + '</button>').join('')
          : esc(parsed.error);
        const cal = b.querySelector('input.cal');
        if (cal) cal.value = parsed && parsed.iso ? parsed.iso : '';
        const submit = b.querySelector('[data-act="submit"]');
        if (submit) submit.disabled = !(parsed && parsed.iso);
      }
      function applyFilter(entry, text) {
        const words = text.toLowerCase().split(' ').filter(Boolean);
        entry.block.querySelectorAll('[data-pick],[data-opt]').forEach(btn => {
          const label = btn.textContent.toLowerCase();
          // A chosen option stays visible whatever the filter says.
          btn.hidden = !btn.classList.contains('on') && !words.every(w => label.indexOf(w) !== -1);
        });
      }

      // ── Reading an answer ──
      function missing(entry) {
        const chips = entry.m.kind === 'string' && entry.q.plural && entry.block.querySelector('[data-opt]');
        const message = chips ? 'Choose at least one option.'
          : 'Answer this question' + (entry.m.skippable ? ', or choose “' + entry.m.skipLabel + '”' : '') + '.';
        return { ok: false, empty: true, message: message };
      }
      function readTyped(entry, cf) {
        const input = entry.block.querySelector('input.val, input.other');
        const text = input ? input.value.trim() : '';
        if (!text) return missing(entry);
        const checked = coerceAnswer(entry.q, text, { dateOrder: entry.m.dateOrder });
        return checked.ok ? ok(text, { kind: 'value', value: text, certainty: cf }) : { ok: false, message: checked.error };
      }
      function readDate(entry, cf) {
        const input = entry.block.querySelector('input.val.date');
        const text = input ? input.value.trim() : '';
        if (!text) return missing(entry);
        const parsed = parseHumanDate(text, entry.m.dateOrder);
        if (parsed.iso) return ok(text === parsed.iso ? text : text + ' → ' + parsed.iso, { kind: 'value', value: parsed.iso, raw: text, certainty: cf });
        if (parsed.ambiguous) return { ok: false, message: 'Choose which date you mean: ' + describeDate(parsed.ambiguous[0], false) + ' or ' + describeDate(parsed.ambiguous[1], false) + '.' };
        return { ok: false, message: parsed.error };
      }
      function readChips(entry, cf) {
        const values = [];
        entry.block.querySelectorAll('[data-opt].on').forEach(c => values.push(c.getAttribute('data-opt')));
        const other = entry.block.querySelector('input.other');
        const text = other ? other.value.trim() : '';
        if (text) {
          // Typed but not added yet: it counts.
          const checked = coerceAnswer(entry.q, text, {});
          if (!checked.ok) return { ok: false, message: checked.error };
          const value = String(checked.value);
          if (values.indexOf(value) === -1 && !isKnown(entry, value)) values.push(value);
        }
        return values.length ? ok(values.join(', '), { kind: 'multi', values: values, certainty: cf }) : missing(entry);
      }
      function readAnswer(entry) {
        const b = entry.block, m = entry.m, cf = readCf(b);
        if (b.querySelector('[data-skip].on')) return ok(m.skipLabel, { kind: 'skip' });
        if (m.kind === 'yesno') {
          const on = b.querySelector('[data-yn].on');
          return on ? ok(on.textContent, { kind: 'yesno', answer: on.getAttribute('data-yn'), certainty: cf }) : missing(entry);
        }
        if (m.kind === 'truth') {
          const on = b.querySelector('[data-truth].on');
          return on ? ok(on.textContent, { kind: 'value', value: on.getAttribute('data-truth'), certainty: cf }) : missing(entry);
        }
        if (m.kind === 'date') return readDate(entry, cf);
        if (m.kind === 'string' && entry.q.plural) return readChips(entry, cf);
        const pick = b.querySelector('[data-pick].on');
        if (pick) return ok(pick.textContent, { kind: 'value', value: pick.getAttribute('data-pick'), certainty: cf });
        return readTyped(entry, cf);
      }

      // ── Sending ──
      function send(answers) {
        // A new step: an automatic answer before it is no longer the latest, even before the host says busy.
        retireAuto();
        dropPending();
        const slot = el('<div class="pendingAnswers" hidden></div>');
        flow.insertBefore(slot, card);
        card.remove();
        pendingAnswers = { slot: slot, lines: answers.map((a, i) => [questions[i].prompt, describeAnswer(a.text, a.payload)]) };
        vscode.postMessage({ type: 'answer', payloads: answers.map(a => a.payload) });
      }
      // A single question's buttons answer at once.
      function sendNow(entry, btn) {
        const cf = readCf(entry.block);
        if (btn.hasAttribute('data-skip')) send([ok(entry.m.skipLabel, { kind: 'skip' })]);
        else if (btn.hasAttribute('data-yn')) send([ok(btn.textContent, { kind: 'yesno', answer: btn.getAttribute('data-yn'), certainty: cf })]);
        else if (btn.hasAttribute('data-truth')) send([ok(btn.textContent, { kind: 'value', value: btn.getAttribute('data-truth'), certainty: cf })]);
        else send([ok(btn.textContent, { kind: 'value', value: btn.getAttribute('data-pick'), certainty: cf })]);
      }
      // A field takes the focus. A question answered only with buttons focuses the question itself, not its first button:
      // a focused Yes, True or first option would look like the recommended answer. Tab then reaches the buttons.
      function focusInto(entry) {
        const b = entry.block;
        const target = b.querySelector('input.filter') || b.querySelector('input.val, input.other');
        if (target) { target.focus(); return; }
        b.setAttribute('tabindex', '-1');
        b.focus({ preventScroll: true });
      }
      function submitSingle(entry) {
        const answer = readAnswer(entry);
        if (answer.ok) send([answer]);
        else { showMiss(entry, answer.message); focusInto(entry); }
      }
      // A group is checked as a whole and sent in one message, or not at all.
      function submitGroup() {
        const answers = entries.map(readAnswer);
        const bad = [];
        answers.forEach((a, i) => {
          if (a.ok) clearMiss(entries[i]);
          else { showMiss(entries[i], a.message); bad.push(entries[i]); }
        });
        const err = card.querySelector('.groupErr');
        if (bad.length) {
          err.textContent = bad.length === 1 ? '1 question still needs an answer.' : bad.length + ' questions still need an answer.';
          bad[0].block.scrollIntoView({ block: 'nearest' });
          focusInto(bad[0]);
          return;
        }
        err.textContent = '';
        send(answers);
      }
      // Enter in a group's text field: the next question still unanswered, or Submit answers when there is none.
      function groupEnter(entry) {
        const answer = readAnswer(entry);
        if (!answer.ok && !answer.empty) { showMiss(entry, answer.message); return; }
        const i = entries.indexOf(entry);
        const next = entries.slice(i + 1).concat(entries.slice(0, i)).find(e => !readAnswer(e).ok);
        if (next) focusInto(next);
        else submitGroup();
      }
      // Enter in the filter picks the one option that matches.
      function filterEnter(entry, input) {
        const words = input.value.toLowerCase().split(' ').filter(Boolean);
        const hits = [...entry.block.querySelectorAll('[data-pick],[data-opt]')].filter(btn => words.every(w => btn.textContent.toLowerCase().indexOf(w) !== -1));
        if (hits.length !== 1) return;
        if (single && hits[0].hasAttribute('data-pick')) { sendNow(entry, hits[0]); return; }
        press(entry, hits[0]);
        input.value = '';
        applyFilter(entry, '');
      }
      // After a rejection the card gets its answers back. A single question gets its typed value, ticked chips and certainty but
      // no lit button: its buttons answer in one click and hold no state, so a lit one would only suggest a choice still to send.
      function restore(entry, p) {
        const b = entry.block;
        const find = (attr, v) => [...b.querySelectorAll('[' + attr + ']')].find(x => x.getAttribute(attr) === String(v));
        const cf = b.querySelector('.cf');
        if (cf && typeof p.certainty === 'number') { cf.value = String(p.certainty); b.querySelector('.cfv').textContent = cf.value + '%'; }
        if (p.kind === 'multi') {
          // Chips toggle in single cards too (they are sent with Submit), so they come back everywhere, typed ones as added chips.
          (Array.isArray(p.values) ? p.values : []).forEach(v => {
            const chip = find('data-opt', v);
            if (chip) press(entry, chip);
            else if (!isKnown(entry, String(v))) addChip(entry, String(v));
          });
          return;
        }
        const lit = p.kind === 'yesno' ? find('data-yn', p.answer)
          : p.kind === 'value' ? find('data-truth', p.value) || find('data-pick', p.value)
          : null;
        if (!single) {
          if (p.kind === 'skip' || p.kind === 'unknown') { press(entry, b.querySelector('[data-skip]')); return; }
          if (lit) { press(entry, lit); return; }
        }
        if (p.kind !== 'value' || lit) return;
        const input = b.querySelector('input.val, input.other');
        if (!input) return;
        input.value = p.raw !== undefined && p.raw !== null ? String(p.raw) : String(p.value ?? '');
        updatePreview(entry);
        if (!single) typed(entry, input);
      }
      // The button a single card's previous answer was sent with: a re-asked card focuses it, so Enter resends the same answer.
      function sentButton(entry, p) {
        const b = entry.block;
        const find = (attr, v) => [...b.querySelectorAll('[' + attr + ']')].find(x => x.getAttribute(attr) === String(v));
        if (p.kind === 'skip' || p.kind === 'unknown') return b.querySelector('[data-skip]');
        if (p.kind === 'yesno') return find('data-yn', p.answer) || null;
        if (p.kind === 'value') return find('data-truth', p.value) || find('data-pick', p.value) || null;
        return null;
      }

      card.addEventListener('click', e => {
        const btn = e.target && e.target.closest ? e.target.closest('button') : null;
        if (!btn || btn.disabled) return;
        if (btn.classList.contains('back')) {
          retireAuto();
          card.remove();
          addTranscript('↶', 'back one step');
          vscode.postMessage({ type: 'undo' });
          return;
        }
        if (btn.classList.contains('submitAll')) { submitGroup(); return; }
        if (btn.hasAttribute('data-injectonly')) { vscode.postMessage({ type: 'makeInjectOnly', relationship: btn.getAttribute('data-injectonly') }); return; }
        const entry = entryOf(btn);
        if (!entry) return;
        if (btn.hasAttribute('data-fill')) { fill(entry, btn.getAttribute('data-fill')); return; }
        if (btn.hasAttribute('data-iso')) { fill(entry, btn.getAttribute('data-iso')); return; }
        if (btn.getAttribute('data-act') === 'submit') { submitSingle(entry); return; }
        if (btn.getAttribute('data-act') === 'add') { addOther(entry); return; }
        if (btn.hasAttribute('data-yn') || btn.hasAttribute('data-truth') || btn.hasAttribute('data-pick') || btn.hasAttribute('data-skip')) {
          if (single) sendNow(entry, btn);
          else choose(entry, btn);
        } else if (btn.hasAttribute('data-opt')) {
          choose(entry, btn);
        }
      });
      // The calendar fills the text field. Cleared, or with one part deleted, its value is empty: the typed text stays as it is.
      const calendarPicked = cal => {
        const entry = entryOf(cal);
        const input = entry && entry.block.querySelector('input.val.date');
        if (!input || !cal.value) return;
        input.value = cal.value;
        updatePreview(entry);
        typed(entry, input);
      };
      card.addEventListener('input', e => {
        const t = e.target;
        const entry = entryOf(t);
        if (!entry || !t.classList) return;
        if (t.classList.contains('cf')) { t.parentElement.querySelector('.cfv').textContent = t.value + '%'; return; }
        if (t.classList.contains('filter')) { applyFilter(entry, t.value); return; }
        if (t.classList.contains('cal')) { calendarPicked(t); return; }
        if (t.classList.contains('date')) updatePreview(entry);
        if (t.classList.contains('val') || t.classList.contains('other')) typed(entry, t);
      });
      card.addEventListener('keydown', e => {
        const t = e.target;
        if (e.key !== 'Enter' || e.isComposing || !t || t.tagName !== 'INPUT' || t.type === 'range' || t.type === 'date') return;
        const entry = entryOf(t);
        if (!entry) return;
        e.preventDefault();
        if (t.classList.contains('filter')) filterEnter(entry, t);
        else if (t.classList.contains('other') && entry.q.plural && t.value.trim()) addOther(entry);
        else if (single) submitSingle(entry);
        else groupEnter(entry);
      });

      // Group members the injected facts already cover start on the skip (still editable); then a rejected card gets its answers back.
      if (!single) entries.forEach(entry => { if (entry.m.preSkip) press(entry, entry.block.querySelector('[data-skip]')); });
      (Array.isArray(msg.previous) ? msg.previous : []).forEach((p, i) => { if (entries[i] && p && typeof p === 'object') restore(entries[i], p); });

      // Answering removed the card that had the focus, so the new card takes it: its field, or its first button when it
      // has none (Yes, True, the first option). Keyboard users need not Tab through the header to reach it.
      if (single) {
        const prev = Array.isArray(msg.previous) ? msg.previous[0] : null;
        const sent = prev && typeof prev === 'object' ? sentButton(entries[0], prev) : null;
        if (sent && !sent.disabled) sent.focus();
        else focusInto(entries[0]);
      } else {
        focusInto(entries.find(entry => !readAnswer(entry).ok) || entries[0]);
      }
    }

    on('question', m => {
      noteReply();
      // A re-ask carrying the submitted answers (previous) means they were rejected.
      if (Array.isArray(m.previous)) dropPending();
      else flushPending();
      questionCard(m);
    });
    on('result', () => {
      noteReply();
      flushPending();
    });
    on('error', () => dropPending());
    // Busy means a new step (an answer, Back, a new query): an older automatic answer is no longer the latest.
    on('beforeBusy', () => retireAuto());

    // A question group answered "No more" by the extension: a transcript card with Answer instead.
    on('autoSkipped', m => {
      flushPending();
      retireAuto();
      const items = Array.isArray(m.items) ? m.items : [];
      if (!items.length) return;
      const card = el('<div class="transcript auto">'
        + items.map(it => '<div><b>' + esc(it.prompt) + '</b> — answered “' + esc(it.label || 'No more') + '” automatically'
          + (it.values && it.values.length ? ': ' + (it.reason === 'known' ? 'already known: ' : 'already known from injected facts: ') + esc(it.values.join(', ')) : '')
          + '</div>').join('')
        + '<button class="linkish" data-instead="1" disabled title="Available once the engine has replied">Answer instead</button>'
        + '</div>');
      insertBeforeBusy(card);
      liveAuto = card;
      liveAutoReplies = 0;
      card.addEventListener('click', e => {
        const btn = e.target && e.target.closest ? e.target.closest('[data-instead]') : null;
        if (!btn || btn.disabled || liveAuto !== card) return;
        // Everything after this card is the engine's reply to the automatic answer, which is about to be undone.
        let next = card.nextElementSibling;
        while (next) {
          const after = next.nextElementSibling;
          if (next !== busyEl) next.remove();
          next = after;
        }
        retireAuto();
        addTranscript('↶', 'answer instead');
        vscode.postMessage({ type: 'answerInstead' });
      });
    });

    on('injectOnlyDone', m => {
      flow.querySelectorAll('[data-injectonly]').forEach(btn => {
        if (btn.getAttribute('data-injectonly') !== m.relationship) return;
        btn.disabled = true;
        btn.textContent = 'askable="none" is set on “' + m.relationship + '” in ' + m.file + ' (not saved yet)';
      });
    });
  })();
`;
