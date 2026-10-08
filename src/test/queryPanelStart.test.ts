/**
 * The query panel's start, driven in happy-dom: a start that fails after
 * "busy" puts the setup card back with everything typed (startError), and the
 * engine's first reply removes it; the note for a Knowledge Map ID the
 * platform does not know (init.mapNote); the subject / object hint; and the
 * notice card, which neither stops the spinner nor drops the answers that wait
 * for the engine.
 *
 * page.text() includes hidden elements, so the hidden setup card is checked
 * through `.hidden`. DOM elements are compared through booleans only: a failing
 * assert.equal on a happy-dom element hangs while it builds its diff.
 */
import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { render } from "../queryPanelHtml";
import { loadWebview } from "./webviewHarness";
import type { Posted, WebviewHarness } from "./webviewHarness";

/** Pages opened by the running test: closed after it even when an assertion fails (an open page keeps node alive). */
const opened: WebviewHarness[] = [];
afterEach(async () => {
  for (const page of opened.splice(0)) await page.close();
});

const GOALS = [
  { name: "speaks", subject: "Person", object: "Language", plural: true, askable: "all", rules: 1, facts: 0, objectType: "string" },
  { name: "lives in", subject: "Person", object: "Country", plural: false, askable: "all", rules: 0, facts: 0, objectType: "string" },
];

/** A page whose script ran, with no init yet. */
function blankPage(): WebviewHarness {
  const page = loadWebview(render("test-nonce"));
  opened.push(page);
  return page;
}

/** A page showing the setup card for the HelloWorld goals. */
function loadPanel(init: Posted = {}): WebviewHarness {
  const page = blankPage();
  page.send({
    type: "init",
    goals: GOALS,
    goalsFrom: "editor",
    askableMixed: false,
    kmId: "2fd1be28-b38d-4fa3-8b9d-b0976821912c",
    apiUrl: "https://api.rainbird.ai",
    useDraft: true,
    ...init,
  });
  return page;
}

/** What the tests read of an element (they compile without the DOM lib). */
type View = {
  value: string;
  disabled: boolean;
  hidden: boolean;
  isConnected: boolean;
  style: { display: string };
};
const node = (page: WebviewHarness, selector: string) => page.$(selector) as unknown as View;
/** The setup card: the card that holds Start query. */
const setupCard = (page: WebviewHarness) => (page.$(".go")?.closest(".card") ?? null) as unknown as View | null;
const transcript = (page: WebviewHarness) => page.$$(".transcript").map((line) => page.text(line));

const FRED_SPEAKS_FRENCH = {
  relationship: "speaks",
  subject: "Fred",
  object: "French",
  prompt: "Does Fred speak French?",
  type: "First Form",
  dataType: "string",
  plural: true,
  allowCF: false,
  allowUnknown: false,
  canAdd: false,
  concepts: [],
  knownAnswers: [],
};
const WHERE_DOES_FRED_LIVE = {
  relationship: "lives in",
  subject: "Fred",
  prompt: "Where does Fred live?",
  type: "Second Form Object",
  dataType: "string",
  plural: false,
  allowCF: false,
  allowUnknown: false,
  canAdd: true,
  concepts: [
    { conceptType: "country", name: "England", type: "string", value: "England" },
    { conceptType: "country", name: "France", type: "string", value: "France" },
  ],
  knownAnswers: [],
};
const NO_LIVE_VERSION =
  "This map has no live version yet, so the engine served the draft instead. Publish a version in Studio and set it live to query a live version.";

// ── A start that fails after busy ──

test("a start that fails after busy puts the setup card back as it was, every field still filled in", () => {
  const page = loadPanel();
  page.type(".goal", "speaks");
  page.type(".subject", "Tom");
  page.type(".object", "French");
  page.type(".target", "version");
  page.type(".version", "3");
  page.type(".factsText", "Tom,lives in,France,100");
  page.click(".go");
  const start = {
    type: "start",
    relationship: "speaks",
    subject: "Tom",
    object: "French",
    target: { kind: "version", version: 3 },
    facts: "Tom,lives in,France,100",
  };
  assert.deepEqual(page.lastPosted("start"), start);
  const card = setupCard(page);
  assert.ok(card, "the setup card");

  page.send({ type: "busy" });
  assert.ok(card.hidden && card.isConnected, "the card is hidden while the engine works, not removed");
  assert.deepEqual(transcript(page), ["Goal: speaks — subject: Tom — object: French · version 3 · with injected facts"]);
  assert.ok(page.$(".spin"), "the spinner shows");

  const message =
    "The engine rejected the injected facts: 1) Could not find relationship for injection: Lives In. Relationship and instance names are case-sensitive and must match the map exactly.";
  page.send({ type: "startError", message });
  assert.ok(!page.$(".spin"), "no spinner");
  assert.deepEqual(transcript(page), [], "no Goal line");
  assert.ok(!card.hidden && card.isConnected, "the card is visible again");
  assert.ok(setupCard(page) === card, "the same card, not a fresh one");
  assert.equal(page.$$(".go").length, 1, "one setup card");
  assert.ok(!page.$(".card.err"), "the message goes in the card, not in an error card");
  assert.equal(node(page, ".goal").value, "speaks");
  assert.equal(node(page, ".subject").value, "Tom");
  assert.equal(node(page, ".object").value, "French");
  assert.equal(node(page, ".target").value, "version");
  assert.equal(node(page, ".verwrap").style.display, "", "the version field still shows");
  assert.equal(node(page, ".version").value, "3");
  assert.equal(node(page, ".factsText").value, "Tom,lives in,France,100");
  assert.equal(page.text(".startErr"), message);
  assert.ok(!node(page, ".go").disabled, "Start query is enabled again");
  assert.equal(page.text(".go"), "Start query");

  page.click(".go");
  const starts = page.posted.filter((m) => m.type === "start");
  assert.equal(starts.length, 2, "clicking Start query again posts a second start");
  assert.deepEqual(starts[1], start, "the same start again");
  page.send({ type: "busy" });
  assert.ok(card.hidden, "hidden again while the engine works");
  assert.deepEqual(transcript(page), ["Goal: speaks — subject: Tom — object: French · version 3 · with injected facts"], "one Goal line");
});

test("the unknown-goal note keeps its blank line under the restored card", () => {
  const page = loadPanel();
  page.type(".goal", "speaks");
  page.type(".subject", "Tom");
  page.click(".go");
  page.send({ type: "busy" });
  const message = 'Rainbird API 400 on /s-1/query: Bad request!\n\nThe map (km-1) has no relationship named exactly "speaks" — names are case-sensitive.';
  page.send({ type: "startError", message });
  const slot = page.$(".startErr");
  assert.ok(slot, "the card's error line");
  assert.equal(slot.textContent, message, "the text as sent, line breaks included");
  assert.equal(page.window.getComputedStyle(slot).whiteSpace, "pre-wrap", "and shown with its blank line");
});

const REPLIES: [string, Posted][] = [
  ["question", { type: "question", questions: [FRED_SPEAKS_FRENCH] }],
  ["result", { type: "result", sessionId: "s-1", results: [{ subject: "Tom", relationship: "speaks", object: "French", certainty: 75, factID: "WA:RF:1" }] }],
  ["autoSkipped", { type: "autoSkipped", items: [{ prompt: "Which languages does Tom speak?", label: "No more", values: ["French"], reason: "injected" }] }],
];
for (const [kind, reply] of REPLIES) {
  test(`the first ${kind} after busy removes the hidden setup card and keeps the Goal line`, () => {
    const page = loadPanel();
    page.type(".goal", "speaks");
    page.type(".subject", "Tom");
    page.click(".go");
    page.send({ type: "busy" });
    const card = setupCard(page);
    assert.ok(card && card.hidden, "hidden while the engine works");
    page.send(reply);
    assert.ok(!page.$(".go"), "no setup card remains");
    assert.ok(!card.isConnected, "the hidden card is gone");
    assert.equal(transcript(page)[0], "Goal: speaks — subject: Tom · draft", "the Goal line stays");
  });
}

test("New query while a start is pending shows one fresh setup card", () => {
  const page = loadPanel();
  page.type(".goal", "speaks");
  page.type(".subject", "Tom");
  page.click(".go");
  page.send({ type: "busy" });
  page.click("#newQuery");
  assert.equal(page.$$(".go").length, 1, "one setup card");
  const card = setupCard(page);
  assert.ok(card && !card.hidden, "visible");
  assert.equal(node(page, ".subject").value, "", "a fresh card");
  assert.deepEqual(transcript(page), []);
});

// ── A Knowledge Map ID the platform does not know ──

test("init.mapNote shows under the card's prompt until the next init, through New query and Run another query", () => {
  const note =
    "No map with Knowledge Map ID <b>bad</b> is visible to this API key on https://api.rainbird.ai. Check the ID on the map's Publish page in Studio, and that the key belongs to the same environment. Click “Change…” at the top to query another map.";
  const page = loadPanel({ kmId: "<b>bad</b>", goals: [], goalsFrom: "none", mapNote: note });
  assert.equal(page.text(".mapNote"), note);
  assert.ok(page.$(".mapNote")?.classList.contains("err"), "shown as an error");
  assert.ok(!page.$(".mapNote b"), "escaped, never rendered as markup");
  assert.ok((page.$(".card .prompt")?.nextElementSibling as unknown) === (page.$(".mapNote") as unknown), "right under the card's prompt");

  page.click("#newQuery");
  assert.equal(page.text(".mapNote"), note, "New query keeps it");
  page.type(".goal", "speaks");
  page.type(".subject", "Tom");
  page.click(".go");
  page.send({ type: "busy" });
  page.send({ type: "result", sessionId: "s-1", results: [] });
  page.click("#again");
  assert.equal(page.text(".mapNote"), note, "Run another query keeps it");

  page.send({ type: "init", goals: GOALS, goalsFrom: "editor", kmId: "km-2", apiUrl: "https://api.rainbird.ai", useDraft: true });
  assert.ok(!page.$(".mapNote"), "the next init, without a note, shows none");
});

test("an init without mapNote shows no note", () => {
  const page = loadPanel();
  assert.ok(!page.$(".mapNote"));
});

// ── Subject, object or both ──

test("the hint asks for a subject, an object or both, and neither field is labelled optional", () => {
  const page = loadPanel();
  const hints = page.$$(".hint").map((hint) => page.text(hint));
  assert.ok(
    hints.includes("Fill the subject to ask “what does Fred …”, the object to ask “who …”, or both to ask how certain one fact is."),
    `the hint: ${JSON.stringify(hints)}`
  );
  assert.doesNotMatch(page.text(), /Leave both empty/);
  assert.deepEqual(
    page.$$(".row2 label").slice(0, 2).map((label) => page.text(label)),
    ["Subject", "Object"]
  );
});

// ── Notices ──

test("a notice goes above the spinner, which keeps running", () => {
  const page = loadPanel();
  page.type(".goal", "speaks");
  page.type(".subject", "Tom");
  page.click(".go");
  page.send({ type: "busy" });
  page.send({ type: "notice", message: NO_LIVE_VERSION });
  const spin = page.$(".spin");
  const notice = page.$(".card.notice");
  assert.ok(spin, "the spinner stays");
  assert.ok(notice, "a notice card");
  assert.equal(page.text(notice), NO_LIVE_VERSION);
  assert.ok((notice.nextElementSibling as unknown) === (spin as unknown), "right above the spinner");
  assert.ok(!page.$(".card.err"), "not an error card");
  assert.equal(transcript(page)[0], "Goal: speaks — subject: Tom · draft");

  page.send({ type: "question", questions: [FRED_SPEAKS_FRENCH] });
  assert.ok(!page.$(".spin"), "the question replaces the spinner");
  page.send({ type: "notice", message: "Second notice." });
  const notices = page.$$(".card.notice");
  assert.equal(notices.length, 2);
  assert.ok((page.$("#flow")?.lastElementChild as unknown) === (notices[1] as unknown), "with no spinner, at the end");
});

test("answers waiting for the engine survive a notice, and are written when the next question arrives", () => {
  const page = blankPage();
  page.send({ type: "busy" });
  page.send({ type: "question", questions: [FRED_SPEAKS_FRENCH] });
  const yes = page.$$("button").find((b) => b.textContent === "Yes");
  assert.ok(yes, "a Yes button");
  page.click(yes);
  assert.deepEqual(page.lastPosted("answer")?.payloads, [{ kind: "yesno", answer: "yes", certainty: 100 }]);
  page.send({ type: "busy" });
  page.send({ type: "notice", message: NO_LIVE_VERSION });
  assert.ok(page.$(".spin"), "still reasoning");
  assert.doesNotMatch(page.text(), /Does Fred speak French\?: Yes/, "the engine has not accepted the answer yet");
  page.send({ type: "question", questions: [WHERE_DOES_FRED_LIVE] });
  assert.ok(transcript(page).includes("Does Fred speak French?: Yes"), `the answer is written: ${JSON.stringify(transcript(page))}`);
  assert.ok(page.$(".card.notice"), "the notice stays");
  assert.match(page.text(), /Where does Fred live\?/);
});
