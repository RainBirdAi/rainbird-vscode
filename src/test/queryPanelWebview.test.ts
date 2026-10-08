/**
 * The query panel webview, driven in happy-dom: setup card → start → question
 * cards → result card. These are the baseline flows every region must keep
 * working; feature tests for each region live alongside.
 */
import { test } from "node:test";
import * as assert from "node:assert/strict";
import { render } from "../queryPanelHtml";
import { loadWebview } from "./webviewHarness";

const GOALS = [
  { name: "speaks", subject: "Person", object: "Language", plural: true },
  { name: "lives in", subject: "Person", object: "Country", plural: false },
];

function initPanel() {
  const page = loadWebview(render("test-nonce"));
  page.send({ type: "init", goals: GOALS, goalsFrom: "editor", kmId: "km-1", apiUrl: "https://api.rainbird.ai", useDraft: true });
  return page;
}

test("the webview script runs and shows the setup card on init", async () => {
  const page = initPanel();
  assert.match(page.text(), /What should Rainbird work out\?/);
  assert.match(page.text("#km"), /km-1/);
  await page.close();
});

test("Start query posts the goal, target and facts", async () => {
  const page = initPanel();
  page.type(".goal", "speaks");
  page.click(".go");
  const start = page.lastPosted("start");
  assert.ok(start, "a start message was posted");
  assert.equal(start.relationship, "speaks");
  assert.deepEqual(start.target, { kind: "draft" });
  await page.close();
});

test("busy turns the setup card into a transcript line and shows the spinner", async () => {
  const page = initPanel();
  page.type(".goal", "speaks");
  page.click(".go");
  page.send({ type: "busy" });
  assert.match(page.text(".transcript"), /^Goal: speaks/);
  assert.ok(page.$(".spin"), "spinner shown");
  await page.close();
});

test("a first-form question answers yes with one click", async () => {
  const page = initPanel();
  page.send({ type: "busy" });
  // Without the host's card meta the webview works it out itself (queryPanelQuestions.test.ts covers decorated messages).
  page.send({
    type: "question",
    questions: [
      {
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
      },
    ],
  });
  assert.ok(!page.$(".spin"), "spinner cleared");
  const yes = page.$$("button").find((b) => b.textContent === "Yes");
  assert.ok(yes, "Yes button rendered");
  page.click(yes);
  const answer = page.lastPosted("answer");
  assert.ok(answer, "an answer was posted");
  assert.deepEqual(answer.payloads, [{ kind: "yesno", answer: "yes", certainty: 100 }]);
  assert.ok(!page.$(".qcard"), "the card is gone");
  assert.ok(!/Does Fred speak French\?: Yes/.test(page.text()), "the transcript waits until the engine accepts the answer");
  page.send({ type: "result", sessionId: "s-1", results: [] });
  assert.match(page.text(), /Does Fred speak French\?: Yes/);
  await page.close();
});

test("a result card shows each result with its certainty", async () => {
  const page = initPanel();
  page.send({
    type: "result",
    sessionId: "s-1",
    results: [{ subject: "Fred", relationship: "speaks", object: "French", certainty: 75, factID: "WA:RF:1" }],
  });
  assert.match(page.text(), /Fred speaks French/);
  assert.match(page.text(), /75% certain/);
  assert.equal(page.$(".result .bar > div")?.getAttribute("style"), "width:75%");
  assert.deepEqual(
    page.$$(".result .acts a").map((a) => a.textContent),
    ["Show evidence", "Explain (AI)", "Show on graph"]
  );
  assert.deepEqual(
    page.$$(".result ~ .foot button").map((b) => b.textContent),
    ["Run another query", "Save as test", "Compare with another version…", "↶ Back"]
  );
  await page.close();
});

test("an error message renders an error card", async () => {
  const page = initPanel();
  page.send({ type: "error", message: "Not connected" });
  assert.match(page.text(".card.err"), /Not connected/);
  await page.close();
});

test("the shared helpers are inlined exactly once and the page still loads", async () => {
  const page = initPanel();
  assert.match(page.text(), /What should Rainbird work out\?/);
  const html = render("n");
  for (const name of ["formatValue", "parseHumanDate", "canSkip", "skipLabel", "rankGoals", "canonicalGoal"]) {
    const declarations = html.split("function " + name + "(").length - 1;
    assert.equal(declarations, 1, name + " is declared exactly once");
  }
  await page.close();
});
