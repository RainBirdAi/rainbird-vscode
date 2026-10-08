/**
 * The query panel's questions region. Webview behaviour is driven in
 * happy-dom with question messages decorated exactly as the host decorates
 * them (decorateQuestions, JSON round-tripped like postMessage); the host-side
 * helpers that shape those messages and turn the card's payloads back into a
 * /response batch are tested directly; and the region's host steps
 * (QuestionFlow: automatic "No more", Answer instead, refusals, Back, Make
 * inject-only, logging, late replies, no reply and expired sessions) run
 * against a scripted engine with the real webview, the way QueryPanel wires
 * them. Where the focus goes after each step is checked here too, for the
 * result card as well (the results region's own suite is
 * queryPanelResults.test.ts).
 *
 * The cards are tested without the setup card's controls (no Start click), so
 * these tests do not depend on how the setup region is built.
 */
import { describe, test } from "node:test";
import type { HTMLButtonElement, HTMLInputElement } from "happy-dom";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { ApiError } from "../api";
import type { Answer, EngineResponse, Fact, Question, ResultItem } from "../api";
import { answerHints, describeAmbiguousDate, rejectionNote } from "../answers";
import { autoSkipPlan, questionKey, skipLabel, skipRejectedNote } from "../questionSkip";
import { render } from "../queryPanelHtml";
import {
  AnswerCheckError,
  answersFor,
  autoSkipFailedNote,
  autoSkipItems,
  checkNote,
  checkValue,
  decorateQuestions,
  groupRejectedNote,
  INJECT_ONLY_ACTION,
  injectOnlyPrompt,
  isSkipPayload,
  jsonLines,
  noReplyNote,
  QuestionFlow,
  refusedNote,
} from "../queryWebview/questions";
import type { AnswerPayload, CardContext, QuestionEngine, QuestionRecord } from "../queryWebview/questions";
import { loadWebview } from "./webviewHarness";
import type { Posted, WebviewHarness } from "./webviewHarness";

const HINTS = answerHints();

/** The live HelloWorld question (fixtures/q-injected-singular-cf90.json, trimmed): Tom lives in France was injected at 90. */
const LIVES_IN: Question = {
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
    { subject: "Tom", relationship: { name: "lives in", subject: "person", object: "country", plural: false, canAdd: "all", askable: "all" }, object: "France", cf: 90 },
  ],
  concepts: [
    { conceptType: "country", name: "England", type: "string", value: "England" },
    { conceptType: "country", name: "France", type: "string", value: "France" },
  ],
};
const TOM_FACTS: Fact[] = [{ subject: "Tom", relationship: "lives in", object: "France", certainty: 90 }];

function question(overrides: Partial<Question> = {}): Question {
  return {
    relationship: "has answer",
    subject: "Fred",
    prompt: "What is the answer?",
    type: "Second Form Object",
    dataType: "string",
    plural: false,
    allowCF: false,
    allowUnknown: false,
    canAdd: false,
    concepts: [],
    knownAnswers: [],
    ...overrides,
  };
}
const concepts = (...names: string[]) => names.map((name) => ({ conceptType: "thing", name, type: "string", value: name }));

/** Fred speaks: plural, English injected this session and French known from elsewhere. */
function speaks(overrides: Partial<Question> = {}): Question {
  return question({
    relationship: "speaks",
    prompt: "Which languages does Fred speak?",
    plural: true,
    knownAnswers: [
      { subject: "Fred", relationship: { name: "speaks", plural: true }, object: "English", cf: 100 },
      { subject: "Fred", relationship: { name: "speaks", plural: true }, object: "French", cf: 100 },
    ],
    concepts: concepts("English", "French", "German", "Spanish"),
    ...overrides,
  });
}
const FRED_SPEAKS_ENGLISH: Fact[] = [{ subject: "Fred", relationship: "speaks", object: "English", certainty: 100 }];

const truthQ = (overrides: Partial<Question> = {}) =>
  question({ relationship: "is resident", prompt: "Is Fred resident?", dataType: "truth", concepts: concepts("true", "true"), ...overrides });
const numberQ = (overrides: Partial<Question> = {}) =>
  question({ relationship: "earns", prompt: "How much does Fred earn?", dataType: "number", concepts: concepts("0", "0"), ...overrides });
const dateQ = (overrides: Partial<Question> = {}) =>
  question({ relationship: "was born on", prompt: "When was Fred born?", dataType: "date", ...overrides });
const countryQ = (overrides: Partial<Question> = {}) =>
  question({ relationship: "lives in", prompt: "Where does Fred live?", canAdd: true, concepts: concepts("England", "France"), ...overrides });

/** A page with a question in progress: the engine is reasoning (spinner shown). */
function page(): WebviewHarness {
  const p = loadWebview(render("test-nonce"));
  p.send({ type: "busy" });
  return p;
}
/** Post a question group the way the host does: decorated, then JSON round-tripped like postMessage. */
function ask(p: WebviewHarness, group: Question[], extra: Record<string, unknown> = {}, ctx: CardContext = {}): void {
  p.send(JSON.parse(JSON.stringify({ type: "question", questions: decorateQuestions(group, ctx), ...extra })) as Posted);
}
const buttons = (p: WebviewHarness, selector: string) => p.$$(selector).map((b) => String(b.textContent));
const payloadsOf = (message: Posted | undefined) => (message?.payloads ?? []) as AnswerPayload[];
const answers = (p: WebviewHarness) => p.posted.filter((m) => m.type === "answer");
const transcript = (p: WebviewHarness) => p.$$(".transcript").map((t) => p.text(t));
/**
 * Whether the element the selector matches has the focus. A boolean, because a failing
 * assert.equal on two DOM elements makes node inspect the whole happy-dom window.
 */
const hasFocus = (p: WebviewHarness, selector: string) => {
  const target = p.$(selector);
  return !!target && (p.window.document.activeElement as unknown) === target;
};
const input = (p: WebviewHarness, selector: string) => p.$(selector) as unknown as HTMLInputElement;
/** An element of the newest question card (earlier cards stay when a test asks again without answering). */
function inLast(p: WebviewHarness, selector: string) {
  const cards = p.$$(".qcard");
  const found = cards[cards.length - 1]?.querySelector(selector);
  if (!found) throw new Error(`No ${selector} in the last card`);
  return found as unknown as HTMLInputElement;
}

describe("controls by kind (A-1)", () => {
  test("a truth question with duplicate “true” concepts shows exactly True / False", async () => {
    const p = page();
    ask(p, [truthQ()]);
    assert.deepEqual(buttons(p, ".qcard .ctl button"), ["True", "False"]);
    assert.equal(p.$$("[data-pick]").length, 0, "no concept buttons");
    p.click("[data-truth=false]");
    assert.deepEqual(payloadsOf(p.lastPosted("answer")), [{ kind: "value", value: "false", certainty: 100 }]);
    await p.close();
  });

  test("a number question with concepts 0, 0 gets a decimal text field, one suggestion and the hint", async () => {
    const p = page();
    ask(p, [numberQ()]);
    const field = input(p, ".qcard input.val");
    assert.equal(field.getAttribute("type"), "text");
    assert.equal(field.getAttribute("inputmode"), "decimal");
    assert.deepEqual(buttons(p, "[data-fill]"), ["0"], "known values are a single fill-in suggestion, never a closed set");
    assert.equal(p.$$("[data-pick]").length, 0);
    assert.match(p.text(".qcard .hint"), new RegExp(HINTS.number.slice(0, 30)));

    p.type(".qcard input.val", "1,000");
    p.click("[data-act=submit]");
    assert.equal(answers(p).length, 0, "an invalid number is not sent");
    assert.equal(p.text(".qcard .miss"), HINTS.number);

    p.click("[data-fill]");
    assert.equal(field.value, "0", "the suggestion fills the field");
    assert.equal(p.text(".qcard .miss"), "", "editing clears the message");
    p.type(".qcard input.val", " 42 ");
    p.key(".qcard input.val");
    assert.deepEqual(payloadsOf(p.lastPosted("answer")), [{ kind: "value", value: "42", certainty: 100 }]);
    await p.close();
  });

  test("a string question offers “Or something else” only when canAdd allows it or the engine listed nothing", async () => {
    const p = page();
    ask(p, [countryQ({ canAdd: false })]);
    assert.deepEqual(buttons(p, "[data-pick]"), ["England", "France"]);
    assert.equal(p.$$(".qcard input.other").length, 0, "closed list");
    assert.equal(p.$$("[data-act=submit]").length, 0, "picks answer in one click");
    p.click(p.$$("[data-pick]")[1]);
    assert.deepEqual(payloadsOf(p.lastPosted("answer")), [{ kind: "value", value: "France", certainty: 100 }]);

    ask(p, [countryQ({ canAdd: true })]);
    assert.ok(p.$(".qcard input.other"), "canAdd: a typed answer as well");
    p.type(".qcard input.other", "Wales");
    p.key(".qcard input.other");
    assert.deepEqual(payloadsOf(p.lastPosted("answer")), [{ kind: "value", value: "Wales", certainty: 100 }]);

    ask(p, [question({ concepts: [], canAdd: false })]);
    assert.ok(p.$(".qcard input.val"), "no concepts at all: a text field even though canAdd is false");
    p.type(".qcard input.val", "it's <odd>");
    p.click("[data-act=submit]");
    assert.match(p.text(".qcard .miss"), /does not accept the characters/);
    await p.close();
  });

  test("duplicate concepts are offered once, and the certainty slider runs from 1 to 100", async () => {
    const p = page();
    ask(p, [countryQ({ concepts: concepts("England", "England", "France"), canAdd: false, allowCF: true })]);
    assert.deepEqual(buttons(p, "[data-pick]"), ["England", "France"]);
    const cf = input(p, ".qcard .cf");
    assert.equal(cf.getAttribute("min"), "1");
    assert.equal(cf.getAttribute("max"), "100");
    p.type(".qcard .cf", "60");
    assert.equal(p.text(".qcard .cfv"), "60%");
    p.click(p.$$("[data-pick]")[0]);
    assert.deepEqual(payloadsOf(p.lastPosted("answer")), [{ kind: "value", value: "England", certainty: 60 }]);
    await p.close();
  });
});

describe("date entry (A-2)", () => {
  test("“1st October 1981” previews 1981-10-01 and posts the ISO value plus what was typed", async () => {
    const p = page();
    ask(p, [dateQ()]);
    const field = input(p, ".qcard input.val.date");
    assert.equal(field.getAttribute("placeholder"), HINTS.datePlaceholder);
    assert.ok(p.$(".qcard input.cal[type=date]"), "a calendar beside the field");
    assert.equal((p.$("[data-act=submit]") as unknown as HTMLButtonElement).disabled, true, "nothing to send yet");
    p.type(".qcard input.val.date", "1st October 1981");
    assert.equal(p.text(".qcard .preview"), "Will send 1981-10-01 (Thursday 1 October 1981)");
    assert.equal((p.$("[data-act=submit]") as unknown as HTMLButtonElement).disabled, false);
    p.click("[data-act=submit]");
    assert.deepEqual(payloadsOf(p.lastPosted("answer")), [{ kind: "value", value: "1981-10-01", raw: "1st October 1981", certainty: 100 }]);
    await p.close();
  });

  test("“01/10/1981” offers both readings and blocks Submit until one is chosen", async () => {
    const p = page();
    ask(p, [dateQ()]);
    p.type(".qcard input.val.date", "01/10/1981");
    assert.deepEqual(buttons(p, ".preview .datechoice"), ["1 October 1981", "10 January 1981"]);
    const submit = p.$("[data-act=submit]") as unknown as HTMLButtonElement;
    assert.equal(submit.disabled, true);
    p.click(submit);
    p.key(".qcard input.val.date");
    assert.equal(answers(p).length, 0, "neither Submit nor Enter sends an ambiguous date");
    assert.equal(p.text(".qcard .miss"), "Choose which date you mean: 1 October 1981 or 10 January 1981.");

    p.click(p.$$(".preview .datechoice")[1]);
    assert.equal(input(p, ".qcard input.val.date").value, "1981-01-10", "the choice sets the field to that date");
    assert.equal(p.text(".qcard .preview"), "Will send 1981-01-10 (Saturday 10 January 1981)");
    p.click("[data-act=submit]");
    assert.deepEqual(payloadsOf(p.lastPosted("answer")), [{ kind: "value", value: "1981-01-10", raw: "1981-01-10", certainty: 100 }]);
    await p.close();
  });

  test("the date order setting only orders the two readings; errors show, empty input shows nothing", async () => {
    const p = page();
    ask(p, [dateQ()], {}, { dateOrder: "month-first" });
    p.type(".qcard input.val.date", "01/10/1981");
    assert.deepEqual(buttons(p, ".preview .datechoice"), ["10 January 1981", "1 October 1981"]);
    p.type(".qcard input.val.date", "31/02/1981");
    assert.equal(p.text(".qcard .preview"), "31 February 1981 is not a real date.");
    assert.ok(p.$(".qcard .preview.bad"));
    p.type(".qcard input.val.date", "1 Oct 81");
    assert.equal(p.text(".qcard .preview"), HINTS.dateFourDigitYear);
    p.type(".qcard input.val.date", "");
    assert.equal(p.text(".qcard .preview"), "");
    assert.equal(p.$$(".qcard .preview.bad").length, 0);
    await p.close();
  });

  test("the calendar fills the same field", async () => {
    const p = page();
    ask(p, [dateQ()]);
    p.type(".qcard input.cal", "2001-09-09");
    assert.equal(input(p, ".qcard input.val.date").value, "2001-09-09");
    assert.equal(p.text(".qcard .preview"), "Will send 2001-09-09 (Sunday 9 September 2001)");
    await p.close();
  });

  test("clearing the calendar (or one part of its date) leaves the typed text as it is", async () => {
    const p = page();
    ask(p, [dateQ()]);
    p.type(".qcard input.val.date", "1 October 1981");
    assert.equal(input(p, ".qcard input.cal").value, "1981-10-01", "the calendar follows the text");
    p.type(".qcard input.cal", "");
    assert.equal(input(p, ".qcard input.val.date").value, "1 October 1981");
    assert.equal(input(p, ".qcard input.cal").value, "", "and can be cleared");
    assert.equal(p.text(".qcard .preview"), "Will send 1981-10-01 (Thursday 1 October 1981)");
    p.click("[data-act=submit]");
    assert.deepEqual(payloadsOf(p.lastPosted("answer")), [{ kind: "value", value: "1981-10-01", raw: "1 October 1981", certainty: 100 }]);
    await p.close();
  });
});

describe("known answers and the skip button (P-1)", () => {
  test("“Already known” lists the engine's answers; plural chips show them ticked and locked, and they are not sent again", async () => {
    const p = page();
    ask(p, [speaks()], {}, { facts: FRED_SPEAKS_ENGLISH });
    assert.equal(p.text(".qcard .knownLine"), "Already known: English (injected), French");
    const locked = p.$$(".qcard .chip.known");
    assert.deepEqual(locked.map((c) => String(c.textContent)), ["✓ English", "✓ French"]);
    assert.ok(locked.every((c) => c.hasAttribute("disabled") && c.getAttribute("aria-pressed") === "true"));
    assert.deepEqual(buttons(p, "[data-opt]"), ["German", "Spanish"], "known values are not offered again");
    p.click("[data-opt=German]");
    p.click("[data-act=submit]");
    assert.deepEqual(payloadsOf(p.lastPosted("answer")), [{ kind: "multi", values: ["German"], certainty: 100 }]);
    await p.close();
  });

  test("locked chips look like the other chips: the “Already known” line's style is its own", async () => {
    const p = page();
    ask(p, [speaks()], {}, { facts: FRED_SPEAKS_ENGLISH });
    const style = (selector: string) => {
      const css = p.window.getComputedStyle(p.$(selector) as never);
      return { margin: css.margin, fontSize: css.fontSize };
    };
    assert.deepEqual(style(".qcard .chip[data-known]"), style(".qcard .chip[data-opt]"));
    assert.notDeepEqual(style(".qcard .knownLine"), style(".qcard .chip[data-opt]"), "the line itself is smaller");
    assert.equal(p.$$(".qcard .knownLine").length, 1);
    await p.close();
  });

  test("the skip button is labelled by skipLabel, posts kind “skip”, and the transcript uses the label", async () => {
    const p = page();
    const q = speaks();
    ask(p, [q], {}, { facts: FRED_SPEAKS_ENGLISH });
    const skip = p.$(".qcard [data-skip]");
    assert.ok(skip);
    assert.equal(skip.textContent, "No more");
    assert.equal(skip.textContent, skipLabel(q));
    assert.match(String(skip.getAttribute("title")), /Add nothing more/);
    p.click(skip);
    assert.deepEqual(payloadsOf(p.lastPosted("answer")), [{ kind: "skip" }]);
    assert.equal(p.$$(".qcard").length, 0, "the card is gone");
    assert.deepEqual(transcript(p), [], "nothing written until the engine accepts the answer");
    ask(p, [numberQ()]);
    assert.deepEqual(transcript(p), ["Which languages does Fred speak?: No more"]);
    await p.close();
  });

  test("labels for the other cases, and no skip button when the engine would refuse it", async () => {
    const p = page();
    ask(p, [LIVES_IN], {}, { facts: TOM_FACTS });
    assert.equal(p.text(".qcard .knownLine"), "Already known: France (injected, 90%)");
    assert.equal(p.text(".qcard [data-skip]"), "Keep known answer");
    ask(p, [numberQ({ allowUnknown: true })]);
    assert.equal(inLast(p, "[data-skip]").textContent, "Don’t know");
    ask(p, [numberQ()]);
    assert.throws(() => inLast(p, "[data-skip]"), /No \[data-skip\]/, "neither allowUnknown nor known answers");
    ask(p, [LIVES_IN], {}, { refusedSkips: new Set([questionKey(LIVES_IN)]) });
    assert.throws(() => inLast(p, "[data-skip]"), /No \[data-skip\]/, "the engine refused this skip already");
    await p.close();
  });

  test("without host meta the card works the same out itself", async () => {
    const p = page();
    p.send({ type: "question", questions: [speaks(), dateQ({ allowUnknown: true })] });
    assert.deepEqual(buttons(p, ".qcard [data-skip]"), ["No more", "Don’t know"]);
    assert.equal(p.text(".q[data-i='0'] .knownLine"), "Already known: English, French");
    assert.ok(p.$(".q[data-i='1'] input.val.date"), "the kind comes from controlKind()");
    await p.close();
  });

  test("a plural question's “Or something else” adds a chip", async () => {
    const p = page();
    ask(p, [speaks({ canAdd: true })]);
    p.type(".qcard input.other", "Klingon");
    p.key(".qcard input.other");
    const added = p.$(".qcard .chip.added");
    assert.ok(added);
    assert.equal(added.textContent, "Klingon");
    assert.equal(input(p, ".qcard input.other").value, "");
    p.type(".qcard input.other", "Bad<");
    p.key(".qcard input.other");
    assert.match(p.text(".qcard .miss"), /remove </);
    p.type(".qcard input.other", "");
    p.click("[data-opt=Spanish]");
    p.click("[data-act=submit]");
    assert.deepEqual(payloadsOf(p.lastPosted("answer")), [{ kind: "multi", values: ["Spanish", "Klingon"], certainty: 100 }]);
    await p.close();
  });

  test("a near miss in the injected names is flagged on the card", async () => {
    const p = page();
    ask(p, [speaks({ knownAnswers: [] })], {}, { facts: [{ subject: "fred", relationship: "speaks", object: "English" }] });
    assert.match(p.text(".qcard .nearmiss"), /Facts were injected for "fred", but the engine is asking about "Fred"/);
    await p.close();
  });
});

describe("long option lists (A-5)", () => {
  const many = concepts("Arabic", "Bengali", "Dutch", "English", "French", "German", "Hindi", "Italian", "Japanese", "Korean");

  test("a filter box above the options narrows them; Enter picks the single match", async () => {
    const p = page();
    ask(p, [countryQ({ canAdd: false, concepts: many })]);
    const filter = p.$(".qcard input.filter");
    assert.ok(filter);
    assert.equal(filter.getAttribute("placeholder"), "Filter 10 options…");
    const order = p.$$(".qcard input.filter, .qcard [data-pick]");
    assert.ok(order[0] === filter, "the filter comes first");
    assert.ok(hasFocus(p, ".qcard input.filter"), "and has the focus");
    p.type(".qcard input.filter", "CH");
    assert.deepEqual(p.$$("[data-pick]").filter((b) => !b.hidden).map((b) => String(b.textContent)), ["Dutch", "French"], "case-insensitive");
    p.key(".qcard input.filter");
    assert.equal(answers(p).length, 0, "two matches: Enter does nothing");
    p.type(".qcard input.filter", "germ");
    p.key(".qcard input.filter");
    assert.deepEqual(payloadsOf(p.lastPosted("answer")), [{ kind: "value", value: "German", certainty: 100 }]);
    await p.close();
  });

  test("chosen chips are never hidden by the filter", async () => {
    const p = page();
    ask(p, [speaks({ knownAnswers: [], concepts: many })]);
    p.click("[data-opt=English]");
    p.type(".qcard input.filter", "ger");
    const visible = p.$$("[data-opt]").filter((b) => !b.hidden).map((b) => String(b.textContent));
    assert.deepEqual(visible, ["English", "German"]);
    p.key(".qcard input.filter");
    assert.deepEqual(p.$$("[data-opt].on").map((b) => String(b.textContent)), ["English", "German"]);
    assert.equal(input(p, ".qcard input.filter").value, "", "the filter clears for the next pick");
    assert.equal(p.$$("[data-opt]").filter((b) => b.hidden).length, 0);
    await p.close();
  });
});

describe("grouped questions as one form (GQ-1)", () => {
  const group = () => [countryQ(), numberQ(), dateQ(), truthQ({ allowUnknown: true })];

  test("one Submit answers, validation under each question, a footer count and focus on the first gap", async () => {
    const p = page();
    ask(p, group());
    assert.equal(p.text(".qcard > .prompt"), "4 related questions — answer each one, then click Submit answers");
    assert.equal(p.$$(".qcard [data-act=submit]").length, 0, "no per-question Submit in a group");
    assert.deepEqual(buttons(p, ".qcard .submitAll"), ["Submit answers"]);
    assert.ok(hasFocus(p, ".q[data-i='0'] input.other"), "focus starts in the first question");

    p.click(".submitAll");
    assert.equal(answers(p).length, 0);
    assert.deepEqual(
      p.$$(".q").map((q) => String(q.querySelector(".miss")?.textContent)),
      ["Answer this question.", "Answer this question.", "Answer this question.", "Answer this question, or choose “Don’t know”."]
    );
    assert.equal(p.text(".groupErr"), "4 questions still need an answer.");

    // Picks are radio toggles with aria-pressed.
    const [england, france] = p.$$(".q[data-i='0'] [data-pick]");
    p.click(england);
    p.click(france);
    assert.deepEqual(p.$$(".q[data-i='0'] [data-pick]").map((b) => b.getAttribute("aria-pressed")), ["false", "true"]);
    p.click(france);
    assert.equal(p.$$(".q[data-i='0'] [data-pick].on").length, 0, "clicking the lit option clears it");
    p.click(france);
    assert.equal(p.text(".q[data-i='0'] .miss"), "", "choosing clears the question's message");
    assert.equal(p.text(".groupErr"), "3 questions still need an answer.");

    // Enter in a text field moves to the next unanswered question.
    p.type(".q[data-i='1'] input.val", "5000");
    p.key(".q[data-i='1'] input.val");
    assert.ok(hasFocus(p, ".q[data-i='2'] input.val.date"), "Enter moves to the next unanswered question");
    p.type(".q[data-i='2'] input.val.date", "abc");
    p.key(".q[data-i='2'] input.val.date");
    assert.equal(p.text(".q[data-i='2'] .miss"), HINTS.dateNotRecognised, "Enter on a bad value says so and stays");
    p.type(".q[data-i='2'] input.val.date", "1981-10-01");
    p.key(".q[data-i='2'] input.val.date");
    assert.ok(hasFocus(p, ".q[data-i='3']"), "a question without a text field gets the focus itself, not its first button");
    assert.equal(answers(p).length, 0);

    // Certainty and choices are read at submit; Enter in the last gap's field submits once all are answered.
    p.click(".q[data-i='3'] [data-truth=true]");
    p.key(".q[data-i='1'] input.val");
    assert.equal(answers(p).length, 1);
    assert.deepEqual(payloadsOf(p.lastPosted("answer")), [
      { kind: "value", value: "France", certainty: 100 },
      { kind: "value", value: "5000", certainty: 100 },
      { kind: "value", value: "1981-10-01", raw: "1981-10-01", certainty: 100 },
      { kind: "value", value: "true", certainty: 100 },
    ]);
    assert.equal(p.$$(".qcard").length, 0);
    await p.close();
  });

  test("the skip button toggles and clears that question's other choices; typing turns it off", async () => {
    const p = page();
    ask(p, [speaks(), numberQ({ allowUnknown: true })]);
    p.click("[data-opt=German]");
    const skip = p.$(".q[data-i='0'] [data-skip]");
    assert.ok(skip);
    p.click(skip);
    assert.equal(skip.getAttribute("aria-pressed"), "true");
    assert.equal(p.$$(".q[data-i='0'] [data-opt].on").length, 0, "No more clears the ticked chips");
    p.click(skip);
    assert.equal(skip.getAttribute("aria-pressed"), "false", "and toggles off");

    const dontKnow = p.$(".q[data-i='1'] [data-skip]");
    assert.ok(dontKnow);
    p.type(".q[data-i='1'] input.val", "12");
    p.click(dontKnow);
    assert.equal(input(p, ".q[data-i='1'] input.val").value, "", "the skip clears the typed value");
    p.type(".q[data-i='1'] input.val", "7");
    assert.equal(dontKnow.getAttribute("aria-pressed"), "false", "typing turns the skip off");
    p.click(skip);
    p.click(".submitAll");
    assert.deepEqual(payloadsOf(p.lastPosted("answer")), [{ kind: "skip" }, { kind: "value", value: "7", certainty: 100 }]);
    await p.close();
  });

  test("a plural question that can be skipped still says “Choose at least one option.”", async () => {
    const p = page();
    ask(p, [speaks(), truthQ()]);
    assert.ok(p.$(".q[data-i='0'] [data-skip]"), "No more is offered");
    p.click(".submitAll");
    assert.equal(p.text(".q[data-i='0'] .miss"), "Choose at least one option.");
    assert.equal(p.text(".q[data-i='1'] .miss"), "Answer this question.");
    await p.close();
  });

  test("Enter that confirms an input-method candidate neither moves on nor submits", async () => {
    const p = page();
    ask(p, [countryQ(), numberQ()]);
    p.type(".q[data-i='0'] input.other", "Wales");
    p.key(".q[data-i='0'] input.other", "Enter", { isComposing: true });
    assert.ok(hasFocus(p, ".q[data-i='0'] input.other"), "still composing in the first question");
    p.key(".q[data-i='0'] input.other");
    assert.ok(hasFocus(p, ".q[data-i='1'] input.val"), "a plain Enter moves on");

    const single = page();
    ask(single, [numberQ()]);
    single.type(".qcard input.val", "7");
    single.key(".qcard input.val", "Enter", { isComposing: true });
    assert.equal(answers(single).length, 0, "a single card is not submitted either");
    single.key(".qcard input.val");
    assert.deepEqual(payloadsOf(single.lastPosted("answer")), [{ kind: "value", value: "7", certainty: 100 }]);
    await p.close();
    await single.close();
  });

  test("plural chips need at least one option; certainty is read at submit", async () => {
    const p = page();
    ask(p, [speaks({ knownAnswers: [], allowCF: true }), truthQ()]);
    p.click("[data-truth=false]");
    p.click(".submitAll");
    assert.equal(p.text(".q[data-i='0'] .miss"), "Choose at least one option.");
    assert.equal(p.text(".groupErr"), "1 question still needs an answer.");
    p.click("[data-opt=French]");
    p.type(".q[data-i='0'] .cf", "70");
    p.click(".submitAll");
    assert.deepEqual(payloadsOf(p.lastPosted("answer")), [
      { kind: "multi", values: ["French"], certainty: 70 },
      { kind: "value", value: "false", certainty: 100 },
    ]);
    await p.close();
  });

  test("members the injected facts cover start on “No more” and stay editable", async () => {
    const p = page();
    const group = [speaks(), numberQ()];
    const plan = autoSkipPlan(group, { mode: "injected", injected: FRED_SPEAKS_ENGLISH, noAutoSkip: new Set() });
    assert.deepEqual(plan.map((d) => d.skip), [true, false]);
    ask(p, group, {}, { facts: FRED_SPEAKS_ENGLISH, plan });
    const skip = p.$(".q[data-i='0'] [data-skip]");
    assert.equal(skip?.getAttribute("aria-pressed"), "true");
    assert.ok(hasFocus(p, ".q[data-i='1'] input.val"), "the focus starts in the first question still to answer");
    p.type(".q[data-i='1'] input.val", "3.5");
    p.click(".submitAll");
    assert.deepEqual(payloadsOf(p.lastPosted("answer")), [{ kind: "skip" }, { kind: "value", value: "3.5", certainty: 100 }]);
    await p.close();
  });
});

describe("transcript and rejections (GQ-2)", () => {
  test("lines wait for the engine: written when the next question arrives, dropped on a rejection", async () => {
    const p = page();
    const q = countryQ({ canAdd: false });
    ask(p, [q]);
    p.click(p.$$("[data-pick]")[1]);
    assert.deepEqual(transcript(p), []);
    // The engine rejects it: the card comes back with the note, the line is dropped.
    ask(p, [q], { note: rejectionNote("Bad answer", q), previous: payloadsOf(p.lastPosted("answer")) });
    assert.deepEqual(transcript(p), []);
    assert.equal(p.text(".qcard .note"), rejectionNote("Bad answer", q));
    p.click(p.$$("[data-pick]")[0]);
    p.send({ type: "busy" });
    ask(p, [numberQ()]);
    assert.deepEqual(transcript(p), ["Where does Fred live?: England"]);
    const flowChildren = [...(p.$("#flow")?.children ?? [])];
    const nextCard = p.$(".qcard");
    assert.ok(nextCard);
    assert.ok(flowChildren.indexOf(p.$$(".transcript")[0]) < flowChildren.indexOf(nextCard), "the line sits above the next card");
    // An error drops what is pending; a result writes it.
    p.type(".qcard input.val", "9");
    p.click("[data-act=submit]");
    p.send({ type: "error", message: "This session has expired — click “New query” to start again." });
    assert.deepEqual(transcript(p), ["Where does Fred live?: England"]);
    await p.close();
  });

  test("a result writes the pending lines (with a non-default certainty)", async () => {
    const p = page();
    ask(p, [truthQ({ allowCF: true })]);
    p.type(".qcard .cf", "80");
    p.click("[data-truth=true]");
    p.send({ type: "result", sessionId: "s-1", results: [] });
    assert.deepEqual(transcript(p), ["Is Fred resident?: True (80%)"]);
    await p.close();
  });

  test("a single card asked again keeps the typed value and certainty, not the lit button", async () => {
    const p = page();
    const q = dateQ({ allowCF: true });
    ask(p, [q], { note: "Rainbird rejected that answer (x).", previous: [{ kind: "value", value: "1981-10-01", raw: "1st October 1981", certainty: 60 }] });
    assert.equal(p.text(".qcard .note"), "Rainbird rejected that answer (x).");
    assert.equal(input(p, ".qcard input.val.date").value, "1st October 1981");
    assert.equal(p.text(".qcard .preview"), "Will send 1981-10-01 (Thursday 1 October 1981)");
    assert.equal(input(p, ".qcard .cf").value, "60");
    assert.equal(p.text(".qcard .cfv"), "60%");

    const yesNo = question({ type: "First Form", object: "French", prompt: "Does Fred speak French?", allowCF: true });
    ask(p, [yesNo], { note: "Rainbird rejected that answer.", previous: [{ kind: "yesno", answer: "yes", certainty: 40 }] });
    assert.equal(p.$$(".qcard .on").length, 0, "a lit Yes would toggle off on the next click");
    assert.equal(inLast(p, ".cf").value, "40");
    p.click(inLast(p, "[data-yn=yes]"));
    assert.deepEqual(payloadsOf(p.lastPosted("answer")), [{ kind: "yesno", answer: "yes", certainty: 40 }]);
    await p.close();
  });

  test("a single plural card asked again gets its ticked and added chips back", async () => {
    const p = page();
    const q = speaks({ canAdd: true });
    ask(p, [q], { note: "Rainbird rejected that answer (x).", previous: [{ kind: "multi", values: ["German", "Klingon", "English"], certainty: 100 }] }, { facts: FRED_SPEAKS_ENGLISH });
    assert.deepEqual(p.$$(".qcard [data-opt].on").map((b) => String(b.textContent)), ["German", "Klingon"], "a known value is not added again");
    assert.ok(p.$(".qcard .chip.added[data-opt=Klingon]"), "the typed value is back as an added chip");
    p.click("[data-act=submit]");
    assert.deepEqual(payloadsOf(p.lastPosted("answer")), [{ kind: "multi", values: ["German", "Klingon"], certainty: 100 }]);
    await p.close();
  });

  test("a group asked again gets every answer back", async () => {
    const p = page();
    const group = [countryQ(), speaks({ knownAnswers: [] }), numberQ({ allowUnknown: true }), dateQ()];
    const previous: AnswerPayload[] = [
      { kind: "value", value: "France", certainty: 100 },
      { kind: "multi", values: ["German", "Klingon"], certainty: 100 },
      { kind: "skip" },
      { kind: "value", value: "1981-10-01", raw: "1st October 1981", certainty: 100 },
    ];
    ask(p, group, { note: groupRejectedNote("Bad answer"), previous });
    assert.equal(p.text(".qcard .note"), "One of these answers was rejected (Bad answer). Your answers are kept — fix the one in question and click Submit answers again.");
    assert.equal(p.$(".q[data-i='0'] [data-pick=France]")?.getAttribute("aria-pressed"), "true");
    assert.deepEqual(p.$$(".q[data-i='1'] [data-opt].on").map((b) => String(b.textContent)), ["German", "Klingon"]);
    assert.equal(p.$(".q[data-i='2'] [data-skip]")?.getAttribute("aria-pressed"), "true");
    assert.equal(input(p, ".q[data-i='3'] input.val.date").value, "1st October 1981");
    p.click(".submitAll");
    assert.deepEqual(payloadsOf(p.lastPosted("answer")), previous);
    await p.close();
  });

  test("a refused skip offers “Make … inject-only…”, which asks the host", async () => {
    const p = page();
    const q = speaks();
    ask(p, [q], { note: refusedNote("Please provide an expected boolean value for unanswered.", [q], [{ kind: "skip" }]), injectOnly: ["speaks"] }, {
      refusedSkips: new Set([questionKey(q)]),
    });
    assert.match(p.text(".qcard .note"), /^The engine would not let this question be skipped \(Please provide an expected boolean value for unanswered\.\)\. Pick an answer below\./);
    assert.equal(p.$$(".qcard [data-skip]").length, 0, "the refused skip is not offered again");
    p.click("[data-injectonly]");
    assert.deepEqual(p.lastPosted("makeInjectOnly"), { type: "makeInjectOnly", relationship: "speaks" });
    p.send({ type: "injectOnlyDone", relationship: "speaks", file: "hello-world.rbl" });
    const done = p.$("[data-injectonly]");
    assert.equal(done?.hasAttribute("disabled"), true);
    assert.equal(done?.textContent, "askable=\"none\" is set on “speaks” in hello-world.rbl (not saved yet)");
    await p.close();
  });
});

describe("automatic “No more” (P-2)", () => {
  const covered = () => [speaks()];
  const items = () => autoSkipItems(covered(), autoSkipPlan(covered(), { mode: "injected", injected: FRED_SPEAKS_ENGLISH, noAutoSkip: new Set() }));

  test("a transcript card says what was answered and why; Answer instead opens with the engine's reply", async () => {
    const p = page();
    p.send({ type: "autoSkipped", items: items() });
    const card = p.$(".transcript.auto");
    assert.ok(card);
    assert.match(p.text(card), /^Which languages does Fred speak\? — answered “No more” automatically: already known from injected facts: English/);
    const instead = p.$("[data-instead]");
    assert.ok(instead);
    assert.equal(instead.textContent, "Answer instead");
    assert.equal(instead.hasAttribute("disabled"), true, "not before the engine has replied");
    assert.ok(p.$(".spin"), "still reasoning");
    const children = [...(p.$("#flow")?.children ?? [])];
    const spinner = p.$(".spin");
    assert.ok(spinner);
    assert.ok(children.indexOf(card) < children.indexOf(spinner), "above the spinner");

    ask(p, [numberQ()]);
    assert.equal(instead.hasAttribute("disabled"), false);
    p.click(instead);
    assert.ok(p.lastPosted("answerInstead"));
    assert.equal(p.$$(".qcard").length, 0, "the reply to the automatic answer is withdrawn");
    assert.deepEqual(transcript(p).slice(-1), ["↶: answer instead"]);
    await p.close();
  });

  test("Answer instead is retired by any later step", async () => {
    const p = page();
    p.send({ type: "autoSkipped", items: items() });
    ask(p, [numberQ()]);
    p.type(".qcard input.val", "4");
    p.click("[data-act=submit]");
    const instead = p.$("[data-instead]");
    assert.equal(instead?.hasAttribute("disabled"), true, "a later answer retires it as it is sent, before the host says busy");
    assert.equal(instead?.getAttribute("title"), "No longer available: this automatic answer is no longer the latest step.");
    p.send({ type: "busy" });
    ask(p, [truthQ()]);
    p.click("[data-instead]");
    assert.equal(p.lastPosted("answerInstead"), undefined, "a disabled link posts nothing");

    const q = page();
    q.send({ type: "autoSkipped", items: items() });
    q.send({ type: "result", sessionId: "s", results: [] });
    assert.equal(q.$("[data-instead]")?.hasAttribute("disabled"), false, "the result is the reply: still open");
    q.send({ type: "busy" });
    assert.equal(q.$("[data-instead]")?.hasAttribute("disabled"), true, "Back (busy) retires it");
    await p.close();
    await q.close();
  });

  test("pending answers are written before the automatic card", async () => {
    const p = page();
    ask(p, [truthQ()]);
    p.click("[data-truth=true]");
    p.send({ type: "busy" });
    p.send({ type: "autoSkipped", items: items() });
    assert.deepEqual(transcript(p).map((t) => t.slice(0, 32)), ["Is Fred resident?: True", "Which languages does Fred speak?"]);
    await p.close();
  });
});

describe("the baseline group flow keeps Back", () => {
  test("Back removes the card and asks the host to undo", async () => {
    const p = page();
    ask(p, [countryQ(), numberQ()]);
    p.click(".qcard .back");
    assert.ok(p.lastPosted("undo"));
    assert.equal(p.$$(".qcard").length, 0);
    assert.deepEqual(transcript(p), ["↶: back one step"]);
    await p.close();
  });
});

describe("focus after each step: the next card takes it", () => {
  const yesNoQ = () => question({ type: "First Form", relationship: "speaks", object: "French", prompt: "Does Fred speak French?" });
  // The results region renders the result card; its focus is checked here with the question cards', as one keyboard flow.
  const result = { subject: "Fred", relationship: "speaks", object: "French", certainty: 75, factID: "WA:RF:1" };

  test("a single yes/no or True/False card focuses the question, not an answer button", async () => {
    const p = page();
    ask(p, [yesNoQ()]);
    assert.ok(hasFocus(p, ".qcard .q[data-i='0']"), "the question has the focus");
    assert.ok(!p.$(".qcard [data-yn=yes]")?.classList.contains("primary"), "Yes is not highlighted");
    const truth = page();
    ask(truth, [truthQ()]);
    assert.ok(hasFocus(truth, ".qcard .q[data-i='0']"), "the question has the focus");
    assert.ok(!truth.$(".qcard [data-truth=true]")?.classList.contains("primary"), "True is not highlighted");
    await p.close();
    await truth.close();
  });

  test("an options-only single card that follows an answer focuses the question, not its first option", async () => {
    const p = page();
    ask(p, [yesNoQ()]);
    p.click(".qcard [data-yn=yes]");
    assert.ok(hasFocus(p, "body"), "answering removed the focused button with its card");
    p.send({ type: "busy" });
    ask(p, [countryQ({ canAdd: false })]);
    assert.ok(hasFocus(p, ".qcard .q[data-i='0']"), "the question has the focus");
    await p.close();
  });

  test("a number card still focuses its field", async () => {
    const p = page();
    ask(p, [numberQ()]);
    assert.ok(hasFocus(p, ".qcard input.val"), "the field has the focus");
    await p.close();
  });

  test("a result card focuses Show evidence, and a card with no result focuses Run another query", async () => {
    const p = page();
    p.send({ type: "result", sessionId: "s-1", results: [result] });
    assert.ok(hasFocus(p, ".result [data-ev]"), "Show evidence has the focus");
    const none = page();
    none.send({ type: "result", sessionId: "s-1", results: [] });
    assert.ok(hasFocus(none, "#again"), "Run another query has the focus");
    await p.close();
    await none.close();
  });

  test("Enter on a focused Explain (AI) link leaves the focus on Show on graph", async () => {
    const p = page();
    p.send({ type: "result", sessionId: "s-1", results: [result] });
    p.$("[data-explain]")?.focus();
    assert.ok(hasFocus(p, "[data-explain]"), "the link has the focus first");
    p.key("[data-explain]", "Enter");
    assert.deepEqual(p.lastPosted("explain"), { type: "explain", factId: "WA:RF:1" });
    assert.equal(p.$$("[data-explain]").length, 0, "the link goes once used");
    assert.ok(hasFocus(p, "[data-overlay]"), "the next action has the focus");

    // A link without the focus (another control has it) leaves the focus where it is.
    const other = page();
    other.send({ type: "result", sessionId: "s-1", results: [result] });
    other.click("[data-explain]");
    assert.ok(hasFocus(other, "[data-ev]"), "Show evidence keeps the focus");
    await p.close();
    await other.close();
  });
});

describe("host side: decorateQuestions", () => {
  test("the live question with its injected fact", () => {
    const [q] = decorateQuestions([LIVES_IN], { facts: TOM_FACTS });
    assert.equal(q._kind, "string");
    assert.deepEqual(q._options, [
      { label: "England", value: "England" },
      { label: "France", value: "France" },
    ]);
    assert.deepEqual(q._suggestions, []);
    assert.equal(q._canAdd, true);
    assert.deepEqual(q.known, [{ value: "France", certainty: 90, injected: true, label: "France (90%)" }]);
    assert.equal(q.canSkip, true);
    assert.equal(q.skipLabel, "Keep known answer");
    assert.match(q.skipTitle, /keeps the answer it already has/);
    assert.equal(q.preSkip, false);
    assert.equal(q.dateOrder, "day-first");
    assert.equal(q.nearMiss, undefined);
    assert.equal(q.prompt, LIVES_IN.prompt, "the question itself is kept");
  });

  test("refused skips, the plan, the near miss and the date order", () => {
    const group = [speaks(), numberQ({ concepts: concepts("0", "0", "1.50") })];
    const plan = autoSkipPlan(group, { mode: "injected", injected: FRED_SPEAKS_ENGLISH, noAutoSkip: new Set() });
    const [a, b] = decorateQuestions(group, { facts: FRED_SPEAKS_ENGLISH, plan, dateOrder: "month-first" });
    assert.equal(a.preSkip, true);
    assert.equal(a.skipLabel, "No more");
    assert.equal(b.preSkip, false);
    assert.deepEqual(b._suggestions, ["0", "1.5"]);
    assert.equal(b.dateOrder, "month-first");
    const [refused] = decorateQuestions(group, { facts: FRED_SPEAKS_ENGLISH, plan, refusedSkips: new Set([questionKey(group[0])]) });
    assert.equal(refused.canSkip, false);
    assert.equal(refused.preSkip, false, "never pre-set a skip the engine refused");
    const [near] = decorateQuestions([speaks({ knownAnswers: [] })], { facts: [{ subject: "fred", relationship: "speaks", object: "English" }] });
    assert.match(String(near.nearMiss), /Instance names are case-sensitive/);
  });
});

describe("host side: answersFor", () => {
  test("each payload kind becomes the right wire answers, in group order", () => {
    const yesNo = question({ type: "First Form", relationship: "speaks", subject: "Fred", object: "French", prompt: "Does Fred speak French?" });
    const group = [yesNo, truthQ(), numberQ(), dateQ(), speaks(), LIVES_IN];
    const payloads: AnswerPayload[] = [
      { kind: "yesno", answer: "yes", certainty: 80 },
      { kind: "value", value: "true", certainty: 100 },
      { kind: "value", value: "3.50" },
      { kind: "value", value: "1981-10-01", raw: "01/10/1981", certainty: 100 },
      { kind: "multi", values: ["German", "German", "Spanish"], certainty: 90 },
      { kind: "skip" },
    ];
    assert.deepEqual(answersFor(group, payloads), [
      { relationship: "speaks", subject: "Fred", object: "French", answer: "yes", certainty: 80 },
      { relationship: "is resident", subject: "Fred", object: true, certainty: 100 },
      { relationship: "earns", subject: "Fred", object: 3.5, certainty: 100 },
      { relationship: "was born on", subject: "Fred", object: "1981-10-01", certainty: 100 },
      { relationship: "speaks", subject: "Fred", object: "German", certainty: 90 },
      { relationship: "speaks", subject: "Fred", object: "Spanish", certainty: 90 },
      { relationship: "lives in", subject: "Tom", unanswered: true },
    ]);
  });

  test("the legacy “unknown” kind skips; a subject question answers the subject", () => {
    const who = question({ type: "Second Form Subject", relationship: "speaks", subject: undefined, object: "French", prompt: "Who speaks French?" });
    assert.deepEqual(answersFor([who], [{ kind: "unknown" }]), [{ relationship: "speaks", object: "French", unanswered: true }]);
    assert.deepEqual(answersFor([who], [{ kind: "value", value: " Fred " }]), [{ relationship: "speaks", subject: "Fred", object: "French", certainty: 100 }]);
  });

  test("a value that does not fit throws AnswerCheckError naming the question, before anything is built", () => {
    const yesNo = question({ type: "First Form", object: "French" });
    const check = (group: Question[], payloads: AnswerPayload[]) => {
      try {
        answersFor(group, payloads);
      } catch (error) {
        assert.ok(error instanceof AnswerCheckError, "an AnswerCheckError, not answerFor's own error");
        return { index: error.index, message: error.message };
      }
      assert.fail("expected a check error");
    };
    assert.deepEqual(check([yesNo], [{ kind: "value", value: "maybe" }]), { index: 0, message: HINTS.yesNo });
    assert.deepEqual(check([truthQ(), numberQ()], [{ kind: "value", value: "true" }, { kind: "value", value: "1,000" }]), { index: 1, message: HINTS.number });
    assert.deepEqual(check([dateQ()], [{ kind: "value", value: "01/10/1981" }]), {
      index: 0,
      message: describeAmbiguousDate("01/10/1981", ["1981-10-01", "1981-01-10"]),
    });
    assert.deepEqual(check([countryQ(), numberQ()], [{ kind: "value", value: "France" }]), { index: 1, message: "Answer this question." });
    assert.deepEqual(check([speaks()], [{ kind: "multi", values: [] }]), { index: 0, message: "Choose at least one option." });
    assert.match(String(check([countryQ()], [{ kind: "value", value: "Fr<ance" }])?.message), /remove </);
  });

  test("an option the engine offered is sent as it is; certainty is clamped to 1–100", () => {
    const q = countryQ({ concepts: concepts("Côte d'Ivoire"), canAdd: false });
    assert.deepEqual(checkValue(q, "Côte d'Ivoire"), { ok: true, value: "Côte d'Ivoire" });
    assert.equal(checkValue(q, "d'Arcy").ok, false, "a typed value is still checked");
    const at = (certainty: unknown) => answersFor([truthQ()], [{ kind: "value", value: "false", certainty } as AnswerPayload])[0].certainty;
    assert.equal(at(0), 1);
    assert.equal(at(150), 100);
    assert.equal(at(undefined), 100);
    assert.equal(at(55.4), 55);
  });

  test("isSkipPayload", () => {
    assert.equal(isSkipPayload({ kind: "skip" }), true);
    assert.equal(isSkipPayload({ kind: "unknown" }), true);
    assert.equal(isSkipPayload({ kind: "value", value: "x" }), false);
    assert.equal(isSkipPayload(undefined), false);
  });
});

describe("host side: notes and messages", () => {
  test("rejections: rejectionNote for one question, the GQ-2 copy for a group", () => {
    const q = numberQ();
    assert.equal(refusedNote("Bad", [q], [{ kind: "value", value: "1" }]), rejectionNote("Bad", q));
    assert.equal(
      refusedNote("Bad", [q, truthQ()], [{ kind: "value", value: "1" }, { kind: "value", value: "true" }]),
      "One of these answers was rejected (Bad). Your answers are kept — fix the one in question and click Submit answers again."
    );
    assert.equal(groupRejectedNote(""), "One of these answers was rejected. Your answers are kept — fix the one in question and click Submit answers again.");
  });

  test("a refused skip: the P-1 copy, naming the question in a group, introduced when it was automatic", () => {
    const q = speaks();
    const detail = "Please provide an expected boolean value for unanswered.";
    assert.equal(refusedNote(detail, [q], [{ kind: "skip" }]), skipRejectedNote(detail, q));
    assert.equal(
      refusedNote(detail, [numberQ(), q], [{ kind: "value", value: "1" }, { kind: "skip" }]),
      skipRejectedNote(detail, q, "Answer “Which languages does Fred speak?” below instead and click Submit answers again — your other answers are kept.")
    );
    assert.equal(
      refusedNote(detail, [q], [{ kind: "skip" }], true),
      "This question was going to be answered “No more” automatically. " + skipRejectedNote(detail, q, "Pick an answer below.")
    );
  });

  test("several refused skips: the plural copy, every question and relationship named", () => {
    const detail = "Please provide an expected boolean value for unanswered.";
    const reads = speaks({ relationship: "reads", prompt: "Which books does Fred read?" });
    const advice = 'set askable="none" on them in the map — only if every session injects those facts; otherwise rules that need them get no result.';
    assert.equal(
      refusedNote(detail, [speaks(), reads], [{ kind: "skip" }, { kind: "skip" }], true),
      "These questions were going to be answered “No more” automatically. The engine would not let them be skipped (" + detail + "). " +
        'Answer them below, then click Submit answers. If "speaks" and "reads" should only ever be fed by injected facts, ' + advice
    );
    assert.equal(
      refusedNote("", [speaks(), reads, numberQ()], [{ kind: "skip" }, { kind: "skip" }, { kind: "value", value: "1" }]),
      "The engine would not let these questions be skipped. Answer “Which languages does Fred speak?” and “Which books does Fred read?” below instead " +
        'and click Submit answers again — your other answers are kept. If "speaks" and "reads" should only ever be fed by injected facts, ' + advice
    );
    const tom = speaks({ subject: "Tom", prompt: "Which languages does Tom speak?" });
    assert.match(
      refusedNote(detail, [speaks(), tom], [{ kind: "skip" }, { kind: "skip" }]),
      /^The engine would not let these questions be skipped \(.*\)\. Answer them below instead, then click Submit answers\. If "speaks" should only ever be fed by injected facts, set askable="none" on it in the map/,
      "one relationship: named once, in the singular"
    );
    const dontKnow = numberQ({ allowUnknown: true, plural: true });
    assert.match(refusedNote(detail, [speaks(), dontKnow], [{ kind: "skip" }, { kind: "skip" }], true), /^These questions were going to be skipped automatically\./, "different labels");
  });

  test("a local check names the question in a group", () => {
    const group = [countryQ(), numberQ()];
    assert.equal(checkNote(group, new AnswerCheckError(HINTS.number, 1)), "“How much does Fred earn?”: " + HINTS.number);
    assert.equal(checkNote([numberQ()], new AnswerCheckError(HINTS.number, 0)), HINTS.number);
  });

  test("no reply: the answers are kept to send again; after an automatic skip, the note names the answer the panel sent", () => {
    assert.equal(noReplyNote("fetch failed", [numberQ()]), "Rainbird did not reply (fetch failed). Give your answer again to resend it.");
    assert.equal(
      noReplyNote("fetch failed", [numberQ(), truthQ()]),
      "Rainbird did not reply (fetch failed). Your answers are kept: click Submit answers to send them again."
    );
    assert.equal(noReplyNote("", [numberQ()]), "Rainbird did not reply. Give your answer again to resend it.", "no empty brackets");

    assert.equal(
      autoSkipFailedNote("fetch failed", [speaks()]),
      "Rainbird did not reply when the panel answered “No more” for you (fetch failed). Click “No more” to send it again, or answer the question."
    );
    const reads = speaks({ relationship: "reads", prompt: "Which books does Fred read?" });
    assert.equal(
      autoSkipFailedNote("fetch failed", [speaks(), reads]),
      "Rainbird did not reply when the panel answered “No more” for you (fetch failed). " +
        "The questions start on “No more”: click Submit answers to send it again, or change an answer first."
    );
    const dontKnow = numberQ({ allowUnknown: true, plural: true });
    assert.equal(skipLabel(dontKnow), "Don’t know");
    assert.match(autoSkipFailedNote("x", [dontKnow]), /^Rainbird did not reply when the panel answered “Don’t know” for you \(x\)\. Click “Don’t know”/, "a label every question shares");
    assert.match(autoSkipFailedNote("x", [speaks(), dontKnow]), /answered “No more” for you \(x\)\. The questions start on “No more”/, "different labels: “No more”");
  });

  test("autoSkipItems, the inject-only confirmation and the log lines", () => {
    const group = [speaks()];
    const plan = autoSkipPlan(group, { mode: "injected", injected: FRED_SPEAKS_ENGLISH, noAutoSkip: new Set() });
    assert.deepEqual(autoSkipItems(group, plan), [{ prompt: "Which languages does Fred speak?", label: "No more", reason: "injected", values: ["English"] }]);
    const known = autoSkipPlan(group, { mode: "known", injected: [], noAutoSkip: new Set() });
    assert.deepEqual(autoSkipItems(group, known)[0].values, ["English", "French"]);
    assert.equal(autoSkipItems(group, known)[0].reason, "known");
    assert.equal(
      injectOnlyPrompt("speaks", "hello-world.rbl"),
      "Set askable=\"none\" on “speaks” in hello-world.rbl? Do this only if every session injects these facts; otherwise rules that need them get no result. Push creates a new map (new kmID), or paste the change into Studio and re-publish."
    );
    assert.deepEqual(jsonLines({ a: [1] }), ["{", '  "a": [', "    1", "  ]", "}"]);
  });
});

// ── Host side: the region's steps (QuestionFlow), with a scripted engine and the real webview ──

type Reply = EngineResponse | Error | Promise<EngineResponse>;
type EngineCall = { op: "respond"; sessionId: string; answers: Answer[] } | { op: "undo"; sessionId: string };

/** An engine that replies from queues; a reply may be a promise the test settles later. */
class ScriptedEngine implements QuestionEngine {
  readonly calls: EngineCall[] = [];
  readonly replies: Reply[] = [];
  readonly undoReplies: Reply[] = [];
  async respond(sessionId: string, answers: Answer[]): Promise<EngineResponse> {
    this.calls.push({ op: "respond", sessionId, answers: JSON.parse(JSON.stringify(answers)) as Answer[] });
    return this.next(this.replies);
  }
  async undo(sessionId: string): Promise<EngineResponse> {
    this.calls.push({ op: "undo", sessionId });
    return this.next(this.undoReplies);
  }
  private async next(queue: Reply[]): Promise<EngineResponse> {
    const reply = queue.shift();
    if (!reply) throw new Error("The scripted engine has no reply for this call.");
    if (reply instanceof Error) throw reply;
    return reply;
  }
}

/** A reply the test settles when it chooses (a slow engine). */
function later(): { promise: Promise<EngineResponse>; resolve(reply: EngineResponse): void; reject(error: Error): void } {
  let resolve!: (reply: EngineResponse) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<EngineResponse>((ok, fail) => {
    resolve = ok;
    reject = fail;
  });
  return { promise, resolve, reject };
}

const refused = (detail: string) => new ApiError("Rainbird API 400", 400, JSON.stringify({ err: [detail] }));
const SKIP_REFUSED = "Please provide an expected boolean value for unanswered.";
const HELLO = fs.readFileSync(path.join(__dirname, "..", "..", "examples", "hello-world.rbl"), "utf8");
const SPEAKS_RESULT: ResultItem = { subject: "Fred", relationship: "speaks", object: "English", certainty: 100, factID: "WA:RF:1" };

interface FakeMap {
  name: string;
  text: string;
  writes: string[];
  /** The editor refuses the edit. */
  refuse?: boolean;
}

interface Rig {
  flow: QuestionFlow;
  page: WebviewHarness;
  engine: ScriptedEngine;
  /** What QueryPanel's session fields hold; a test replaces them the way start() does. */
  session: { engine?: QuestionEngine; sessionId?: string; record?: QuestionRecord };
  record(): QuestionRecord;
  /** Everything the flow posted, JSON round-tripped. */
  posts: Posted[];
  settings: Record<string, unknown>;
  logs: { title: string; lines: string[] }[];
  maps: FakeMap[];
  confirms: { message: string; action: string }[];
  /** What the modal confirmation answers. */
  confirmWith: boolean;
  notices: { kind: string; message: string }[];
  /** Hand the page's new messages to the flow as QueryPanel does: a thrown error becomes the error card. */
  pump(): Promise<void>;
  last(type: string): Posted | undefined;
}

function rig(facts: Fact[] = []): Rig {
  const page = loadWebview(render("test-nonce"));
  const engine = new ScriptedEngine();
  const post = (message: Record<string, unknown>) => {
    const copy = JSON.parse(JSON.stringify(message)) as Posted;
    r.posts.push(copy);
    page.send(copy);
  };
  const r: Rig = {
    flow: undefined as unknown as QuestionFlow,
    page,
    engine,
    session: { engine, sessionId: "s-1", record: { answers: [], ...(facts.length ? { facts } : {}) } },
    record: () => r.session.record as QuestionRecord,
    posts: [],
    settings: {},
    logs: [],
    maps: [],
    confirms: [],
    confirmWith: true,
    notices: [],
    async pump() {
      while (seen < page.posted.length) {
        const message = page.posted[seen++];
        try {
          await r.flow.onMessage(message);
        } catch (error) {
          post({ type: "error", message: (error as Error).message });
        }
      }
    },
    last: (type) => [...r.posts].reverse().find((m) => m.type === type),
  };
  let seen = 0;
  r.flow = new QuestionFlow({
    session: () => r.session,
    post,
    setting: (name) => r.settings[name],
    log: (title, lines) => r.logs.push({ title, lines }),
    openMaps: () =>
      r.maps.map((map) => ({
        name: map.name,
        text: () => map.text,
        write: async (text: string) => {
          if (map.refuse) return false;
          map.writes.push(text);
          map.text = text;
          return true;
        },
      })),
    confirm: async (message, action) => {
      r.confirms.push({ message, action });
      return r.confirmWith;
    },
    notify: (kind, message) => r.notices.push({ kind, message }),
  });
  return r;
}

const skipOf = (q: Question): Answer => ({ relationship: q.relationship, subject: q.subject, unanswered: true });
const types = (r: Rig) => r.posts.map((m) => m.type);

describe("host: automatic “No more” and Answer instead (QuestionFlow, P-2)", () => {
  test("a group the injected facts cover is answered at once, recorded and shown; Answer instead undoes it and asks again", async () => {
    const r = rig(FRED_SPEAKS_ENGLISH);
    r.engine.replies.push({ kind: "question", question: countryQ() });
    await r.flow.handleResponse({ kind: "question", question: speaks() });
    assert.deepEqual(r.engine.calls, [{ op: "respond", sessionId: "s-1", answers: [skipOf(speaks())] }]);
    assert.deepEqual(r.record().answers, [[skipOf(speaks())]], "recorded as an ordinary batch");
    assert.deepEqual(types(r), ["autoSkipped", "question"]);
    assert.match(r.page.text(".transcript.auto"), /^Which languages does Fred speak\? — answered “No more” automatically: already known from injected facts: English/);
    assert.equal(r.page.$("[data-instead]")?.hasAttribute("disabled"), false, "open once the reply is shown");
    assert.equal(r.page.text(".qcard .prompt"), "Where does Fred live?");

    r.engine.undoReplies.push({ kind: "question", question: speaks() });
    r.page.click("[data-instead]");
    await r.pump();
    assert.deepEqual(r.engine.calls.slice(1), [{ op: "undo", sessionId: "s-1" }]);
    assert.deepEqual(r.record().answers, [], "the automatic batch is undone");
    assert.ok(r.flow.noAutoSkip.has(questionKey(speaks())));
    const asked = r.last("question") as { questions: { preSkip: boolean }[] };
    assert.equal(asked.questions[0].preSkip, false);
    assert.equal(r.page.$$(".qcard").length, 1, "the reply to the automatic answer was withdrawn");
    assert.equal(r.page.text(".qcard [data-skip]"), "No more", "asked, this time without the automatic answer");

    r.engine.replies.push({ kind: "result", result: [SPEAKS_RESULT] });
    r.page.click(".qcard [data-skip]");
    await r.pump();
    assert.deepEqual(r.engine.calls[2], { op: "respond", sessionId: "s-1", answers: [skipOf(speaks())] });
    assert.deepEqual(r.record().answers, [[skipOf(speaks())]]);
    assert.deepEqual(r.record().results, [SPEAKS_RESULT]);
    assert.ok(transcript(r.page).includes("Which languages does Fred speak?: No more"));
    await r.page.close();
  });

  test("a group only partly covered starts the covered member on “No more” and goes out as one batch; Back does not pre-set it again", async () => {
    const r = rig(FRED_SPEAKS_ENGLISH);
    await r.flow.handleResponse({ kind: "question", question: speaks(), extraQuestions: [numberQ()] });
    assert.deepEqual(r.engine.calls, [], "a partial batch is never sent by itself");
    assert.equal(r.page.$(".q[data-i='0'] [data-skip]")?.getAttribute("aria-pressed"), "true");
    r.engine.replies.push({ kind: "question", question: countryQ() });
    r.page.type(".q[data-i='1'] input.val", "1000");
    r.page.click(".submitAll");
    await r.pump();
    assert.deepEqual(r.engine.calls[0], {
      op: "respond",
      sessionId: "s-1",
      answers: [skipOf(speaks()), { relationship: "earns", subject: "Fred", object: 1000, certainty: 100 }],
    });

    r.engine.undoReplies.push({ kind: "question", question: speaks(), extraQuestions: [numberQ()] });
    r.page.click(".qcard .back");
    await r.pump();
    const asked = r.last("question") as { questions: { preSkip: boolean }[] };
    assert.equal(asked.questions[0].preSkip, false, "stepping back over a skip does not pre-set it again");
    assert.ok(r.flow.noAutoSkip.has(questionKey(speaks())));
    assert.deepEqual(r.record().answers, []);
    await r.page.close();
  });

  test("the engine asking the same covered question again shows it; the round cap stops a long run", async () => {
    const r = rig(FRED_SPEAKS_ENGLISH);
    r.engine.replies.push({ kind: "question", question: speaks() });
    await r.flow.handleResponse({ kind: "question", question: speaks() });
    assert.equal(r.engine.calls.length, 1, "skipped automatically once");
    assert.deepEqual(types(r), ["autoSkipped", "question"]);
    assert.equal((r.posts[1] as { questions: { preSkip: boolean }[] }).questions[0].preSkip, false);

    // 25 different covered questions in a row: 20 are answered automatically, then the next is shown.
    const people = Array.from({ length: 25 }, (_, i) => "P" + i);
    const covered = rig(people.map((subject) => ({ subject, relationship: "speaks", object: "English", certainty: 100 })));
    const ask = (subject: string): EngineResponse => ({
      kind: "question",
      question: speaks({ subject, prompt: "Which languages does " + subject + " speak?", knownAnswers: [{ subject, relationship: { name: "speaks" }, object: "English", cf: 100 }] }),
    });
    covered.engine.replies.push(...people.slice(1).map(ask));
    await covered.flow.handleResponse(ask(people[0]));
    assert.equal(covered.engine.calls.length, 20);
    assert.equal(covered.page.text(".qcard .prompt"), "Which languages does P20 speak?");
    await r.page.close();
    await covered.page.close();
  });

  test("Answer instead is refused once a later answer went out, and what was showing is restored", async () => {
    const r = rig(FRED_SPEAKS_ENGLISH);
    r.engine.replies.push({ kind: "question", question: numberQ() }, { kind: "question", question: countryQ() });
    await r.flow.handleResponse({ kind: "question", question: speaks() });
    r.page.type(".qcard input.val", "5");
    r.page.click(".qcard [data-act=submit]");
    await r.pump();
    assert.equal(r.page.$("[data-instead]")?.hasAttribute("disabled"), true);
    // A stale message (the link was disabled): the host still refuses it.
    r.page.posted.push({ type: "answerInstead" });
    await r.pump();
    assert.equal(r.engine.calls.filter((c) => c.op === "undo").length, 0);
    assert.deepEqual(types(r).slice(-2), ["error", "question"]);
    assert.equal(r.last("error")?.message, "That automatic answer is no longer the latest step. Use Back to step back to it.");
    await r.page.close();
  });

  test("Answer instead after an automatic batch that led to the result clears that result", async () => {
    const r = rig(FRED_SPEAKS_ENGLISH);
    r.engine.replies.push({ kind: "result", result: [SPEAKS_RESULT] });
    await r.flow.handleResponse({ kind: "question", question: speaks() });
    assert.deepEqual(r.record().results, [SPEAKS_RESULT]);
    assert.deepEqual(types(r), ["autoSkipped", "result"]);
    r.engine.undoReplies.push({ kind: "question", question: speaks() });
    r.page.click("[data-instead]");
    await r.pump();
    assert.equal(r.record().results, undefined, "the record no longer passes for a finished session");
    assert.deepEqual(r.record().answers, []);
    await r.page.close();
  });

  test("autoSkipPluralQuestions “off” never answers by itself; “known” also skips on the engine's known answers", async () => {
    const off = rig(FRED_SPEAKS_ENGLISH);
    off.settings["query.autoSkipPluralQuestions"] = "off";
    await off.flow.handleResponse({ kind: "question", question: speaks() });
    assert.deepEqual(off.engine.calls, []);
    assert.equal((off.last("question") as { questions: { preSkip: boolean }[] }).questions[0].preSkip, false);

    const known = rig();
    known.settings["query.autoSkipPluralQuestions"] = "known";
    known.engine.replies.push({ kind: "result", result: [] });
    await known.flow.handleResponse({ kind: "question", question: speaks() });
    assert.deepEqual(known.engine.calls.length, 1);
    assert.match(known.page.text(".transcript.auto"), /already known: English, French/);
    await off.page.close();
    await known.page.close();
  });
});

describe("host: refusals, checks and logging (QuestionFlow)", () => {
  test("a refused automatic skip asks with the skip withdrawn; Make inject-only edits the open map after confirming", async () => {
    const r = rig(FRED_SPEAKS_ENGLISH);
    r.maps.push({ name: "hello-world.rbl", text: HELLO, writes: [] });
    r.engine.replies.push(refused(SKIP_REFUSED));
    await r.flow.handleResponse({ kind: "question", question: speaks() });
    const asked = r.last("question") as { note: string; injectOnly: string[]; questions: { canSkip: boolean }[] };
    assert.equal(asked.note, refusedNote(SKIP_REFUSED, [speaks()], [{ kind: "skip" }], true));
    assert.match(asked.note, /^This question was going to be answered “No more” automatically\. The engine would not let this question be skipped/);
    assert.deepEqual(asked.injectOnly, ["speaks"]);
    assert.equal(asked.questions[0].canSkip, false, "the refused skip is withdrawn");
    assert.equal(r.page.$$(".qcard [data-skip]").length, 0);
    assert.deepEqual(r.record().answers, [], "nothing recorded");

    r.confirmWith = false;
    r.page.click("[data-injectonly]");
    await r.pump();
    assert.deepEqual(r.confirms, [{ message: injectOnlyPrompt("speaks", "hello-world.rbl"), action: INJECT_ONLY_ACTION }]);
    assert.deepEqual(r.maps[0].writes, [], "cancelled: nothing changes");

    r.confirmWith = true;
    r.page.click("[data-injectonly]");
    await r.pump();
    const speaksRel = '<rel name="speaks" subject="Person" object="Language" plural="true" askable="all">';
    assert.deepEqual(r.maps[0].writes, [HELLO.replace(speaksRel, speaksRel.replace('askable="all"', 'askable="none"'))], "one edit: askable on speaks only");
    assert.deepEqual(r.last("injectOnlyDone"), { type: "injectOnlyDone", relationship: "speaks", file: "hello-world.rbl" });
    assert.equal(r.page.text("[data-injectonly]"), "askable=\"none\" is set on “speaks” in hello-world.rbl (not saved yet)");
    await r.page.close();
  });

  test("Make inject-only without a map that declares the relationship, or when the editor refuses the edit, says so", async () => {
    const r = rig();
    await r.flow.makeInjectOnly("speaks");
    assert.deepEqual(r.notices, [{ kind: "warning", message: "Open the RBLang file that declares “speaks” beside the query panel, then try again." }]);
    r.maps.push({ name: "hello-world.rbl", text: HELLO, writes: [], refuse: true });
    await r.flow.makeInjectOnly("speaks");
    assert.deepEqual(r.notices[1], { kind: "error", message: "VS Code could not change hello-world.rbl." });
    assert.equal(r.last("injectOnlyDone"), undefined);
    await r.page.close();
  });

  test("a refused automatic skip of a group names every question, and offers inject-only for the relationships an open map declares", async () => {
    const reads = speaks({ relationship: "reads", prompt: "Which books does Fred read?", knownAnswers: [{ subject: "Fred", relationship: "reads", object: "Dune", cf: 100 }] });
    const r = rig([...FRED_SPEAKS_ENGLISH, { subject: "Fred", relationship: "reads", object: "Dune", certainty: 100 }]);
    r.maps.push({ name: "hello-world.rbl", text: HELLO, writes: [] });
    r.engine.replies.push(refused(SKIP_REFUSED));
    await r.flow.handleResponse({ kind: "question", question: speaks(), extraQuestions: [reads] });
    assert.equal(r.engine.calls.length, 1);
    const asked = r.last("question") as { note: string; injectOnly: string[]; questions: { canSkip: boolean }[] };
    assert.match(asked.note, /^These questions were going to be answered “No more” automatically\. The engine would not let them be skipped/);
    assert.match(asked.note, /If "speaks" and "reads" should only ever be fed by injected facts, set askable="none" on them/);
    assert.deepEqual(asked.injectOnly, ["speaks"], "hello-world.rbl declares speaks only");
    assert.deepEqual(asked.questions.map((q) => q.canSkip), [false, false]);
    await r.page.close();
  });

  test("a skip the user chose and the engine refused: the P-1 note, the answer kept, no skip button, no transcript line", async () => {
    const r = rig();
    const q = countryQ({ allowUnknown: true });
    await r.flow.handleResponse({ kind: "question", question: q });
    assert.equal(r.page.text(".qcard [data-skip]"), "Don’t know");
    r.engine.replies.push(refused(SKIP_REFUSED));
    r.page.click(".qcard [data-skip]");
    await r.pump();
    const asked = r.last("question") as { note: string; previous: AnswerPayload[]; injectOnly?: string[] };
    assert.equal(asked.note, skipRejectedNote(SKIP_REFUSED, q));
    assert.deepEqual(asked.previous, [{ kind: "skip" }]);
    assert.equal(asked.injectOnly, undefined, "no open map declares it");
    assert.equal(r.page.$$(".qcard [data-skip]").length, 0, "not offered again");
    assert.deepEqual(transcript(r.page), [], "the rejected answer left no line");
    assert.ok(r.flow.refusedSkips.has(questionKey(q)) && r.flow.noAutoSkip.has(questionKey(q)));
    await r.page.close();
  });

  test("a value that does not fit is caught before any call; a group 400 keeps every answer; logQuestions logs both blocks", async () => {
    const r = rig();
    r.settings["query.logQuestions"] = true;
    const group = [numberQ(), countryQ({ canAdd: false })];
    await r.flow.handleResponse({ kind: "question", question: group[0], extraQuestions: [group[1]] });
    assert.deepEqual(r.logs[0], { title: "Question", lines: jsonLines({ question: group[0], extraQuestions: [group[1]] }) });

    // A payload the card would never send (it checks numbers itself): the host checks it again before any call.
    r.page.posted.push({ type: "answer", payloads: [{ kind: "value", value: "12 dollars" }, { kind: "value", value: "France" }] });
    await r.pump();
    assert.deepEqual(r.engine.calls, [], "nothing sent");
    const checked = r.last("question") as { note: string; previous: AnswerPayload[] };
    assert.equal(checked.note, "“How much does Fred earn?”: " + HINTS.number);
    assert.equal(checked.previous.length, 2);
    const cards = r.page.$$(".qcard");
    cards.slice(0, -1).forEach((card) => card.remove()); // the posted message bypassed the first card
    assert.equal(r.page.$(".q[data-i='1'] [data-pick=France]")?.getAttribute("aria-pressed"), "true", "group answers restored");
    assert.equal(input(r.page, ".q[data-i='0'] input.val").value, "12 dollars");

    r.engine.replies.push(refused("Bad answer"));
    r.page.type(".q[data-i='0'] input.val", "12");
    r.page.click(".submitAll");
    await r.pump();
    assert.equal(r.last("question")?.note, groupRejectedNote("Bad answer"));
    const sent: Answer[] = [
      { relationship: "earns", subject: "Fred", object: 12, certainty: 100 },
      { relationship: "lives in", subject: "Fred", object: "France", certainty: 100 },
    ];
    assert.deepEqual(r.engine.calls[0], { op: "respond", sessionId: "s-1", answers: sent });
    assert.deepEqual(r.logs[1], { title: "Response sent", lines: jsonLines(sent) });
    await r.page.close();
  });

  test("dates are checked with rainbird.query.dateOrder; an expired session becomes the error card", async () => {
    const r = rig();
    r.settings["query.dateOrder"] = "month-first";
    await r.flow.handleResponse({ kind: "question", question: dateQ() });
    assert.equal((r.last("question") as { questions: { dateOrder: string }[] }).questions[0].dateOrder, "month-first");
    r.page.posted.push({ type: "answer", payloads: [{ kind: "value", value: "01/10/1981" }] });
    await r.pump();
    assert.equal(r.last("question")?.note, describeAmbiguousDate("01/10/1981", ["1981-01-10", "1981-10-01"]), "an ambiguous date is never guessed");

    r.engine.replies.push(new ApiError("Rainbird API 404", 404, "Session not found"));
    r.page.posted.push({ type: "answer", payloads: [{ kind: "value", value: "1981-10-01", raw: "1 Oct 1981" }] });
    await r.pump();
    assert.equal(r.last("error")?.message, "This session has expired — click “New query” to start again.");
    assert.deepEqual(r.record().answers, []);
    assert.equal(r.flow.questions.length, 0, "no group is left open, so ▶ starts a new query without asking about this one");
    assert.equal(await r.flow.onMessage({ type: "evidence", factId: "x" }), false, "other regions' messages are not handled here");
    await r.page.close();
  });
});

describe("host: late replies and the session lifecycle (QuestionFlow)", () => {
  test("a reply for a session a new query replaced is dropped: nothing recorded in either record, nothing shown", async () => {
    const r = rig();
    await r.flow.handleResponse({ kind: "question", question: numberQ() });
    const old = r.record();
    const slow = later();
    r.engine.replies.push(slow.promise);
    const answering = r.flow.answer([{ kind: "value", value: "5" }]);
    // Start query: start() replaces the record and clears the questions, then waits for the new session ID.
    const fresh: QuestionRecord = { answers: [] };
    r.session.record = fresh;
    r.flow.questions = [];
    slow.resolve({ kind: "question", question: countryQ() });
    await answering;
    assert.deepEqual(fresh.answers, []);
    assert.deepEqual(old.answers, []);
    assert.deepEqual(r.flow.questions, [], "the new session's questions are untouched");
    assert.deepEqual(types(r), ["question", "busy"], "nothing posted after the late reply");
    await r.page.close();
  });

  test("a late refusal, a late Back and a late automatic answer are dropped too", async () => {
    const r = rig();
    const q = countryQ({ allowUnknown: true });
    await r.flow.handleResponse({ kind: "question", question: q });
    const slow = later();
    r.engine.replies.push(slow.promise);
    const answering = r.flow.answer([{ kind: "skip" }]);
    r.session.record = { answers: [] };
    r.session.sessionId = "s-2";
    slow.reject(refused(SKIP_REFUSED));
    await answering;
    assert.equal(r.flow.refusedSkips.size + r.flow.noAutoSkip.size, 0, "the new session's skip state is untouched");
    assert.deepEqual(types(r), ["question", "busy"]);

    const back = rig();
    back.record().answers.push([{ relationship: "earns", subject: "Fred", object: 5, certainty: 100 }]);
    await back.flow.handleResponse({ kind: "question", question: countryQ() });
    const undone = later();
    back.engine.undoReplies.push(undone.promise);
    const stepping = back.flow.undo();
    const kept = back.record();
    back.flow.questions = []; // a fresh setup card (init) while Back was in flight
    undone.resolve({ kind: "question", question: numberQ() });
    await stepping;
    assert.equal(kept.answers.length, 1, "nothing popped");
    assert.deepEqual(types(back), ["question", "busy"]);

    const auto = rig(FRED_SPEAKS_ENGLISH);
    const skipping = later();
    auto.engine.replies.push(skipping.promise);
    const handling = auto.flow.handleResponse({ kind: "question", question: speaks() });
    const fresh: QuestionRecord = { answers: [] };
    auto.session.record = fresh; // start() has replaced the record; the session ID is not set yet
    skipping.resolve({ kind: "question", question: numberQ() });
    await handling;
    assert.deepEqual(fresh.answers, []);
    assert.deepEqual(types(auto), [], "no transcript card, no next question");
    await r.page.close();
    await back.page.close();
    await auto.page.close();
  });

  test("Back from a result clears the record's result until the engine answers again", async () => {
    const r = rig();
    r.record().answers.push([{ relationship: "earns", subject: "Fred", object: 5, certainty: 100 }]);
    await r.flow.handleResponse({ kind: "result", result: [SPEAKS_RESULT] });
    assert.deepEqual(r.record().results, [SPEAKS_RESULT]);
    assert.deepEqual(r.flow.questions, []);
    r.engine.undoReplies.push({ kind: "question", question: numberQ() });
    r.page.click(".back"); // the result card's Back
    await r.pump();
    assert.equal(r.record().results, undefined);
    assert.deepEqual(r.record().answers, []);
    assert.equal(r.page.text(".qcard .prompt"), "How much does Fred earn?");
    await r.page.close();
  });

  test("a new session starts with a clean skip state", async () => {
    const r = rig();
    const q = countryQ({ allowUnknown: true });
    await r.flow.handleResponse({ kind: "question", question: q });
    r.engine.replies.push(refused(SKIP_REFUSED));
    r.page.click(".qcard [data-skip]");
    await r.pump();
    assert.ok(r.flow.refusedSkips.has(questionKey(q)));
    r.session.record = { answers: [] };
    r.session.sessionId = "s-2";
    await r.flow.handleResponse({ kind: "question", question: q });
    assert.equal(r.flow.refusedSkips.size, 0);
    assert.equal((r.last("question") as { questions: { canSkip: boolean }[] }).questions[0].canSkip, true, "the skip is offered again");
    await r.page.close();
  });
});

describe("host: no reply, an expired session and a failed Back (QuestionFlow)", () => {
  const EXPIRED = "This session has expired — click “New query” to start again.";
  const gone = () => new ApiError("Rainbird API 404", 404, "Session not found");
  const earns = (object: number): Answer => ({ relationship: "earns", subject: "Fred", object, certainty: 100 });

  test("no reply to an answer: the card comes back with the answer kept, nothing is recorded and the group stays open", async () => {
    const r = rig();
    await r.flow.handleResponse({ kind: "question", question: numberQ() });
    const group = r.flow.questions;
    r.engine.replies.push(new TypeError("fetch failed"));
    r.page.type(".qcard input.val", "42");
    r.page.click(".qcard [data-act=submit]");
    await r.pump();
    const asked = r.posts[r.posts.length - 1] as { type: string; note: string; previous: AnswerPayload[] };
    assert.equal(asked.type, "question", "the last post asks the group again");
    assert.equal(asked.note, noReplyNote("fetch failed", [numberQ()]));
    assert.equal(asked.note, "Rainbird did not reply (fetch failed). Give your answer again to resend it.");
    assert.deepEqual(asked.previous, [{ kind: "value", value: "42", certainty: 100 }], "the payloads the card sent");
    assert.equal(r.last("error"), undefined, "no error card");
    assert.deepEqual(r.record().answers, []);
    assert.ok(r.flow.questions === group, "the group stays open: ▶ still asks, as the session may be alive");
    assert.equal(r.page.$$(".qcard").length, 1, "the page shows the card again");
    assert.equal(r.page.text(".qcard .note"), asked.note);
    assert.equal(input(r.page, ".qcard input.val").value, "42", "with the typed value");
    assert.deepEqual(transcript(r.page), [], "no line for an answer the engine never took");

    r.engine.replies.push({ kind: "result", result: [SPEAKS_RESULT] });
    r.page.click(".qcard [data-act=submit]");
    await r.pump();
    assert.deepEqual(r.engine.calls.map((c) => c.op), ["respond", "respond"], "Submit sends it again");
    assert.deepEqual(r.record().answers, [[earns(42)]]);
    assert.deepEqual(transcript(r.page), ["How much does Fred earn?: 42"]);
    await r.page.close();
  });

  test("a group without a reply (503): every answer is back and the note asks to click Submit answers", async () => {
    const r = rig();
    await r.flow.handleResponse({ kind: "question", question: numberQ(), extraQuestions: [truthQ()] });
    const unavailable = new ApiError("Rainbird API 503 on /s-1/response: Service Unavailable", 503, "Service Unavailable");
    r.engine.replies.push(unavailable);
    r.page.type(".q[data-i='0'] input.val", "7");
    r.page.click(".q[data-i='1'] [data-truth=false]");
    r.page.click(".submitAll");
    await r.pump();
    const asked = r.last("question") as { note: string; previous: AnswerPayload[] };
    assert.equal(asked.note, noReplyNote(unavailable.message, [numberQ(), truthQ()]));
    assert.equal(
      asked.note,
      "Rainbird did not reply (Rainbird API 503 on /s-1/response: Service Unavailable). Your answers are kept: click Submit answers to send them again."
    );
    assert.equal(r.last("error"), undefined, "no error card");
    assert.equal(input(r.page, ".q[data-i='0'] input.val").value, "7");
    assert.equal(r.page.$(".q[data-i='1'] [data-truth=false]")?.getAttribute("aria-pressed"), "true");
    assert.deepEqual(r.record().answers, []);
    assert.equal(r.flow.questions.length, 2, "the group stays open");
    await r.page.close();
  });

  test("Back on a question card without a reply shows the error, then the same group; a 404 ends the session instead", async () => {
    const r = rig();
    r.record().answers.push([earns(5)]);
    await r.flow.handleResponse({ kind: "question", question: countryQ(), extraQuestions: [numberQ()] });
    const group = r.flow.questions;
    r.engine.undoReplies.push(new TypeError("fetch failed"));
    r.page.click(".qcard .back");
    await r.pump();
    assert.deepEqual(types(r), ["question", "busy", "error", "question"]);
    assert.equal(r.last("error")?.message, "Could not step back: Rainbird did not reply (fetch failed).");
    assert.equal(r.page.text(".card.err"), "Could not step back: Rainbird did not reply (fetch failed).");
    assert.deepEqual(
      (r.last("question") as { questions: Question[] }).questions.map((q) => q.prompt),
      ["Where does Fred live?", "How much does Fred earn?"]
    );
    assert.equal(r.page.$$(".qcard").length, 1, "the card Back removed is back");
    assert.ok(r.flow.questions === group, "the group stays open");
    assert.deepEqual(r.record().answers, [[earns(5)]], "nothing undone");

    const dead = rig();
    await dead.flow.handleResponse({ kind: "question", question: countryQ() });
    dead.engine.undoReplies.push(gone());
    dead.page.click(".qcard .back");
    await dead.pump();
    assert.deepEqual(types(dead), ["question", "busy", "error"]);
    assert.equal(dead.last("error")?.message, EXPIRED);
    assert.equal(dead.flow.questions.length, 0, "no group is left open");
    await r.page.close();
    await dead.page.close();
  });

  test("Back on a result the engine cannot undo shows the error, then the result again with its actions", async () => {
    const cases: [Error, string][] = [
      [refused("Nothing to undo"), "The engine could not undo: Nothing to undo."],
      [new TypeError("fetch failed"), "Could not step back: Rainbird did not reply (fetch failed)."],
    ];
    for (const [failure, message] of cases) {
      const r = rig();
      await r.flow.handleResponse({ kind: "result", result: [SPEAKS_RESULT] });
      assert.equal(r.flow.questions.length, 0, "a result leaves no group open");
      r.engine.undoReplies.push(failure);
      r.page.click(".back"); // the result card's Back
      await r.pump();
      assert.deepEqual(types(r), ["result", "busy", "error", "result"], message);
      assert.equal(r.last("error")?.message, message);
      assert.deepEqual(r.last("result"), { type: "result", results: [SPEAKS_RESULT], sessionId: "s-1" });
      assert.deepEqual(r.record().results, [SPEAKS_RESULT], "the session still has its result");
      assert.equal(r.page.$$(".result").length, 1, "the result card is back");
      assert.ok(!!r.page.$("#saveTest") && !!r.page.$("#compare"), "with Save as test and Compare");
      await r.page.close();
    }
  });

  test("an automatic “No more” without a reply: the accepted answer's line is written and the question starts on the skip; one click sends it again", async () => {
    const r = rig(FRED_SPEAKS_ENGLISH);
    await r.flow.handleResponse({ kind: "question", question: numberQ() });
    r.engine.replies.push({ kind: "question", question: speaks() }, new TypeError("fetch failed"));
    r.page.type(".qcard input.val", "5");
    r.page.click(".qcard [data-act=submit]");
    await r.pump();
    assert.deepEqual(
      r.engine.calls.map((c) => (c.op === "respond" ? c.answers : [])),
      [[earns(5)], [skipOf(speaks())]]
    );
    assert.deepEqual(types(r), ["question", "busy", "question"], "no error card, and no automatic-answer card");
    const asked = r.last("question") as { note: string; questions: { prompt: string; preSkip: boolean }[] };
    assert.equal(asked.note, autoSkipFailedNote("fetch failed", [speaks()]));
    assert.equal(asked.note, "Rainbird did not reply when the panel answered “No more” for you (fetch failed). Click “No more” to send it again, or answer the question.");
    assert.deepEqual(asked.questions.map((q) => [q.prompt, q.preSkip]), [["Which languages does Fred speak?", true]]);
    assert.deepEqual(r.record().answers, [[earns(5)]], "the accepted answer is recorded, the unanswered skip is not");
    assert.deepEqual(transcript(r.page), ["How much does Fred earn?: 5"], "the accepted answer's line is written");
    assert.equal(r.page.text(".qcard .note"), asked.note);

    r.engine.replies.push({ kind: "result", result: [SPEAKS_RESULT] });
    r.page.click(".qcard [data-skip]");
    await r.pump();
    assert.deepEqual(r.engine.calls[2], { op: "respond", sessionId: "s-1", answers: [skipOf(speaks())] });
    assert.deepEqual(r.record().answers, [[earns(5)], [skipOf(speaks())]]);
    assert.deepEqual(r.record().results, [SPEAKS_RESULT]);
    await r.page.close();
  });

  test("a covered group without a reply starts on every skip; Submit answers sends it again", async () => {
    const reads = speaks({ relationship: "reads", prompt: "Which books does Fred read?", knownAnswers: [{ subject: "Fred", relationship: "reads", object: "Dune", cf: 100 }] });
    const r = rig([...FRED_SPEAKS_ENGLISH, { subject: "Fred", relationship: "reads", object: "Dune", certainty: 100 }]);
    r.engine.replies.push(new ApiError("Rainbird API 502 on /s-1/response: Bad Gateway", 502, "Bad Gateway"));
    await r.flow.handleResponse({ kind: "question", question: speaks(), extraQuestions: [reads] });
    const asked = r.last("question") as { note: string; questions: { preSkip: boolean }[] };
    assert.equal(
      asked.note,
      "Rainbird did not reply when the panel answered “No more” for you (Rainbird API 502 on /s-1/response: Bad Gateway). " +
        "The questions start on “No more”: click Submit answers to send it again, or change an answer first."
    );
    assert.deepEqual(asked.questions.map((q) => q.preSkip), [true, true]);
    assert.deepEqual(r.page.$$(".qcard [data-skip]").map((b) => b.getAttribute("aria-pressed")), ["true", "true"]);
    assert.equal(r.last("error"), undefined);

    r.engine.replies.push({ kind: "result", result: [SPEAKS_RESULT] });
    r.page.click(".submitAll");
    await r.pump();
    assert.deepEqual(r.engine.calls[1], { op: "respond", sessionId: "s-1", answers: [skipOf(speaks()), skipOf(reads)] });
    assert.deepEqual(r.record().results, [SPEAKS_RESULT]);
    await r.page.close();
  });

  test("an automatic “No more” that finds the session gone: the expired-session card, and no group left open", async () => {
    const r = rig(FRED_SPEAKS_ENGLISH);
    await r.flow.handleResponse({ kind: "question", question: numberQ() });
    r.engine.replies.push({ kind: "question", question: speaks() }, gone());
    r.page.type(".qcard input.val", "5");
    r.page.click(".qcard [data-act=submit]");
    await r.pump();
    assert.deepEqual(types(r), ["question", "busy", "error"]);
    assert.equal(r.last("error")?.message, EXPIRED);
    assert.equal(r.flow.questions.length, 0, "no group is left open");
    await r.page.close();
  });

  test("an expired session forgets its automatic answer: a late Answer instead undoes nothing", async () => {
    const r = rig(FRED_SPEAKS_ENGLISH);
    r.engine.replies.push({ kind: "question", question: numberQ() }, gone());
    await r.flow.handleResponse({ kind: "question", question: speaks() });
    assert.deepEqual(types(r), ["autoSkipped", "question"]);
    r.page.type(".qcard input.val", "5");
    r.page.click(".qcard [data-act=submit]");
    await r.pump();
    assert.equal(r.last("error")?.message, EXPIRED);
    r.page.posted.push({ type: "answerInstead" }); // a stale message: the page retired the link when the answer went out
    await r.pump();
    assert.equal(r.engine.calls.filter((c) => c.op === "undo").length, 0, "nothing is sent for a session the engine no longer knows");
    await r.page.close();
  });
});

test("a re-asked one-click card focuses the button that was sent, so Enter resends the same answer", async () => {
  const page = loadWebview(render("n"));
  const yesNo = question({ relationship: "speaks", subject: "Fred", object: "French", prompt: "Does Fred speak French?", type: "First Form" });
  page.send({ type: "question", questions: JSON.parse(JSON.stringify(decorateQuestions([yesNo]))), note: "Rainbird did not reply (fetch failed). Give your answer again to resend it.", previous: [{ kind: "yesno", answer: "no", certainty: 100 }] });
  const no = page.$$("[data-yn=no]").pop();
  assert.ok(no, "the No button is rendered");
  assert.ok(page.window.document.activeElement === no, "focus is on No, the answer that was sent");
  const truth = question({ relationship: "is verified", prompt: "Is it verified?", dataType: "truth" });
  page.send({ type: "question", questions: JSON.parse(JSON.stringify(decorateQuestions([truth]))), previous: [{ kind: "value", value: "false", certainty: 100 }] });
  const falseBtn = page.$$("[data-truth=false]").pop();
  assert.ok(falseBtn && page.window.document.activeElement === falseBtn, "focus is on False, the answer that was sent");
  await page.close();
});
