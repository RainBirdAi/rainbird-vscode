/**
 * Known answers and skipping: what the engine already holds for a question,
 * whether and how the question may be skipped, when the extension answers
 * "No more" by itself, and how supplied answers are matched to a question
 * group. Shared by the query panel, the Quick Pick runner, the assistant's
 * run_query tool and test replay. VS Code-free, so it is unit-tested under
 * plain node.
 *
 * By design (Rainbird's Relationships docs), a plural relationship is asked
 * even when facts for it already exist — injected, from the map, a datasource
 * or a rule — so that more can be added.
 *
 * Verified live on the public HelloWorld sandbox (2026-10-07):
 * - knownAnswers is populated from injected facts; an entry is
 *   {subject, relationship: {name, plural, …}, object, cf}.
 * - A fact injected below 100% certainty is asked again for confirmation even
 *   on a singular relationship (Tom lives in France at 90 → "Where does Tom
 *   live?" with that fact in knownAnswers; at 100 it is not asked). The query's
 *   own goal relationship is not asked back, plural or not.
 * - unanswered: true is accepted when knownAnswers is non-empty even though
 *   allowUnknown is false, and the skip KEEPS the known facts (Tom speaks
 *   French 71% = 75 × (0.5 × 0.90 + 0.5 × 1.00)). Without knownAnswers or
 *   allowUnknown it is a 400 "Please provide an expected boolean value for
 *   unanswered.".
 * - A skip sends the triple that identifies the question and omits the asked
 *   value: {relationship, subject, unanswered: true} for an object question
 *   (the same with object: "" works too).
 *
 * Names are case-sensitive on the platform, so every match here is exact;
 * nearMiss() only explains a case mismatch, it never counts it as a match.
 *
 * The functions in SKIP_WEBVIEW_SOURCE are self-contained (no imports, no
 * module-level constants, no template literals, calling only each other) so
 * the query panel's webview can inline them, like ANSWER_WEBVIEW_SOURCE.
 */
import { ApiError } from "./api";
import type { Answer, EngineResponse, Fact, Question, ResultItem } from "./api";
import { answerFor, canAddHere, coerceAnswer, expectedFormat, formatValue, optionsFor } from "./answers";
import type { DateOrder } from "./answers";

/** A known answer, normalised: relationship by name, certainty from cf (or certainty). */
export interface KnownAnswerInfo {
  relationship: string;
  subject?: string;
  object?: string | number | boolean;
  certainty?: number;
}

/** A known value on the side the question asks about, ready to show. */
export interface KnownEntry {
  /** Formatted value (dates as YYYY-MM-DD); the subject for a subject question. */
  value: string;
  certainty?: number;
  /** True when a fact injected this session has exactly this value for this question. */
  injected: boolean;
  /** "France", or "France (90%)" below 100% certainty. */
  label: string;
}

/** The setting rainbird.query.autoSkipPluralQuestions. */
export type AutoSkipMode = "injected" | "known" | "off";

/** Why autoSkipPlan() did or did not skip a question. */
export type AutoSkipReason = "injected" | "known" | "off" | "first-form" | "singular" | "suppressed" | "cannot-skip" | "not-covered";

export interface AutoSkipDecision {
  skip: boolean;
  reason: AutoSkipReason;
  /** When skipping: the values that cover the question (the injected facts' values, or the engine's known values). */
  values: string[];
}

export interface AutoSkipOptions {
  mode: AutoSkipMode;
  /** Facts injected in this session. */
  injected: Fact[];
  /** questionKey()s never to skip automatically again: the engine refused the skip, or the user chose to answer instead. */
  noAutoSkip: Set<string>;
}

/** Facts injected for an instance whose name differs from the asked one only by case or surrounding spaces. */
export interface NearMiss {
  /** The name the engine asks about. */
  asked: string;
  /** The name used in the injected facts. */
  injected: string;
  facts: Fact[];
  /** Copy for the question card. */
  message: string;
}

/**
 * The engine's known answers for a question, normalised from the live shape
 * (relationship as an object with `name` or a bare string; certainty as `cf`
 * or `certainty`). Bare values are read as the asked side; junk is dropped.
 */
export function readKnownAnswers(q: { relationship?: string; type?: string; knownAnswers?: unknown }): KnownAnswerInfo[] {
  const scalar = (v: unknown): string | number | boolean | undefined =>
    typeof v === "string" || typeof v === "number" || typeof v === "boolean" ? v : undefined;
  const out: KnownAnswerInfo[] = [];
  const list = Array.isArray(q.knownAnswers) ? (q.knownAnswers as unknown[]) : [];
  for (const entry of list) {
    const bare = scalar(entry);
    if (bare !== undefined) {
      out.push(q.type === "Second Form Subject" ? { relationship: q.relationship || "", subject: String(bare) } : { relationship: q.relationship || "", object: bare });
      continue;
    }
    if (entry === null || typeof entry !== "object") continue;
    const e = entry as { subject?: unknown; relationship?: unknown; object?: unknown; cf?: unknown; certainty?: unknown };
    const rel = e.relationship as { name?: unknown } | string | null | undefined;
    const relationship = typeof rel === "string" ? rel : rel && typeof rel === "object" && typeof rel.name === "string" ? rel.name : q.relationship || "";
    const subject = scalar(e.subject);
    const object = scalar(e.object);
    if (subject === undefined && object === undefined) continue;
    const cf = e.cf !== undefined && e.cf !== null ? e.cf : e.certainty;
    const certainty = typeof cf === "number" ? cf : typeof cf === "string" && cf.trim() !== "" && isFinite(Number(cf)) ? Number(cf) : undefined;
    out.push({
      relationship,
      ...(subject !== undefined ? { subject: String(subject) } : {}),
      ...(object !== undefined ? { object } : {}),
      ...(certainty !== undefined ? { certainty } : {}),
    });
  }
  return out;
}

/** The value a fact gives for the side question q asks about (the subject for a subject question), formatted. */
function askedValue(q: Pick<Question, "type" | "dataType">, fact: { subject?: unknown; object?: unknown }): string {
  return q.type === "Second Form Subject" ? formatValue("string", fact.subject) : formatValue(q.dataType, fact.object);
}

/** Whether two values are the same for this question: exact (case-sensitive), after canonical formatting so 370742400000 equals 1981-10-01 for a date. */
function sameValue(dataType: string | undefined, a: unknown, b: unknown): boolean {
  return String(a) === String(b) || formatValue(dataType, a) === formatValue(dataType, b);
}

/** The engine's known values for a question, on the asked side, formatted and de-duplicated; `injected` marks values that facts injected this session supply. */
export function knownEntries(q: Question, injected: Fact[] = []): KnownEntry[] {
  const fromInjection = new Set(injectedFactsFor(q, injected).map((f) => askedValue(q, f)));
  const entries = new Map<string, KnownEntry>();
  for (const k of readKnownAnswers(q)) {
    const raw = q.type === "Second Form Subject" ? k.subject : k.object;
    if (raw === undefined) continue;
    const value = askedValue(q, k);
    if (!value || entries.has(value)) continue;
    const certainty = k.certainty;
    entries.set(value, {
      value,
      ...(certainty !== undefined ? { certainty } : {}),
      injected: fromInjection.has(value),
      label: value + (certainty !== undefined && certainty < 100 ? ` (${certainty}%)` : ""),
    });
  }
  return [...entries.values()];
}

/** The engine's known values for a question (asked side, formatted, distinct): ["France"]. */
export function knownValues(q: Question): string[] {
  return knownEntries(q).map((e) => e.value);
}

/** Whether the engine accepts `unanswered: true` for this question: allowUnknown, or known answers present (verified live). */
export function canSkip(q: { allowUnknown?: boolean; relationship?: string; type?: string; knownAnswers?: unknown }): boolean {
  return q.allowUnknown === true || readKnownAnswers(q).length > 0;
}

/**
 * The skip button's label, also the transcript text: "No more" (plural,
 * non-first-form, with known answers), "Keep known answer" (any other question
 * with known answers), else "Don’t know" — with the typographic apostrophe
 * U+2019, as on the query panel's existing button. Compare with skipLabel(q),
 * not a retyped string.
 */
export function skipLabel(q: { type?: string; plural?: boolean; relationship?: string; knownAnswers?: unknown }): string {
  if (!readKnownAnswers(q).length) return "Don’t know";
  return q.plural && q.type !== "First Form" ? "No more" : "Keep known answer";
}

/** A tooltip for the skip button saying what the skip does. */
export function skipTitle(q: { type?: string; plural?: boolean; relationship?: string; knownAnswers?: unknown }): string {
  const label = skipLabel(q);
  if (label === "No more") return "Add nothing more: the engine keeps the answers it already has and carries on.";
  if (label === "Keep known answer") return "Answer nothing new: the engine keeps the answer it already has and carries on.";
  return "Skip this question: the engine carries on without this fact.";
}

/**
 * The wire answer that skips a question: unanswered: true plus the triple that
 * identifies it, with the asked value left out — no object for a Second Form
 * Object question, no subject for a Second Form Subject question, no `answer`
 * for a First Form question — and no certainty.
 */
export function skipAnswer(q: { type?: string; relationship: string; subject?: string; object?: string }): Answer {
  if (q.type === "Second Form Subject") {
    return { relationship: q.relationship, ...(q.object !== undefined ? { object: q.object } : {}), unanswered: true };
  }
  if (q.type === "First Form") {
    return {
      relationship: q.relationship,
      ...(q.subject !== undefined ? { subject: q.subject } : {}),
      ...(q.object !== undefined ? { object: q.object } : {}),
      unanswered: true,
    };
  }
  return { relationship: q.relationship, ...(q.subject !== undefined ? { subject: q.subject } : {}), unanswered: true };
}

/** "relationship|subject|object" — the same for a question and its skipAnswer(), so a recorded skip can be matched back to its question. */
export function questionKey(x: { relationship?: string; subject?: unknown; object?: unknown }): string {
  const part = (v: unknown) => (v === undefined || v === null ? "" : String(v));
  return part(x.relationship) + "|" + part(x.subject) + "|" + part(x.object);
}

/**
 * Whether a wire answer is for question q: the same relationship, and the side
 * that identifies the question agrees when both give it — the subject for an
 * object question, the object for a subject question, both for First Form.
 */
export function answersQuestion(a: Answer, q: Question): boolean {
  if (a.relationship !== q.relationship) return false;
  const sameSubject = a.subject === undefined || q.subject === undefined || a.subject === q.subject;
  const sameObject = a.object === undefined || q.object === undefined || sameValue(q.dataType, a.object, q.object);
  if (q.type === "Second Form Subject") return sameObject;
  if (q.type === "First Form") return sameSubject && sameObject;
  return sameSubject;
}

/** Facts injected this session that cover question q: exact, case-sensitive subject + relationship for an object question, object + relationship for a subject question (the whole fact for First Form). */
export function injectedFactsFor(q: Question, facts: Fact[]): Fact[] {
  return facts.filter((f) => {
    if (f.relationship !== q.relationship) return false;
    if (q.type === "Second Form Subject") return q.object !== undefined && sameValue(q.dataType, f.object, q.object);
    if (q.subject === undefined || f.subject !== q.subject) return false;
    return q.type !== "First Form" || (q.object !== undefined && sameValue(q.dataType, f.object, q.object));
  });
}

/** Whether facts injected this session cover question q (see injectedFactsFor). */
export function coveredByInjected(q: Question, facts: Fact[]): boolean {
  return injectedFactsFor(q, facts).length > 0;
}

/** The setting rainbird.query.autoSkipPluralQuestions as an AutoSkipMode; anything unexpected is the default, "injected". */
export function readAutoSkipMode(value: unknown): AutoSkipMode {
  return value === "known" || value === "off" ? value : "injected";
}

/**
 * Which questions of a group to answer "No more" automatically. Only plural,
 * non-first-form questions the engine lets us skip (canSkip) and that are not
 * in noAutoSkip; covered per mode — "injected": facts injected this session
 * cover the question; "known": that, or the engine reports any knownAnswers;
 * "off": never. One decision per question, in group order.
 */
export function autoSkipPlan(group: Question[], opts: AutoSkipOptions): AutoSkipDecision[] {
  return group.map((q): AutoSkipDecision => {
    const keep = (reason: AutoSkipReason): AutoSkipDecision => ({ skip: false, reason, values: [] });
    if (opts.mode === "off") return keep("off");
    if (q.type === "First Form") return keep("first-form");
    if (!q.plural) return keep("singular");
    if (opts.noAutoSkip.has(questionKey(q))) return keep("suppressed");
    if (!canSkip(q)) return keep("cannot-skip");
    const injected = injectedFactsFor(q, opts.injected);
    if (injected.length) return { skip: true, reason: "injected", values: [...new Set(injected.map((f) => askedValue(q, f)))] };
    if (opts.mode === "known" && readKnownAnswers(q).length) return { skip: true, reason: "known", values: knownValues(q) };
    return keep("not-covered");
  });
}

/**
 * Facts injected for an instance that differs from the asked one only by case
 * (or surrounding spaces) — "fred" injected while the engine asks about
 * "Fred" — when no injected fact matches exactly. Instance names only: the
 * relationship must match exactly.
 */
export function nearMiss(q: Question, facts: Fact[]): NearMiss | undefined {
  if (injectedFactsFor(q, facts).length) return undefined;
  const asksSubject = q.type === "Second Form Subject";
  const asked = asksSubject ? q.object : q.subject;
  if (asked === undefined || asked === null || String(asked) === "") return undefined;
  const fold = (v: unknown) => String(v).trim().toLowerCase();
  const nameOf = (f: Fact) => String(asksSubject ? f.object : f.subject);
  const near = facts.filter((f) => f.relationship === q.relationship && nameOf(f) !== String(asked) && fold(nameOf(f)) === fold(asked));
  if (!near.length) return undefined;
  const injected = nameOf(near[0]);
  return {
    asked: String(asked),
    injected,
    facts: near,
    message: `Facts were injected for "${injected}", but the engine is asking about "${asked}". Instance names are case-sensitive, so those facts do not cover this question.`,
  };
}

/** The note when the engine refuses a skip: the P-1 copy, with `action` saying what to do next ("Pick an answer below." in the panel). */
export function skipRejectedNote(detail: string, q: Pick<Question, "relationship">, action = "Pick an answer below."): string {
  return (
    `The engine would not let this question be skipped${detail ? ` (${detail})` : ""}. ${action} ` +
    `If "${q.relationship}" should only ever be fed by injected facts, set askable="none" on it in the map — only if every session injects those facts; otherwise rules that need them get no result.`
  );
}

/** "Tom lives in ?", "? lives in France" or "Tom lives in France?" — the triple a question asks about. */
function describeAsked(q: Pick<Question, "type" | "relationship" | "subject" | "object">): string {
  if (q.type === "Second Form Subject") return `? ${q.relationship} ${q.object ?? "?"}`;
  if (q.type === "First Form") return `${q.subject ?? "?"} ${q.relationship} ${q.object ?? "?"}?`;
  return `${q.subject ?? "?"} ${q.relationship} ?`;
}

/** Test replay: the engine asked something the test has no recorded answer for. */
export function pendingQuestionMessage(q: Question): string {
  return `The engine asked an unrecorded question: "${q.prompt}" (${describeAsked(q)}) — the map's question flow changed. If that is intended, re-record the test from the query panel.`;
}

/** Test replay: the engine refused a skip the test recorded. */
export function replaySkipRefused(batch: Answer[], detail: string): string {
  const rels = [...new Set(batch.filter((a) => a.unanswered).map((a) => `"${a.relationship ?? ""}"`))].join(", ");
  return (
    `The engine refused to skip ${rels}${detail ? ` (${detail})` : ""}: this test answers it with unanswered: true, which the engine accepts only when the question has allowUnknown or known answers. ` +
    `Re-record the test from the query panel, or set askable="none" on the relationship if only injected facts should ever feed it.`
  );
}

/** What to send to skip a question, in words, for the assistant: built from skipAnswer() so the triple is always right. */
export function skipHint(q: Question): string {
  const json = JSON.stringify(skipAnswer(q));
  const known = knownEntries(q).map((e) => e.label);
  if (!known.length) return `To answer "don't know", send ${json}.`;
  return q.plural && q.type !== "First Form"
    ? `The engine already holds ${known.join(", ")}. To say "no more" (keep those and add nothing), send ${json}; to add values, answer them instead.`
    : `The engine already holds ${known.join(", ")} and asks to confirm it. To keep it, send ${json}; to change it, answer the question.`;
}

/** A question as the assistant sees it: what it needs to answer or skip it, without raw concepts. */
export interface QuestionSummary {
  prompt: string;
  relationship: string;
  subject?: string;
  object?: string;
  type: Question["type"];
  dataType: Question["dataType"];
  plural: boolean;
  allowCF: boolean;
  canAdd: boolean;
  /** expectedFormat(): the value format, e.g. "a date as YYYY-MM-DD, e.g. 1981-10-01". */
  expected: string;
  /** De-duplicated, formatted values to choose from (instances; known values for number/date questions). */
  options: string[];
  /** knownValues(): what the engine already holds for this question. */
  alreadyKnown: string[];
  canSkip: boolean;
  skipHint?: string;
  /** Answered "no more" automatically unless an answer for it is supplied. */
  willAutoSkip?: true;
}

export function summariseQuestion(q: Question, opts?: { willAutoSkip?: boolean }): QuestionSummary {
  const skippable = canSkip(q);
  return {
    prompt: q.prompt,
    relationship: q.relationship,
    ...(q.subject !== undefined ? { subject: q.subject } : {}),
    ...(q.object !== undefined ? { object: q.object } : {}),
    type: q.type,
    dataType: q.dataType,
    plural: q.plural,
    allowCF: q.allowCF,
    canAdd: canAddHere(q),
    expected: expectedFormat(q),
    options: optionsFor(q).map((o) => o.value),
    alreadyKnown: knownValues(q),
    canSkip: skippable,
    ...(skippable ? { skipHint: skipHint(q) } : {}),
    ...(opts?.willAutoSkip ? { willAutoSkip: true as const } : {}),
  };
}

/** A question answered "no more" automatically. */
export interface PlannedSkip {
  question: Question;
  reason: "injected" | "known";
  values: string[];
}

/** An answer refused before sending, and why. */
export interface RejectedAnswer {
  question: Question;
  answer: Answer;
  error: string;
}

export interface GroupAnswerPlan {
  /** The wire answers for ONE respond() call, in group order — only when every question is answered or skipped and nothing was refused. */
  batch?: Answer[];
  /** Questions with no supplied answer that are not skipped automatically. */
  missing: Question[];
  rejected: RejectedAnswer[];
  autoSkipped: PlannedSkip[];
  /** Supplied answers this group took (put them back if the batch is refused). */
  used: Answer[];
  /** Supplied answers for no question of this group, in their original order (for later groups). */
  remaining: Answer[];
}

/** Check and convert one supplied answer for question q. */
function wireAnswer(q: Question, a: Answer, dateOrder?: DateOrder): { ok: true; answer: Answer } | { ok: false; error: string } {
  if (a.certainty !== undefined && a.cf !== undefined) return { ok: false, error: "Give certainty or cf, not both." };
  const certainty = a.certainty ?? a.cf;
  if (certainty !== undefined && !(typeof certainty === "number" && certainty >= 1 && certainty <= 100)) {
    return { ok: false, error: "Certainty must be a number from 1 to 100." };
  }
  if (a.unanswered) {
    if (!canSkip(q)) {
      return { ok: false, error: "This question cannot be skipped: unanswered: true is accepted only when the question has allowUnknown or knownAnswers. Answer it instead." };
    }
    return { ok: true, answer: skipAnswer(q) };
  }
  const raw = q.type === "First Form" ? a.answer : q.type === "Second Form Subject" ? a.subject : a.object;
  if (raw === undefined) {
    const where =
      q.type === "First Form"
        ? 'Answer a first-form question with answer: "yes" or "no".'
        : q.type === "Second Form Subject"
          ? "This question asks for the subject: give the answer in subject (and the question's object in object)."
          : "Give the answer in object.";
    return { ok: false, error: where };
  }
  const coerced = coerceAnswer(q, raw, { dateOrder });
  if (!coerced.ok) return coerced;
  const answer = answerFor(q, coerced.value, a.certainty);
  return { ok: true, answer: a.cf !== undefined ? { ...answer, cf: a.cf } : answer };
}

/**
 * Match supplied answers to a question group and build the ONE batch that
 * answers it. Answers are matched by relationship (plus subject / object when
 * given, see answersQuestion), not by position; an answer without a
 * relationship takes the next question that has none yet (the old positional
 * contract). A plural question takes several answers. Questions without an
 * answer are skipped automatically per autoSkipPlan() — never one that has a
 * supplied answer. Every value goes through coerceAnswer(); a skip is checked
 * against canSkip() and rebuilt with skipAnswer().
 */
export function planGroupAnswers(group: Question[], supplied: Answer[], opts: AutoSkipOptions & { dateOrder?: DateOrder }): GroupAnswerPlan {
  const given: Answer[][] = group.map(() => []);
  const used: Answer[] = [];
  const remaining: Answer[] = [];
  for (const a of supplied) {
    const i = a.relationship ? group.findIndex((q) => answersQuestion(a, q)) : given.findIndex((list) => list.length === 0);
    if (i < 0) {
      remaining.push(a);
    } else {
      given[i].push(a);
      used.push(a);
    }
  }
  const decisions = autoSkipPlan(group, opts);
  const batch: Answer[] = [];
  const plan: GroupAnswerPlan = { missing: [], rejected: [], autoSkipped: [], used, remaining };
  group.forEach((q, i) => {
    const answers = given[i];
    if (!answers.length) {
      const decision = decisions[i];
      if (decision.skip) {
        batch.push(skipAnswer(q));
        plan.autoSkipped.push({ question: q, reason: decision.reason === "known" ? "known" : "injected", values: decision.values });
      } else {
        plan.missing.push(q);
      }
      return;
    }
    if (answers.length > 1 && answers.some((a) => a.unanswered)) {
      plan.rejected.push({ question: q, answer: answers[0], error: "Either skip this question or answer it, not both." });
      return;
    }
    if (answers.length > 1 && (!q.plural || q.type === "First Form")) {
      plan.rejected.push({ question: q, answer: answers[1], error: "This question takes one answer (it is not plural)." });
      return;
    }
    for (const a of answers) {
      const result = wireAnswer(q, a, opts.dateOrder);
      if (result.ok) batch.push(result.answer);
      else plan.rejected.push({ question: q, answer: a, error: result.error });
    }
  });
  if (!plan.missing.length && !plan.rejected.length) plan.batch = batch;
  return plan;
}

/** The part of RainbirdClient the answer loop needs (a fake in tests). */
export interface Responder {
  respond(sessionId: string, answers: Answer[]): Promise<EngineResponse>;
}

/** What a caller keeps about a session between calls (run_query keeps one per session it started). */
export interface QuestionSession {
  /** Facts injected at the start: auto-skip compares questions with them. */
  facts: Fact[];
  /** questionKey()s never to skip automatically again: skipped once already, or the engine refused. */
  noAutoSkip: Set<string>;
  /** The question group waiting for answers; empty once a result arrived. */
  pending: Question[];
}

/** Where answerQuestions() stopped: a result, or a question group it could not answer. */
export type AnswerLoopOutcome =
  | { kind: "result"; results: ResultItem[]; autoSkipped: PlannedSkip[]; unused: Answer[] }
  | {
      kind: "question";
      group: Question[];
      autoSkipped: PlannedSkip[];
      /** Questions of `group` answered "no more" automatically unless an answer is supplied for them. */
      willSkip: Question[];
      rejected: RejectedAnswer[];
      /** Supplied answers for no question of `group`. */
      unused: Answer[];
      /** Part of the group was answered but not all, so nothing was sent. */
      partial: boolean;
      /** The engine refused a batch holding an automatic skip (its message): the skip is withdrawn and the question asked. */
      refusedSkip?: string;
      /** That refused batch also carried supplied answers, so the cause is unclear: the automatic skip or one of them. */
      refusedWithAnswers?: true;
      /** The engine rejected the group's answers (its message); nothing was recorded. */
      engineError?: string;
    };

/**
 * Answer the engine's questions from `supplied` until a result, or until a
 * group still needs answers: each group goes out in ONE respond() call, built
 * by planGroupAnswers(). When the engine refuses a batch holding an automatic
 * skip (400), those questions are never skipped automatically again and the
 * same group is planned once more, so it comes back as a question (with
 * refusedWithAnswers when the batch also carried supplied answers, which may be
 * the real cause); a 400 on supplied answers alone stops with the engine's
 * message (the session stays on that question). Each question
 * is skipped automatically at most once per session, so an engine that asks it
 * again cannot loop.
 */
export async function answerQuestions(
  client: Responder,
  sessionId: string,
  first: EngineResponse,
  supplied: Answer[],
  session: QuestionSession,
  opts: { mode: AutoSkipMode; dateOrder?: DateOrder }
): Promise<AnswerLoopOutcome> {
  let response = first;
  let queue = [...supplied];
  const autoSkipped: PlannedSkip[] = [];
  let refusedSkip: string | undefined;
  let refusedWithAnswers = false;
  while (response.kind === "question") {
    const group = [response.question, ...(response.extraQuestions ?? [])];
    session.pending = group;
    const plan = planGroupAnswers(group, queue, { mode: opts.mode, injected: session.facts, noAutoSkip: session.noAutoSkip, dateOrder: opts.dateOrder });
    if (!plan.batch) {
      return {
        kind: "question",
        group,
        autoSkipped,
        willSkip: plan.autoSkipped.map((s) => s.question),
        rejected: plan.rejected,
        unused: plan.remaining,
        // After a refused batch the answers were sent once already; the refusal says what to do.
        partial: refusedSkip === undefined && plan.used.length > 0 && plan.missing.length > 0,
        ...(refusedSkip !== undefined ? { refusedSkip, ...(refusedWithAnswers ? { refusedWithAnswers: true as const } : {}) } : {}),
      };
    }
    try {
      response = await client.respond(sessionId, plan.batch);
    } catch (error) {
      if (!(error instanceof ApiError) || error.status !== 400) throw error;
      const detail = error.errMessages()?.join("; ") ?? error.body.slice(0, 200);
      if (!plan.autoSkipped.length) {
        return { kind: "question", group, autoSkipped, willSkip: [], rejected: [], unused: plan.remaining, partial: false, engineError: detail };
      }
      // A 400 does not say which answer failed: withdraw the automatic skips (never retried) and ask.
      for (const s of plan.autoSkipped) session.noAutoSkip.add(questionKey(s.question));
      refusedSkip = detail;
      refusedWithAnswers = plan.used.length > 0;
      queue = [...plan.used, ...plan.remaining];
      continue;
    }
    for (const s of plan.autoSkipped) session.noAutoSkip.add(questionKey(s.question));
    autoSkipped.push(...plan.autoSkipped);
    queue = plan.remaining;
    refusedSkip = undefined;
    refusedWithAnswers = false;
  }
  session.pending = [];
  return { kind: "result", results: response.result, autoSkipped, unused: queue };
}

/** An automatic "no more" as reported to the model. */
function describeAutoSkip(s: PlannedSkip) {
  const q = s.question;
  return {
    prompt: q.prompt,
    relationship: q.relationship,
    ...(q.subject !== undefined ? { subject: q.subject } : {}),
    ...(q.object !== undefined ? { object: q.object } : {}),
    reason: s.reason === "injected" ? "covered by the injected facts" : "the engine already holds answers for it",
    values: s.values,
  };
}

/**
 * run_query's reply to the model (JSON text): the results, or the questions
 * still to answer as summariseQuestion() summaries with what stopped the run.
 * `autoSkipped` is always present, so the model can always tell what was
 * answered "no more" for it.
 */
export function queryToolReply(outcome: AnswerLoopOutcome, ids: { sessionId: string; kmId?: string }): string {
  if (outcome.kind === "result") {
    return JSON.stringify(
      {
        status: "result",
        sessionId: ids.sessionId,
        ...(ids.kmId ? { kmId: ids.kmId } : {}),
        results: outcome.results,
        autoSkipped: outcome.autoSkipped.map(describeAutoSkip),
        ...(outcome.unused.length
          ? { unusedAnswers: outcome.unused, note: "unusedAnswers matched no question the engine asked (relationship / subject / object)." }
          : {}),
      },
      null,
      2
    );
  }
  const { group } = outcome;
  const notes: string[] = [];
  const paren = (detail: string) => (detail ? ` (${detail})` : "");
  if (outcome.engineError !== undefined) {
    notes.push(`Rainbird rejected the answers for this group${paren(outcome.engineError)}; nothing was recorded. Fix them and call again with this sessionId.`);
  }
  if (outcome.rejected.length) notes.push("Some answers were not sent (see rejected): fix them and call again with this sessionId, answering the whole group.");
  if (outcome.refusedSkip !== undefined) {
    notes.push(
      outcome.refusedWithAnswers
        ? `Rainbird rejected this group${paren(outcome.refusedSkip)}; the automatic "no more" was withdrawn in case it was the cause — check your answers and answer the whole group.`
        : `Rainbird would not let a question be skipped automatically${paren(outcome.refusedSkip)}, so it is asked here.`
    );
  }
  if (outcome.partial) notes.push("Only part of this group was answered, so nothing was sent: a group is answered in one call.");
  if (outcome.willSkip.length) notes.push('Questions marked willAutoSkip are answered "no more" automatically unless you supply an answer for them.');
  if (outcome.unused.length) notes.push("unusedAnswers matched no question of this group (relationship / subject / object); include them again if they are for later questions.");
  notes.push(
    group.length > 1
      ? `These ${group.length} questions are a group: call again with this sessionId and answers for all of them in one call, matched by relationship and subject/object (a plural question takes one entry per value).`
      : "Call again with this sessionId and an answer for this question (or ask the user)."
  );
  return JSON.stringify(
    {
      status: "question",
      sessionId: ids.sessionId,
      questions: group.map((q) => summariseQuestion(q, { willAutoSkip: outcome.willSkip.includes(q) })),
      autoSkipped: outcome.autoSkipped.map(describeAutoSkip),
      ...(outcome.rejected.length
        ? { rejected: outcome.rejected.map((r) => ({ prompt: r.question.prompt, relationship: r.question.relationship, answer: r.answer, error: r.error })) }
        : {}),
      ...(outcome.unused.length ? { unusedAnswers: outcome.unused } : {}),
      note: notes.join(" "),
    },
    null,
    2
  );
}

/**
 * Source text of the skip helpers for the query panel webview (inline it after
 * ANSWER_WEBVIEW_SOURCE): readKnownAnswers, canSkip, skipLabel, skipTitle,
 * skipAnswer and questionKey, so the webview can default a question's skip
 * button when the host sent no metadata.
 */
export const SKIP_WEBVIEW_SOURCE: string = [readKnownAnswers, canSkip, skipLabel, skipTitle, skipAnswer, questionKey]
  .map((fn) => fn.toString())
  .join("\n");
