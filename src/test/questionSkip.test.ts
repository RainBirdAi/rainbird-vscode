/**
 * Known answers, skipping and automatic "No more", against the real question
 * the public HelloWorld sandbox returned on 2026-10-07 after injecting
 * "Tom lives in France" at certainty 90 and querying speaks for Tom: the
 * engine asked "Where does Tom live?" anyway, with the injected fact in
 * knownAnswers. Skipping it with unanswered: true was accepted and kept the
 * fact: Tom speaks French 71%.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { ApiError } from "../api";
import type { Answer, EngineResponse, Fact, Question } from "../api";
import {
  SKIP_WEBVIEW_SOURCE,
  answerQuestions,
  answersQuestion,
  autoSkipPlan,
  canSkip,
  coveredByInjected,
  injectedFactsFor,
  knownEntries,
  knownValues,
  nearMiss,
  pendingQuestionMessage,
  planGroupAnswers,
  queryToolReply,
  QuestionSession,
  questionKey,
  readAutoSkipMode,
  readKnownAnswers,
  replaySkipRefused,
  skipAnswer,
  skipHint,
  skipLabel,
  skipRejectedNote,
  skipTitle,
  summariseQuestion,
} from "../questionSkip";

/** fixtures/q-injected-singular-cf90.json — the live question, verbatim. */
const LIVE_QUESTION = {
  subject: "Tom",
  dataType: "string",
  relationship: "lives in",
  type: "Second Form Object",
  plural: false,
  allowCF: true,
  allowUnknown: false,
  canAdd: true,
  prompt: "Where does Tom live?",
  knownAnswers: [
    {
      subject: "Tom",
      relationship: {
        name: "lives in",
        subject: "person",
        object: "country",
        plural: false,
        allowCertainty: true,
        allowUnknown: false,
        canAdd: "all",
        askable: "all",
        questions: { en: { firstForm: "Does %S live in %O?", secondFormObject: "Where does %S live?", secondFormSubject: "Who lives in %O?" } },
        metadata: {},
        fsid: 26141217,
        allowCF: true,
        subjectDatasources: [],
        objectType: "string",
        subjectType: "string",
      },
      object: "France",
      cf: 90,
    },
  ],
  concepts: [
    { conceptType: "country", name: "England", type: "string", value: "England" },
    { conceptType: "country", name: "France", type: "string", value: "France" },
  ],
} as Question;

const INJECTED_TOM: Fact[] = [{ subject: "Tom", relationship: "lives in", object: "France", certainty: 90 }];

/** A plural "speaks" question for Fred, with English already known. */
function speaks(overrides: Partial<Question> = {}): Question {
  return {
    relationship: "speaks",
    subject: "Fred",
    prompt: "Which languages does Fred speak?",
    type: "Second Form Object",
    dataType: "string",
    plural: true,
    allowCF: true,
    allowUnknown: false,
    canAdd: false,
    knownAnswers: [{ subject: "Fred", relationship: { name: "speaks", plural: true }, object: "English", cf: 100 }],
    concepts: [{ name: "English" }, { name: "French" }, { name: "German" }],
    ...overrides,
  };
}

const livesIn = (overrides: Partial<Question> = {}): Question => ({ ...LIVE_QUESTION, knownAnswers: [], ...overrides });
const NONE = { mode: "injected" as const, injected: [] as Fact[], noAutoSkip: new Set<string>() };

describe("known answers on the live question", () => {
  test("readKnownAnswers normalises the live shape", () => {
    assert.deepEqual(readKnownAnswers(LIVE_QUESTION), [{ relationship: "lives in", subject: "Tom", object: "France", certainty: 90 }]);
  });

  test("the question can be skipped although allowUnknown is false, and the skip keeps the known answer", () => {
    assert.equal(LIVE_QUESTION.allowUnknown, false);
    assert.equal(canSkip(LIVE_QUESTION), true);
    assert.equal(skipLabel(LIVE_QUESTION), "Keep known answer");
    assert.match(skipTitle(LIVE_QUESTION), /keeps the answer it already has/);
  });

  test("skipAnswer is the verified body: the identifying triple, no object, no certainty", () => {
    assert.deepEqual(skipAnswer(LIVE_QUESTION), { relationship: "lives in", subject: "Tom", unanswered: true });
    assert.equal(questionKey(LIVE_QUESTION), "lives in|Tom|");
    assert.equal(questionKey(skipAnswer(LIVE_QUESTION)), questionKey(LIVE_QUESTION));
  });

  test("known values and labels, marked injected when this session's facts supply them", () => {
    assert.deepEqual(knownValues(LIVE_QUESTION), ["France"]);
    assert.deepEqual(knownEntries(LIVE_QUESTION), [{ value: "France", certainty: 90, injected: false, label: "France (90%)" }]);
    assert.deepEqual(knownEntries(LIVE_QUESTION, INJECTED_TOM), [{ value: "France", certainty: 90, injected: true, label: "France (90%)" }]);
    assert.equal(knownEntries(LIVE_QUESTION, [{ subject: "tom", relationship: "lives in", object: "France" }])[0].injected, false, "case-sensitive");
  });
});

describe("readKnownAnswers tolerates other shapes", () => {
  test("a relationship name string and the certainty alias", () => {
    assert.deepEqual(readKnownAnswers(speaks({ knownAnswers: [{ subject: "Fred", relationship: "speaks", object: "English", certainty: 80 }] })), [
      { relationship: "speaks", subject: "Fred", object: "English", certainty: 80 },
    ]);
  });

  test("bare values are the asked side; junk is dropped", () => {
    const q = speaks({ knownAnswers: ["French", null, 7, {}, { relationship: "speaks" }, { object: "German", cf: "75" }] as unknown as Question["knownAnswers"] });
    assert.deepEqual(readKnownAnswers(q), [
      { relationship: "speaks", object: "French" },
      { relationship: "speaks", object: 7 },
      { relationship: "speaks", object: "German", certainty: 75 },
    ]);
    const sfs = livesIn({ type: "Second Form Subject", subject: undefined, object: "France", knownAnswers: ["Tom"] as unknown as Question["knownAnswers"] });
    assert.deepEqual(readKnownAnswers(sfs), [{ relationship: "lives in", subject: "Tom" }]);
    assert.deepEqual(knownValues(sfs), ["Tom"], "a subject question's known values are subjects");
  });

  test("no knownAnswers, or not an array", () => {
    assert.deepEqual(readKnownAnswers(livesIn()), []);
    assert.deepEqual(readKnownAnswers(livesIn({ knownAnswers: undefined })), []);
    assert.deepEqual(readKnownAnswers({ knownAnswers: "France" }), []);
  });

  test("known date values are formatted", () => {
    const q = livesIn({ relationship: "has date of birth", dataType: "date", knownAnswers: [{ subject: "Tom", object: 370742400000, cf: 100 }] });
    assert.deepEqual(knownEntries(q), [{ value: "1981-10-01", certainty: 100, injected: false, label: "1981-10-01" }]);
  });
});

describe("canSkip, skipLabel and skipAnswer", () => {
  test("labels: No more (plural with known answers), Keep known answer, Don’t know", () => {
    assert.equal(skipLabel(speaks()), "No more");
    assert.equal(skipLabel(LIVE_QUESTION), "Keep known answer");
    assert.equal(skipLabel(speaks({ type: "First Form", object: "French" })), "Keep known answer", "a yes/no confirmation is never 'no more'");
    assert.equal(skipLabel(speaks({ knownAnswers: [], allowUnknown: true })), "Don\u2019t know", "the typographic apostrophe of the panel's existing button");
    assert.match(skipTitle(speaks()), /keeps the answers it already has/);
    assert.match(skipTitle(livesIn({ allowUnknown: true })), /carries on without this fact/);
  });

  test("canSkip needs allowUnknown or known answers (otherwise the engine answers 400)", () => {
    assert.equal(canSkip(livesIn()), false);
    assert.equal(canSkip(livesIn({ allowUnknown: true })), true);
    assert.equal(canSkip(speaks()), true);
  });

  test("skipAnswer leaves out the asked value for each form", () => {
    assert.deepEqual(skipAnswer(speaks()), { relationship: "speaks", subject: "Fred", unanswered: true });
    const sfs = livesIn({ type: "Second Form Subject", subject: undefined, object: "France", prompt: "Who lives in France?" });
    assert.deepEqual(skipAnswer(sfs), { relationship: "lives in", object: "France", unanswered: true });
    const ff = speaks({ type: "First Form", object: "French", prompt: "Does Fred speak French?" });
    assert.deepEqual(skipAnswer(ff), { relationship: "speaks", subject: "Fred", object: "French", unanswered: true });
    for (const q of [speaks(), sfs, ff]) assert.equal(questionKey(skipAnswer(q)), questionKey(q));
  });
});

describe("matching answers and injected facts to questions", () => {
  test("answersQuestion: relationship, then the identifying side when both give it", () => {
    const q = speaks();
    assert.equal(answersQuestion({ relationship: "speaks", subject: "Fred", object: "French" }, q), true);
    assert.equal(answersQuestion({ relationship: "speaks", object: "French" }, q), true, "no subject: relationship decides");
    assert.equal(answersQuestion({ relationship: "speaks", subject: "Ann", object: "French" }, q), false);
    assert.equal(answersQuestion({ relationship: "lives in", subject: "Fred", object: "France" }, q), false);
    const sfs = livesIn({ type: "Second Form Subject", subject: undefined, object: "France" });
    assert.equal(answersQuestion({ relationship: "lives in", subject: "Tom", object: "France" }, sfs), true);
    assert.equal(answersQuestion({ relationship: "lives in", subject: "Tom", object: "Spain" }, sfs), false);
    const dob = livesIn({ type: "Second Form Subject", relationship: "born on", dataType: "date", subject: undefined, object: "370742400000" });
    assert.equal(answersQuestion({ relationship: "born on", subject: "Tom", object: "1981-10-01" }, dob), true, "dates compare canonically");
  });

  test("injectedFactsFor: exact, case-sensitive subject + relationship (object + relationship for a subject question)", () => {
    const facts: Fact[] = [
      { subject: "Fred", relationship: "speaks", object: "English" },
      { subject: "Fred", relationship: "lives in", object: "France" },
      { subject: "fred", relationship: "speaks", object: "German" },
      { subject: "Ann", relationship: "lives in", object: "France" },
    ];
    assert.deepEqual(injectedFactsFor(speaks(), facts), [facts[0]]);
    assert.equal(coveredByInjected(speaks({ subject: "FRED" }), facts), false);
    const sfs = livesIn({ type: "Second Form Subject", subject: undefined, object: "France" });
    assert.deepEqual(injectedFactsFor(sfs, facts), [facts[1], facts[3]]);
    const ff = speaks({ type: "First Form", object: "English" });
    assert.deepEqual(injectedFactsFor(ff, facts), [facts[0]]);
    assert.deepEqual(injectedFactsFor(speaks({ type: "First Form", object: "French" }), facts), []);
  });

  test("nearMiss flags instance names that differ only by case", () => {
    const facts: Fact[] = [{ subject: "fred", relationship: "speaks", object: "English" }];
    const miss = nearMiss(speaks(), facts);
    assert.ok(miss);
    assert.equal(miss.asked, "Fred");
    assert.equal(miss.injected, "fred");
    assert.equal(miss.message, 'Facts were injected for "fred", but the engine is asking about "Fred". Instance names are case-sensitive, so those facts do not cover this question.');
    assert.equal(nearMiss(speaks(), [{ subject: "Fred", relationship: "speaks", object: "English" }]), undefined, "an exact match is no near miss");
    assert.equal(nearMiss(speaks(), [{ subject: "fred", relationship: "Speaks", object: "English" }]), undefined, "relationships must match exactly");
    assert.equal(nearMiss(speaks(), [{ subject: "Fredo", relationship: "speaks", object: "English" }]), undefined);
    assert.equal(nearMiss(livesIn({ type: "Second Form Subject", subject: undefined, object: "France" }), [{ subject: "Tom", relationship: "lives in", object: "france" }])?.injected, "france");
  });
});

describe("autoSkipPlan", () => {
  const injected: Fact[] = [{ subject: "Fred", relationship: "speaks", object: "English" }];
  const plan = (q: Question, mode: "injected" | "known" | "off", noAutoSkip = new Set<string>()) => autoSkipPlan([q], { mode, injected, noAutoSkip })[0];

  test("skips a plural question covered by this session's injected facts, listing the injected values", () => {
    assert.deepEqual(plan(speaks(), "injected"), { skip: true, reason: "injected", values: ["English"] });
  });

  test("never skips singular, first-form, suppressed or unskippable questions, or with the setting off", () => {
    assert.deepEqual(plan(speaks(), "off"), { skip: false, reason: "off", values: [] });
    assert.equal(plan(speaks({ plural: false }), "injected").reason, "singular");
    assert.equal(plan(speaks({ type: "First Form", object: "English" }), "injected").reason, "first-form");
    assert.equal(plan(speaks(), "injected", new Set([questionKey(speaks())])).reason, "suppressed");
    assert.equal(plan(speaks({ knownAnswers: [] }), "injected").reason, "cannot-skip", "covered, but the engine would refuse the skip");
    assert.equal(plan(speaks({ knownAnswers: [], allowUnknown: true }), "injected").skip, true, "allowUnknown makes it skippable");
  });

  test("an instance named differently is not covered", () => {
    assert.equal(plan(speaks({ subject: "Ann", knownAnswers: [{ subject: "Ann", object: "English" }] }), "injected").reason, "not-covered");
  });

  test("known mode also skips whenever the engine already holds answers", () => {
    const fromMap = speaks({ subject: "Ann", knownAnswers: [{ subject: "Ann", object: "French", cf: 100 }] });
    assert.deepEqual(plan(fromMap, "known"), { skip: true, reason: "known", values: ["French"] });
    assert.equal(plan(fromMap, "injected").skip, false);
    assert.deepEqual(plan(speaks(), "known"), { skip: true, reason: "injected", values: ["English"] });
  });

  test("one decision per question, in group order", () => {
    const decisions = autoSkipPlan([LIVE_QUESTION, speaks()], { mode: "injected", injected, noAutoSkip: new Set() });
    assert.deepEqual(decisions.map((d) => d.skip), [false, true]);
  });

  test("readAutoSkipMode defaults to injected", () => {
    assert.equal(readAutoSkipMode("known"), "known");
    assert.equal(readAutoSkipMode("off"), "off");
    assert.equal(readAutoSkipMode(undefined), "injected");
    assert.equal(readAutoSkipMode("sometimes"), "injected");
  });
});

describe("planGroupAnswers (run_query)", () => {
  const dob = livesIn({ relationship: "has date of birth", prompt: "When was Tom born?", dataType: "date", concepts: [] });
  const age = livesIn({ relationship: "has age", prompt: "How old is Tom?", dataType: "number", concepts: [] });

  test("matches answers by relationship, not by position, and sends the group in group order", () => {
    const result = planGroupAnswers([dob, age], [{ relationship: "has age", subject: "Tom", object: "41" }, { relationship: "has date of birth", subject: "Tom", object: "1st October 1981" }], NONE);
    assert.deepEqual(result.batch, [
      { relationship: "has date of birth", subject: "Tom", object: "1981-10-01" },
      { relationship: "has age", subject: "Tom", object: 41 },
    ]);
    assert.deepEqual(result.remaining, []);
  });

  test("answers without a relationship fall back to position; the rest wait for later groups", () => {
    const result = planGroupAnswers([LIVE_QUESTION], [{ object: "England" }, { object: "Spain" }, { relationship: "speaks", subject: "Tom", object: "French" }], NONE);
    assert.deepEqual(result.batch, [{ relationship: "lives in", subject: "Tom", object: "England" }]);
    assert.deepEqual(result.remaining, [{ object: "Spain" }, { relationship: "speaks", subject: "Tom", object: "French" }]);
  });

  test("a plural question takes several answers; certainty and cf are kept, never both", () => {
    const result = planGroupAnswers([speaks()], [{ relationship: "speaks", subject: "Fred", object: "French", certainty: 80 }, { relationship: "speaks", subject: "Fred", object: "German", cf: 60 }], NONE);
    assert.deepEqual(result.batch, [
      { relationship: "speaks", subject: "Fred", object: "French", certainty: 80 },
      { relationship: "speaks", subject: "Fred", object: "German", cf: 60 },
    ]);
  });

  test("values are checked before anything is sent", () => {
    const result = planGroupAnswers([dob, age], [{ relationship: "has date of birth", object: "01/10/1981" }, { relationship: "has age", object: "forty" }], NONE);
    assert.equal(result.batch, undefined);
    assert.deepEqual(result.rejected.map((r) => r.error), [
      "01/10/1981 is ambiguous (1 October 1981 or 10 January 1981) — type 1981-10-01 or 1 October 1981.",
      "A number, e.g. 42 or 3.5. Digits and a decimal point only — no units or thousands separators.",
    ]);
    const cf = planGroupAnswers([age], [{ relationship: "has age", object: 41, certainty: 0 }], NONE);
    assert.deepEqual(cf.rejected.map((r) => r.error), ["Certainty must be a number from 1 to 100."]);
    const both = planGroupAnswers([age], [{ relationship: "has age", object: 41, certainty: 50, cf: 50 }], NONE);
    assert.deepEqual(both.rejected.map((r) => r.error), ["Give certainty or cf, not both."]);
    const two = planGroupAnswers([age], [{ relationship: "has age", object: 41 }, { relationship: "has age", object: 42 }], NONE);
    assert.deepEqual(two.rejected.map((r) => r.error), ["This question takes one answer (it is not plural)."]);
    const ff = planGroupAnswers([speaks({ type: "First Form", object: "French" })], [{ relationship: "speaks", object: "French" }], NONE);
    assert.deepEqual(ff.rejected.map((r) => r.error), ['Answer a first-form question with answer: "yes" or "no".']);
  });

  test("a skip is checked against canSkip and rebuilt with the identifying triple", () => {
    const refused = planGroupAnswers([livesIn()], [{ relationship: "lives in", subject: "Tom", unanswered: true }], NONE);
    assert.match(refused.rejected[0].error, /accepted only when the question has allowUnknown or knownAnswers/);
    const accepted = planGroupAnswers([LIVE_QUESTION], [{ relationship: "lives in", subject: "Tom", object: "", unanswered: true, certainty: 100 }], NONE);
    assert.deepEqual(accepted.batch, [{ relationship: "lives in", subject: "Tom", unanswered: true }]);
  });

  test("auto-skips a covered plural question nobody answered, never one with a supplied answer", () => {
    const opts = { mode: "injected" as const, injected: [{ subject: "Fred", relationship: "speaks", object: "English" }], noAutoSkip: new Set<string>() };
    const fred = livesIn({ subject: "Fred", prompt: "Where does Fred live?" });
    const skipped = planGroupAnswers([speaks(), fred], [{ relationship: "lives in", subject: "Fred", object: "France" }], opts);
    assert.deepEqual(skipped.batch, [
      { relationship: "speaks", subject: "Fred", unanswered: true },
      { relationship: "lives in", subject: "Fred", object: "France" },
    ]);
    assert.deepEqual(skipped.autoSkipped.map((s) => [s.question.relationship, s.reason, s.values]), [["speaks", "injected", ["English"]]]);
    const answered = planGroupAnswers([speaks(), fred], [{ relationship: "speaks", subject: "Fred", object: "German" }, { relationship: "lives in", subject: "Fred", object: "France" }], opts);
    assert.deepEqual(answered.autoSkipped, []);
    assert.deepEqual(answered.batch?.[0], { relationship: "speaks", subject: "Fred", object: "German" });
  });

  test("a group with an unanswered question produces no batch", () => {
    const result = planGroupAnswers([dob, age], [{ relationship: "has age", object: 41 }], NONE);
    assert.equal(result.batch, undefined);
    assert.deepEqual(result.missing, [dob]);
    assert.equal(result.used.length, 1);
  });
});

describe("copy and summaries", () => {
  test("skipRejectedNote is the plan's copy", () => {
    assert.equal(
      skipRejectedNote("Please provide an expected boolean value for unanswered.", { relationship: "speaks" }),
      'The engine would not let this question be skipped (Please provide an expected boolean value for unanswered.). Pick an answer below. If "speaks" should only ever be fed by injected facts, set askable="none" on it in the map — only if every session injects those facts; otherwise rules that need them get no result.'
    );
    assert.match(skipRejectedNote("x", { relationship: "speaks" }, "Pick an answer instead."), /\(x\)\. Pick an answer instead\. If "speaks"/);
  });

  test("replay messages", () => {
    assert.equal(
      pendingQuestionMessage(LIVE_QUESTION),
      'The engine asked an unrecorded question: "Where does Tom live?" (Tom lives in ?) — the map\'s question flow changed. If that is intended, re-record the test from the query panel.'
    );
    const batch: Answer[] = [{ relationship: "speaks", subject: "Fred", unanswered: true }];
    assert.match(replaySkipRefused(batch, "Please provide an expected boolean value for unanswered."), /^The engine refused to skip "speaks" \(Please provide .*\): this test answers it with unanswered: true/);
  });

  test("summariseQuestion gives the model what it needs, without raw concepts", () => {
    const summary = summariseQuestion(LIVE_QUESTION);
    assert.deepEqual(summary, {
      prompt: "Where does Tom live?",
      relationship: "lives in",
      subject: "Tom",
      type: "Second Form Object",
      dataType: "string",
      plural: false,
      allowCF: true,
      canAdd: true,
      expected: "one of the options offered, or a new value as plain text without the characters \" ' \\ < >",
      options: ["England", "France"],
      alreadyKnown: ["France"],
      canSkip: true,
      skipHint: skipHint(LIVE_QUESTION),
    });
    assert.ok(summary.skipHint?.includes(JSON.stringify(skipAnswer(LIVE_QUESTION))), "the hint carries the exact skip body");
    assert.match(skipHint(speaks()), /"no more"/);
    assert.equal(summariseQuestion(livesIn()).skipHint, undefined);
    assert.equal(summariseQuestion(speaks(), { willAutoSkip: true }).willAutoSkip, true);
  });
});

describe("SKIP_WEBVIEW_SOURCE (the copy the webview runs)", () => {
  const inlined = new Function(`${SKIP_WEBVIEW_SOURCE}\nreturn { readKnownAnswers, canSkip, skipLabel, skipTitle, skipAnswer, questionKey };`)() as {
    readKnownAnswers: typeof readKnownAnswers;
    canSkip: typeof canSkip;
    skipLabel: typeof skipLabel;
    skipTitle: typeof skipTitle;
    skipAnswer: typeof skipAnswer;
    questionKey: typeof questionKey;
  };

  test("is self-contained and behaves like the Node import", () => {
    assert.doesNotMatch(SKIP_WEBVIEW_SOURCE, /\bexports\b|\brequire\(|_\d\./);
    assert.ok(!SKIP_WEBVIEW_SOURCE.includes("`"));
    const sfs = livesIn({ type: "Second Form Subject", subject: undefined, object: "France", allowUnknown: true });
    for (const q of [LIVE_QUESTION, speaks(), livesIn(), sfs, speaks({ type: "First Form", object: "French" })]) {
      assert.deepEqual(inlined.readKnownAnswers(q), readKnownAnswers(q));
      assert.equal(inlined.canSkip(q), canSkip(q));
      assert.equal(inlined.skipLabel(q), skipLabel(q));
      assert.equal(inlined.skipTitle(q), skipTitle(q));
      assert.deepEqual(inlined.skipAnswer(q), skipAnswer(q));
      assert.equal(inlined.questionKey(q), questionKey(q));
    }
  });
});

/** A fake client answering /response from a script: each step is an engine response or an error to throw. */
function scripted(steps: (EngineResponse | Error)[]) {
  const calls: Answer[][] = [];
  return {
    calls,
    async respond(_sessionId: string, answers: Answer[]): Promise<EngineResponse> {
      calls.push(answers);
      const step = steps.shift();
      if (!step) throw new Error("unexpected /response call");
      if (step instanceof Error) throw step;
      return step;
    },
  };
}

const asked = (question: Question, ...extra: Question[]): EngineResponse => ({ kind: "question", question, extraQuestions: extra });
const RESULT: EngineResponse = { kind: "result", result: [{ subject: "Fred", relationship: "speaks", object: "French", certainty: 75, factID: "WA:RF:1" }] };
const refused = () => new ApiError("Rainbird API 400", 400, JSON.stringify({ err: ["Please provide an expected boolean value for unanswered."] }));
const fredSession = (): QuestionSession => ({ facts: [{ subject: "Fred", relationship: "speaks", object: "English" }], noAutoSkip: new Set(), pending: [] });

describe("answerQuestions (the run_query loop)", () => {
  test("answers 'no more' for a plural question the injected facts cover, then returns the result", async () => {
    const client = scripted([RESULT]);
    const session = fredSession();
    const outcome = await answerQuestions(client, "s1", asked(speaks()), [], session, { mode: "injected" });
    assert.deepEqual(client.calls, [[{ relationship: "speaks", subject: "Fred", unanswered: true }]]);
    assert.equal(outcome.kind, "result");
    assert.deepEqual(session.pending, []);
    const reply = JSON.parse(queryToolReply(outcome, { sessionId: "s1", kmId: "km" }));
    assert.equal(reply.status, "result");
    assert.equal(reply.kmId, "km");
    assert.deepEqual(reply.autoSkipped, [
      { prompt: "Which languages does Fred speak?", relationship: "speaks", subject: "Fred", reason: "covered by the injected facts", values: ["English"] },
    ]);
  });

  test("with the setting off, the same question comes back to the model with what is known and how to skip", async () => {
    const client = scripted([]);
    const outcome = await answerQuestions(client, "s1", asked(speaks()), [], fredSession(), { mode: "off" });
    assert.equal(client.calls.length, 0);
    const reply = JSON.parse(queryToolReply(outcome, { sessionId: "s1" }));
    assert.equal(reply.status, "question");
    assert.deepEqual(reply.autoSkipped, [], "always present");
    assert.deepEqual(reply.questions[0].alreadyKnown, ["English"]);
    assert.equal(reply.questions[0].canSkip, true);
    assert.match(reply.questions[0].skipHint, /\{"relationship":"speaks","subject":"Fred","unanswered":true\}/);
    assert.deepEqual(reply.questions[0].options, ["English", "French", "German"]);
    assert.equal(reply.questions[0].concepts, undefined, "no raw concepts");
  });

  test("a refused automatic skip is never retried: the question comes back with the engine's message", async () => {
    const client = scripted([refused()]);
    const session = fredSession();
    const outcome = await answerQuestions(client, "s1", asked(speaks()), [], session, { mode: "injected" });
    assert.equal(client.calls.length, 1);
    assert.ok(session.noAutoSkip.has(questionKey(speaks())));
    assert.equal(outcome.kind, "question");
    const reply = JSON.parse(queryToolReply(outcome, { sessionId: "s1" }));
    assert.match(reply.note, /would not let a question be skipped automatically \(Please provide an expected boolean value for unanswered\.\)/);
    assert.equal(reply.questions[0].willAutoSkip, undefined);
  });

  test("a refused batch that also carried the model's answers is reported neutrally", async () => {
    const fred = livesIn({ subject: "Fred", prompt: "Where does Fred live?" });
    const client = scripted([new ApiError("400", 400, JSON.stringify({ err: ["Invalid answer"] }))]);
    const session = fredSession();
    const outcome = await answerQuestions(client, "s1", asked(speaks(), fred), [{ relationship: "lives in", subject: "Fred", object: "Spain" }], session, { mode: "injected" });
    assert.deepEqual(client.calls, [
      [
        { relationship: "speaks", subject: "Fred", unanswered: true },
        { relationship: "lives in", subject: "Fred", object: "Spain" },
      ],
    ]);
    assert.ok(session.noAutoSkip.has(questionKey(speaks())), "the automatic skip is withdrawn for good");
    assert.ok(outcome.kind === "question" && outcome.refusedSkip === "Invalid answer" && outcome.refusedWithAnswers === true && !outcome.partial);
    const reply = JSON.parse(queryToolReply(outcome, { sessionId: "s1" }));
    assert.match(
      reply.note,
      /^Rainbird rejected this group \(Invalid answer\); the automatic "no more" was withdrawn in case it was the cause — check your answers and answer the whole group\./
    );
    assert.doesNotMatch(reply.note, /would not let a question be skipped|Only part of this group/);
    assert.deepEqual(reply.questions.map((q: { willAutoSkip?: boolean }) => q.willAutoSkip), [undefined, undefined]);
  });

  test("a question asked again after an automatic skip is not skipped a second time", async () => {
    const client = scripted([asked(speaks())]);
    const outcome = await answerQuestions(client, "s1", asked(speaks()), [], fredSession(), { mode: "injected" });
    assert.equal(client.calls.length, 1);
    assert.equal(outcome.kind, "question");
    if (outcome.kind === "question") assert.equal(outcome.autoSkipped.length, 1);
  });

  test("answers are matched across groups by relationship and each group goes out in one call", async () => {
    const age = livesIn({ relationship: "has age", prompt: "How old is Tom?", dataType: "number", concepts: [] });
    const dob = livesIn({ relationship: "has date of birth", prompt: "When was Tom born?", dataType: "date", concepts: [] });
    const client = scripted([asked(LIVE_QUESTION), RESULT]);
    const supplied: Answer[] = [
      { relationship: "lives in", subject: "Tom", object: "England" },
      { relationship: "has date of birth", subject: "Tom", object: "1 October 1981" },
      { relationship: "has age", subject: "Tom", object: 41 },
      { relationship: "owns", subject: "Tom", object: "Car" },
    ];
    const outcome = await answerQuestions(client, "s1", asked(age, dob), supplied, { facts: [], noAutoSkip: new Set(), pending: [] }, { mode: "injected" });
    assert.deepEqual(client.calls, [
      [
        { relationship: "has age", subject: "Tom", object: 41 },
        { relationship: "has date of birth", subject: "Tom", object: "1981-10-01" },
      ],
      [{ relationship: "lives in", subject: "Tom", object: "England" }],
    ]);
    assert.equal(outcome.kind, "result");
    assert.deepEqual(JSON.parse(queryToolReply(outcome, { sessionId: "s1" })).unusedAnswers, [{ relationship: "owns", subject: "Tom", object: "Car" }]);
  });

  test("answers refused before sending never reach the engine", async () => {
    const dob = livesIn({ relationship: "has date of birth", prompt: "When was Tom born?", dataType: "date", concepts: [] });
    const client = scripted([]);
    const outcome = await answerQuestions(client, "s1", asked(dob), [{ relationship: "has date of birth", object: "01/10/1981" }], { facts: [], noAutoSkip: new Set(), pending: [] }, { mode: "injected" });
    assert.equal(client.calls.length, 0);
    const reply = JSON.parse(queryToolReply(outcome, { sessionId: "s1" }));
    assert.equal(reply.rejected[0].error, "01/10/1981 is ambiguous (1 October 1981 or 10 January 1981) — type 1981-10-01 or 1 October 1981.");
    assert.match(reply.note, /Some answers were not sent/);
  });

  test("a 400 on supplied answers stops with the engine's message; other errors propagate", async () => {
    const outcome = await answerQuestions(scripted([new ApiError("400", 400, JSON.stringify({ err: ["Invalid answer"] }))]), "s1", asked(LIVE_QUESTION), [{ relationship: "lives in", object: "Spain" }], { facts: [], noAutoSkip: new Set(), pending: [] }, { mode: "injected" });
    assert.equal(outcome.kind === "question" && outcome.engineError, "Invalid answer");
    assert.match(JSON.parse(queryToolReply(outcome, { sessionId: "s1" })).note, /Rainbird rejected the answers for this group \(Invalid answer\); nothing was recorded/);
    await assert.rejects(
      answerQuestions(scripted([new ApiError("404", 404, "")]), "s1", asked(LIVE_QUESTION), [{ relationship: "lives in", object: "Spain" }], { facts: [], noAutoSkip: new Set(), pending: [] }, { mode: "injected" }),
      /404/
    );
  });

  test("a 400 without a message is still reported to the model", async () => {
    const outcome = await answerQuestions(scripted([new ApiError("400", 400, "")]), "s1", asked(LIVE_QUESTION), [{ relationship: "lives in", object: "Spain" }], { facts: [], noAutoSkip: new Set(), pending: [] }, { mode: "injected" });
    assert.match(JSON.parse(queryToolReply(outcome, { sessionId: "s1" })).note, /^Rainbird rejected the answers for this group; nothing was recorded\./);
  });

  test("the pending group is remembered for the next call", async () => {
    const session: QuestionSession = { facts: [], noAutoSkip: new Set(), pending: [] };
    await answerQuestions(scripted([]), "s1", asked(LIVE_QUESTION), [], session, { mode: "injected" });
    assert.deepEqual(session.pending, [LIVE_QUESTION]);
  });
});
