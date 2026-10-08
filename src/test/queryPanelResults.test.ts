/**
 * The query panel's results region, driven in happy-dom: result cards (values
 * written the way the goal's data type writes them), the evidence slot (the
 * tree arrives as HTML from the shared renderer; Show / Hide evidence; the
 * locked card; errors with Retry), the tree's own toolbar inside the panel, the
 * AI explanation and the card's other actions.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { render } from "../queryPanelHtml";
import { RESULTS_CSS } from "../queryWebview/results";
import { EVIDENCE_CSS, EVIDENCE_SCRIPT, renderEvidenceHtml } from "../evidenceRender";
import { expandEvidence } from "../evidenceModel";
import {
  HELLO_WORLD,
  HELLO_WORLD_KM_ID,
  HELLO_WORLD_ROOT_ID,
  HELLO_WORLD_SESSION_ID,
  LOAN,
  LOAN_ROOT_ID,
  NodeMap,
  fakeFetch,
} from "./fixtures/evidenceFixtures";
import { Posted, WebviewHarness, loadWebview } from "./webviewHarness";

/** Goals as the setup region receives them in `init`: every goal carries its object's data type. */
const GOALS = [
  { name: "speaks", subject: "person", object: "language", plural: true, askable: "all", rules: 1, facts: 0, objectType: "string" },
  { name: "has birth date", subject: "person", object: "date", plural: false, askable: "all", rules: 0, facts: 0, objectType: "date" },
  { name: "qualifies for", subject: "person", object: "product", plural: false, askable: "none", rules: 1, facts: 0, objectType: "string" },
];

/** The real HelloWorld result: the root of the HELLO_WORLD evidence capture. */
const TOM_SPEAKS_FRENCH = { subject: "Tom", relationship: "speaks", object: "French", certainty: 71, factID: HELLO_WORLD_ROOT_ID };
const TOM_QUALIFIES = { subject: "Tom", relationship: "qualifies for", object: "premium loan", certainty: 46, factID: LOAN_ROOT_ID };

const LOCKED_TEXT =
  "Evidence is locked for this map. Enable Evidence Tree Link in Studio (Publish → API Management → Access Control), or enter the map's evidence key.";

function resultPanel(results: Posted[] = [TOM_SPEAKS_FRENCH]): WebviewHarness {
  const page = loadWebview(render("test-nonce"));
  page.send({ type: "init", goals: GOALS, goalsFrom: "editor", kmId: "km-1", apiUrl: "https://api.rainbird.ai", useDraft: true });
  page.send({ type: "result", sessionId: HELLO_WORLD_SESSION_ID, results });
  return page;
}

const EXPIRED_TEXT = "This session has expired — click “New query” to start again.";

/** The HTML the extension posts for a result: the shared renderer with the panel's toolbar. */
async function treeHtml(nodes: NodeMap, rootId: string, fail?: Record<string, Error>): Promise<string> {
  const tree = await expandEvidence(fakeFetch(nodes, { fail }), rootId);
  return renderEvidenceHtml(tree, { toolbar: { studio: true, copyLink: true, openPanel: true } });
}

const ofType = (page: WebviewHarness, type: string) => page.posted.filter((m) => m.type === type);
const isHidden = (page: WebviewHarness, selector: string) => (page.$(selector) as unknown as { hidden: boolean }).hidden;
const isDisabled = (element: unknown) => (element as { disabled: boolean }).disabled;
const isOpen = (element: unknown) => (element as { open: boolean }).open;
const actionLinks = (page: WebviewHarness) => page.$$(".result .acts a").map((a) => a.textContent);

describe("query panel results: result cards", () => {
  test("a date result is written as YYYY-MM-DD, from the goal's objectType", async () => {
    const page = resultPanel([{ subject: "Fred", relationship: "has birth date", object: 370742400000, certainty: 100, factID: "WA:RF:d1" }]);
    assert.match(page.text(".result .fact"), /^Fred has birth date 1981-10-01$/);
    assert.match(page.text(".result"), /100% certain/);
    await page.close();
  });

  test("a relationship missing from the goal list keeps the value as the engine sent it", async () => {
    const page = resultPanel([{ subject: "Fred", relationship: "has id", object: 370742400000, certainty: 80, factID: "WA:RF:i1" }]);
    assert.equal(page.text(".result .fact"), "Fred has id 370742400000");
    await page.close();
  });

  test("every dynamic value is escaped", async () => {
    const page = resultPanel([{ subject: '<img src=x onerror="alert(1)">', relationship: "speaks", object: "<b>French</b>", certainty: 50, factID: 'WA:RF:"x' }]);
    assert.equal(page.$$("img").length, 0);
    assert.equal(page.$$(".result b").length, 0);
    assert.match(page.text(".result .fact"), /<img src=x onerror="alert\(1\)"> speaks <b>French<\/b>/);
    await page.close();
  });

  test("Show on graph, Save as test, Compare and Back post their messages", async () => {
    const page = resultPanel();
    page.click("[data-overlay]");
    page.click("#saveTest");
    page.click("#compare");
    assert.deepEqual(page.posted, [
      { type: "overlay", factId: HELLO_WORLD_ROOT_ID },
      { type: "saveTest" },
      { type: "compare" },
    ]);
    page.click(".result ~ .foot .back");
    assert.ok(!page.$(".result"), "Back removes the result card");
    assert.deepEqual(page.lastPosted("undo"), { type: "undo" });
    assert.match(page.text(".transcript:last-child"), /back one step/);
    await page.close();
  });

  test("Explain (AI) streams explainDelta text into the result", async () => {
    const page = resultPanel();
    page.click("[data-explain]");
    assert.deepEqual(page.lastPosted("explain"), { type: "explain", factId: HELLO_WORLD_ROOT_ID });
    assert.ok(!page.$("[data-explain]"), "the link goes once clicked");
    assert.equal(page.text(".explain"), "…");
    page.send({ type: "explainDelta", factId: HELLO_WORLD_ROOT_ID, text: "Tom speaks French " });
    page.send({ type: "explainDelta", factId: HELLO_WORLD_ROOT_ID, text: "because he lives in France." });
    assert.equal(page.text(".explain"), "Tom speaks French because he lives in France.");
    page.send({ type: "explainDone", factId: HELLO_WORLD_ROOT_ID });
    assert.deepEqual(actionLinks(page), ["Show evidence", "Show on graph"], "a finished explanation does not offer another");
    await page.close();
  });

  test("a failed explanation gives the Explain (AI) link back, in its place, to try again", async () => {
    const page = resultPanel();
    page.click("[data-explain]");
    page.send({ type: "explainDelta", factId: HELLO_WORLD_ROOT_ID, text: "\n(Explanation failed: Evidence is locked for this map.)" });
    page.send({ type: "explainDone", factId: HELLO_WORLD_ROOT_ID, failed: true });
    assert.deepEqual(actionLinks(page), ["Show evidence", "Explain (AI)", "Show on graph"]);
    assert.match(page.text(".explain"), /Explanation failed/);

    page.send({ type: "explainDone", factId: HELLO_WORLD_ROOT_ID, failed: true });
    assert.equal(page.$$("[data-explain]").length, 1, "never two links");

    page.click("[data-explain]");
    assert.equal(ofType(page, "explain").length, 2);
    assert.equal(page.text(".explain"), "…", "the failure text makes way for the new explanation");
    page.send({ type: "explainDelta", factId: HELLO_WORLD_ROOT_ID, text: "Tom speaks French." });
    assert.equal(page.text(".explain"), "Tom speaks French.");
    await page.close();
  });

  test("the row's links work from the keyboard: Enter and Space, with aria-expanded following the evidence", async () => {
    const page = resultPanel();
    const link = () => page.$("[data-ev]")!;
    for (const a of page.$$(".result .acts a")) {
      assert.equal(a.getAttribute("role"), "button");
      assert.equal(a.getAttribute("tabindex"), "0");
    }
    assert.equal(link().getAttribute("aria-controls"), page.$(".evtree")?.id);
    assert.equal(link().getAttribute("aria-expanded"), "false");

    page.key("[data-ev]", "a");
    assert.equal(ofType(page, "evidence").length, 0, "other keys do nothing");
    page.key("[data-ev]", "Enter");
    assert.deepEqual(ofType(page, "evidence"), [{ type: "evidence", factId: HELLO_WORLD_ROOT_ID }]);
    page.send({ type: "evidence", factId: HELLO_WORLD_ROOT_ID, html: await treeHtml(HELLO_WORLD, HELLO_WORLD_ROOT_ID) });
    assert.equal(link().getAttribute("aria-expanded"), "true");
    page.key("[data-ev]", " ");
    assert.equal(isHidden(page, ".evtree"), true);
    assert.equal(link().getAttribute("aria-expanded"), "false");

    page.key("[data-overlay]", "Enter");
    page.key("[data-explain]", " ");
    assert.deepEqual(page.lastPosted("overlay"), { type: "overlay", factId: HELLO_WORLD_ROOT_ID });
    assert.deepEqual(page.lastPosted("explain"), { type: "explain", factId: HELLO_WORLD_ROOT_ID });
    await page.close();
  });
});

describe("query panel results: evidence", () => {
  test("Show evidence asks the extension once and says it is loading", async () => {
    const page = resultPanel();
    page.click("[data-ev]");
    page.click("[data-ev]");
    assert.deepEqual(ofType(page, "evidence"), [{ type: "evidence", factId: HELLO_WORLD_ROOT_ID }]);
    assert.equal(page.text("[data-ev]"), "Loading evidence…");
    await page.close();
  });

  test("an evidence message with html renders in the result's slot, and the link toggles Hide / Show without asking again", async () => {
    const page = resultPanel();
    page.click("[data-ev]");
    page.send({ type: "evidence", factId: HELLO_WORLD_ROOT_ID, html: await treeHtml(HELLO_WORLD, HELLO_WORLD_ROOT_ID) });
    const tree = page.$(".result .evtree > .evt");
    assert.ok(tree, "the tree is inside the result's slot");
    assert.equal(tree.getAttribute("data-fact"), HELLO_WORLD_ROOT_ID);
    assert.match(page.text(".evtree"), /Tom speaks French/);
    assert.match(page.text(".evtree"), /Inputs used by this result \(2\)/);
    assert.equal(isHidden(page, ".evtree"), false);
    assert.equal(page.text("[data-ev]"), "Hide evidence");

    page.click("[data-ev]");
    assert.equal(isHidden(page, ".evtree"), true);
    assert.equal(page.text("[data-ev]"), "Show evidence");

    page.click("[data-ev]");
    assert.equal(isHidden(page, ".evtree"), false);
    assert.equal(page.text("[data-ev]"), "Hide evidence");
    assert.ok(page.$(".evtree > .evt") === tree, "the same tree, kept in the page");
    assert.equal(ofType(page, "evidence").length, 1, "hiding and showing again do not ask the extension");
    await page.close();
  });

  test("the tree's toolbar posts evidenceAction with the result's factID, once per click", async () => {
    const page = resultPanel();
    page.click("[data-ev]");
    page.send({ type: "evidence", factId: HELLO_WORLD_ROOT_ID, html: await treeHtml(HELLO_WORLD, HELLO_WORLD_ROOT_ID) });
    page.click('.evtree [data-evt-act="openStudio"]');
    page.click('.evtree [data-evt-act="copyLink"]');
    page.click('.evtree [data-evt-act="openPanel"]');
    assert.deepEqual(ofType(page, "evidenceAction"), [
      { type: "evidenceAction", action: "openStudio", factId: HELLO_WORLD_ROOT_ID },
      { type: "evidenceAction", action: "copyLink", factId: HELLO_WORLD_ROOT_ID },
      { type: "evidenceAction", action: "openPanel", factId: HELLO_WORLD_ROOT_ID },
    ]);
    assert.equal(ofType(page, "evidence").length, 1, "toolbar clicks are not taken for Show evidence");
    await page.close();
  });

  test("Expand all and Collapse all work in the panel; the evidence script and stylesheet are included once", async () => {
    const html = render("n");
    assert.equal(html.split(EVIDENCE_SCRIPT).length - 1, 1, "EVIDENCE_SCRIPT once");
    assert.equal(html.split(EVIDENCE_CSS).length - 1, 1, "EVIDENCE_CSS once");
    assert.ok(!html.includes("function evidenceNode("), "the old in-webview renderer is gone");

    const page = resultPanel([TOM_QUALIFIES]);
    page.click("[data-ev]");
    page.send({ type: "evidence", factId: LOAN_ROOT_ID, html: await treeHtml(LOAN, LOAN_ROOT_ID) });
    const details = () => page.$$(".evtree details");
    assert.ok(details().length > 2, "a nested rule card and more");
    assert.ok(isOpen(page.$(".evtree details.evt-root")), "the root card starts open");
    assert.ok(!isOpen(page.$(".evtree details.evt-root details.evt-rulecard")), "nested rule cards start closed");

    page.click('.evtree [data-evt-act="expand"]');
    assert.ok(details().every(isOpen), "Expand all opens everything");
    page.click('.evtree [data-evt-act="collapse"]');
    assert.deepEqual(
      details().map(isOpen),
      details().map((d) => d.classList.contains("evt-root")),
      "Collapse all closes everything but the root card"
    );
    assert.equal(ofType(page, "evidenceAction").length, 0, "expand and collapse stay in the page");
    await page.close();
  });

  test("the locked card's Set evidence key… posts its own action; the card stays when the key did not change", async () => {
    const page = resultPanel();
    page.click("[data-ev]");
    page.send({ type: "evidence", factId: HELLO_WORLD_ROOT_ID, locked: true });
    assert.ok(page.text(".evtree .ev-locked").startsWith(LOCKED_TEXT));
    assert.equal(page.text("[data-ev]"), "Hide evidence");
    const card = page.$(".ev-locked");

    page.click("[data-ev-setkey]");
    assert.deepEqual(page.lastPosted("evidenceAction"), { type: "evidenceAction", action: "setKey", factId: HELLO_WORLD_ROOT_ID });
    assert.ok(page.$$(".ev-locked button").every(isDisabled), "one prompt at a time: Set evidence key… and Retry wait for the answer");
    assert.equal(ofType(page, "evidence").length, 1, "the button is not a Show evidence click");

    // Cancelled or unchanged: the same card, its buttons working again.
    page.send({ type: "evidenceKey", factId: HELLO_WORLD_ROOT_ID, changed: false });
    assert.ok(page.$(".ev-locked") === card, "the same locked card stays");
    assert.ok(!page.$$(".ev-locked button").some(isDisabled));

    // A new key: the extension loads the tree again itself, and it replaces the card.
    page.click("[data-ev-setkey]");
    page.send({ type: "evidenceKey", factId: HELLO_WORLD_ROOT_ID, changed: true });
    assert.ok(!page.$(".ev-locked"), "the locked card makes way for the loading placeholder");
    assert.equal(page.text(".evtree"), "Loading evidence…");
    assert.equal(page.text("[data-ev]"), "Loading evidence…");
    assert.equal(ofType(page, "evidence").length, 1, "the extension retries; the page does not ask again");
    page.send({ type: "evidence", factId: HELLO_WORLD_ROOT_ID, html: await treeHtml(HELLO_WORLD, HELLO_WORLD_ROOT_ID) });
    assert.ok(page.$(".evtree > .evt"));
    assert.equal(page.text("[data-ev]"), "Hide evidence");
    assert.equal(ofType(page, "evidenceAction").length, 2);
    await page.close();
  });

  test("a tree loaded while the key prompt was open stays when the key turns out unchanged, hidden if the user hid it", async () => {
    const page = resultPanel();
    page.click("[data-ev]");
    page.send({ type: "evidence", factId: HELLO_WORLD_ROOT_ID, locked: true });
    page.click("[data-ev-setkey]");
    // Meanwhile Evidence Tree Link was enabled in Studio: hiding and showing the card loads the tree.
    page.click("[data-ev]");
    page.click("[data-ev]");
    assert.equal(ofType(page, "evidence").length, 2);
    page.send({ type: "evidence", factId: HELLO_WORLD_ROOT_ID, html: await treeHtml(HELLO_WORLD, HELLO_WORLD_ROOT_ID) });
    page.click("[data-ev]");
    assert.equal(isHidden(page, ".evtree"), true);

    page.send({ type: "evidenceKey", factId: HELLO_WORLD_ROOT_ID, changed: false });
    assert.ok(page.$(".evtree > .evt"), "the tree is kept");
    assert.equal(isHidden(page, ".evtree"), true);
    assert.equal(page.text("[data-ev]"), "Show evidence");
    await page.close();
  });

  test("Retry on the locked card asks again (after enabling Evidence Tree Link in Studio)", async () => {
    const page = resultPanel();
    page.click("[data-ev]");
    page.send({ type: "evidence", factId: HELLO_WORLD_ROOT_ID, locked: true });
    assert.equal(page.$(".ev-locked [data-ev-retry]")?.tagName, "BUTTON");
    page.click(".ev-locked [data-ev-retry]");
    assert.equal(ofType(page, "evidence").length, 2);
    assert.equal(page.text("[data-ev]"), "Loading evidence…");
    assert.ok(!page.$(".ev-locked"), "a placeholder replaces the card while it loads");
    assert.equal(page.text(".evtree"), "Loading evidence…");
    await page.close();
  });

  test("while the tree loads, nothing asks for it again: Show evidence, or a Retry still on the page", async () => {
    const page = resultPanel();
    page.click("[data-ev]");
    page.send({ type: "evidence", factId: HELLO_WORLD_ROOT_ID, error: "Rainbird API 502 on /analysis/evidence: bad gateway" });
    page.click(".evtree [data-ev-retry]");
    assert.ok(!page.$(".evtree [data-ev-retry]"), "the error card and its Retry make way for the placeholder");
    // A stale Retry (say, from a card drawn before the reply) does not ask a second time.
    page.$(".evtree")!.insertAdjacentHTML("beforeend", `<button type="button" data-ev-retry="${HELLO_WORLD_ROOT_ID}">Retry</button>`);
    page.click(".evtree [data-ev-retry]");
    page.click(".evtree [data-ev-retry]");
    page.click("[data-ev]");
    assert.equal(ofType(page, "evidence").length, 2, "Show evidence and one Retry");

    page.send({ type: "evidence", factId: HELLO_WORLD_ROOT_ID, html: await treeHtml(HELLO_WORLD, HELLO_WORLD_ROOT_ID) });
    assert.ok(page.$(".evtree > .evt"));
    await page.close();
  });

  test("a tree with facts that could not be loaded offers Retry and is fetched again on the next Show", async () => {
    const page = resultPanel();
    page.click("[data-ev]");
    const partial = await treeHtml(HELLO_WORLD, HELLO_WORLD_ROOT_ID, {
      [HELLO_WORLD_KM_ID]: new Error("Rainbird API 503 on /analysis/evidence: unavailable"),
    });
    page.send({ type: "evidence", factId: HELLO_WORLD_ROOT_ID, html: partial, partial: true });
    assert.match(page.text(".evtree"), /1 fact could not be loaded/);
    assert.equal(page.$(".evtree .ev-partial [data-ev-retry]")?.tagName, "BUTTON");
    page.click("[data-ev]");
    page.click("[data-ev]");
    assert.equal(ofType(page, "evidence").length, 2, "showing it again asks again");
    assert.equal(page.text("[data-ev]"), "Loading evidence…");

    page.send({ type: "evidence", factId: HELLO_WORLD_ROOT_ID, html: await treeHtml(HELLO_WORLD, HELLO_WORLD_ROOT_ID) });
    assert.ok(!page.$(".ev-partial"), "a complete tree has no partial-tree Retry");
    page.click("[data-ev]");
    page.click("[data-ev]");
    assert.equal(ofType(page, "evidence").length, 2, "a complete tree is kept");

    page.send({ type: "evidence", factId: HELLO_WORLD_ROOT_ID, html: partial, partial: true });
    page.click(".evtree .ev-partial [data-ev-retry]");
    assert.equal(ofType(page, "evidence").length, 3, "Retry under a partial tree asks again");
    await page.close();
  });

  test("an expired session says so, without Retry, and showing it again does not ask again", async () => {
    const page = resultPanel();
    page.click("[data-ev]");
    page.send({ type: "evidence", factId: HELLO_WORLD_ROOT_ID, error: EXPIRED_TEXT, expired: true });
    assert.equal(page.text(".evtree .err"), EXPIRED_TEXT);
    assert.ok(!page.$(".evtree [data-ev-retry]"), "no Retry for an expired session");
    page.click("[data-ev]");
    page.click("[data-ev]");
    assert.equal(isHidden(page, ".evtree"), false);
    assert.equal(page.text(".evtree .err"), EXPIRED_TEXT);
    assert.equal(ofType(page, "evidence").length, 1);
    await page.close();
  });

  test("any other error shows its message with Retry, which asks again", async () => {
    const page = resultPanel();
    page.click("[data-ev]");
    page.send({ type: "evidence", factId: HELLO_WORLD_ROOT_ID, error: "Rainbird API 500 on /analysis/evidence: <boom>" });
    assert.equal(page.$$(".evtree boom").length, 0, "the message is escaped");
    assert.equal(page.text(".evtree .err"), "Rainbird API 500 on /analysis/evidence: <boom> Retry");
    assert.equal(page.$(".evtree .err [data-ev-retry]")?.tagName, "BUTTON", "Retry is a button: the keyboard reaches it");
    assert.equal(page.text("[data-ev]"), "Hide evidence");

    page.click(".evtree [data-ev-retry]");
    assert.deepEqual(ofType(page, "evidence"), [
      { type: "evidence", factId: HELLO_WORLD_ROOT_ID },
      { type: "evidence", factId: HELLO_WORLD_ROOT_ID },
    ]);
    assert.equal(page.text("[data-ev]"), "Loading evidence…");

    // Hiding an error and showing it again asks again too: only a loaded tree is kept.
    page.send({ type: "evidence", factId: HELLO_WORLD_ROOT_ID, error: "Rainbird API 502 on /analysis/evidence: try later" });
    page.click("[data-ev]");
    page.click("[data-ev]");
    assert.equal(ofType(page, "evidence").length, 3);
    await page.close();
  });

  test("with two results, each tree lands in its own slot", async () => {
    const page = resultPanel([TOM_SPEAKS_FRENCH, TOM_QUALIFIES]);
    const [first, second] = page.$$(".result");
    page.click(second.querySelector("[data-ev]") as never);
    page.send({ type: "evidence", factId: LOAN_ROOT_ID, html: await treeHtml(LOAN, LOAN_ROOT_ID) });
    assert.ok(!first.querySelector(".evt"), "nothing lands in the first result's slot");
    assert.equal(second.querySelector(".evt")?.getAttribute("data-fact"), LOAN_ROOT_ID);
    assert.equal(first.querySelector("[data-ev]")?.textContent, "Show evidence");
    await page.close();
  });

  test("evidence for a card that is gone is ignored", async () => {
    const page = resultPanel();
    page.click("[data-ev]");
    page.click(".result ~ .foot .back");
    page.send({ type: "evidence", factId: HELLO_WORLD_ROOT_ID, html: await treeHtml(HELLO_WORLD, HELLO_WORLD_ROOT_ID) });
    assert.ok(!page.$(".evt"), "no tree is drawn");
    await page.close();
  });

  test("the panel stays 640px wide; a wide tree scrolls inside its card", () => {
    assert.match(render("n"), /max-width: 640px/);
    assert.ok(!/(^|[\s}])body\s*\{/.test(RESULTS_CSS), "the results region does not restyle the page");
    assert.match(RESULTS_CSS, /\.evtree > \.evt \{ overflow-x: auto; \}/);
  });
});
