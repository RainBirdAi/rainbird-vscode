/**
 * The query panel's setup region, driven in happy-dom: the searchable goal
 * combobox (filtering, highlighting, keyboard, groups, "Use … as typed", the
 * case hint, ARIA), the preselection, Enter-to-start, the free-text fallback
 * and the "Change…" link. Also the VS Code-free host helpers in
 * src/queryWebview/setup.ts: the init goal list (with objectType), the goal to
 * prefill and the per-map memory of the last goal.
 */
import { afterEach, test } from "node:test";
import * as assert from "node:assert/strict";
import { render } from "../queryPanelHtml";
import {
  LAST_GOALS_CAP,
  lastGoalFor,
  noMapNote,
  panelGoals,
  preselectGoal,
  unknownGoalNote,
  withLastGoal,
} from "../queryWebview/setup";
import { loadWebview, Posted, WebviewHarness } from "./webviewHarness";

/** Pages opened by the running test: closed after it even when an assertion fails (an open page keeps node alive). */
const opened: WebviewHarness[] = [];
afterEach(async () => {
  for (const page of opened.splice(0)) await page.close();
});
function track(page: WebviewHarness): WebviewHarness {
  opened.push(page);
  return page;
}

/** An explicit fixture (examples/bigger_map.rbl has no "has total income" or "Amount"). */
const GOALS = [
  { name: "has total income", subject: "Person", object: "Amount", plural: false, askable: "none", rules: 2, facts: 0, objectType: "number" },
  { name: "total penalty", subject: "Case", object: "Penalty", plural: false, askable: "none", rules: 1, facts: 0, objectType: "number" },
  { name: "penalty subtotal one", subject: "Case", object: "Penalty", plural: false, askable: "none", rules: 1, facts: 0, objectType: "number" },
  { name: "penalty subtotal two", subject: "Case", object: "Penalty", plural: false, askable: "none", rules: 1, facts: 0, objectType: "number" },
  { name: "speaks", subject: "Person", object: "Language", plural: true, askable: "all", rules: 1, facts: 0, objectType: "string" },
  { name: "lives in", subject: "Person", object: "Country", plural: false, askable: "all", rules: 0, facts: 0, objectType: "string" },
  { name: "national language", subject: "Country", object: "Language", plural: false, askable: "none", rules: 0, facts: 2, objectType: "string" },
  { name: "date of birth", subject: "Person", object: "Birth date", plural: false, askable: "none", rules: 0, facts: 0, objectType: "date" },
];

/** Exposes the setup region's shared `goals` and `setup` to the test (they live in the page's one script scope). */
const PROBE = "\nwindow.__setupProbe = { goals: function () { return goals; }, setupType: function () { return typeof setup; } };\n";

function loadPanel(init: Posted = {}): WebviewHarness {
  const page = track(loadWebview(render("test-nonce").replace("</script>", PROBE + "</script>")));
  page.send({
    type: "init",
    goals: GOALS,
    goalsFrom: "editor",
    askableMixed: true,
    kmId: "2fd1be28-b38d-4fa3-8b9d-b0976821912c",
    apiUrl: "https://api.rainbird.ai",
    useDraft: true,
    ...init,
  });
  return page;
}

const rowNames = (page: WebviewHarness): string[] =>
  page.$$(".combo-row").map((r) => (r.getAttribute("data-free") ? `free:${page.text(r)}` : String(r.getAttribute("data-name"))));
/** The active row, or null. Check it with assert.ok: a failing assert.equal on an element makes node inspect the whole happy-dom window. */
const activeRow = (page: WebviewHarness) => page.$(".combo-row.active");
/** The goal field, typed for what the tests use (the tests compile without the DOM lib). */
type Field = { value: string; focus(): void; blur(): void; getAttribute(name: string): string | null };
const goalInput = (page: WebviewHarness) => page.$(".goal") as unknown as Field;
const field = (page: WebviewHarness, selector: string) => page.$(selector) as unknown as Field;
/** The focused element. Compare it with assert.ok(a === b): a failing assert.equal on elements makes node inspect the whole happy-dom window. */
const focused = (page: WebviewHarness) => page.window.document.activeElement;
/** An element's text, whitespace collapsed (for elements found below a row). */
const textOf = (element: { textContent: string | null } | null): string => String(element?.textContent ?? "").replace(/\s+/g, " ").trim();

test("typing filters the goals by name, then by subject or object", async () => {
  const page = loadPanel();
  page.type(".goal", "total");
  assert.deepEqual(rowNames(page), ["total penalty", "has total income", "penalty subtotal one", "penalty subtotal two"]);
  page.type(".goal", "country");
  assert.deepEqual(rowNames(page), ["lives in", "national language"], "object Country, then subject Country, in file order");
  page.type(".goal", "amount");
  assert.deepEqual(rowNames(page), ["has total income"], "matched on its object");
  page.type(".goal", "language");
  assert.deepEqual(rowNames(page), ["national language", "speaks"], "a name match ranks above an object match");
  await page.close();
});

test("matches are bolded in the name and in subject → object", async () => {
  const page = loadPanel();
  page.type(".goal", "total");
  const names = page.$$(".combo-name").map((n) => n.innerHTML);
  assert.equal(names[1], "has <b>total</b> income");
  assert.equal(names[2], "penalty sub<b>total</b> one");
  page.type(".goal", "amount");
  assert.match(page.$(".combo-sub")!.innerHTML, /Person → <b>Amount<\/b>/);
  page.type(".goal", "<b>");
  assert.ok(!page.$(".combo-list b"), "typed markup is escaped, never rendered");
  assert.match(page.text(".combo-free"), /Use “<b>” as typed/);
  await page.close();
});

test("↓ and ↑ move the active row, Enter picks it, Escape closes the list", async () => {
  const page = loadPanel();
  goalInput(page).focus();
  page.type(".goal", "pen");
  assert.deepEqual(rowNames(page), ["penalty subtotal one", "penalty subtotal two", "total penalty"]);
  assert.equal(activeRow(page)?.getAttribute("data-name"), "penalty subtotal one", "the best match is the Enter default");
  page.key(".goal", "ArrowDown");
  page.key(".goal", "ArrowDown");
  page.key(".goal", "ArrowDown");
  assert.equal(activeRow(page)?.getAttribute("data-name"), "total penalty", "stops at the last row");
  page.key(".goal", "ArrowUp");
  assert.equal(activeRow(page)?.getAttribute("data-name"), "penalty subtotal two");
  page.key(".goal", "Enter");
  assert.equal(goalInput(page).value, "penalty subtotal two");
  assert.ok(!page.$(".combo-list"), "picking closes the list");
  assert.ok(focused(page) === page.$(".subject"), "and moves on to the subject");
  assert.equal(page.posted.filter((m) => m.type === "start").length, 0, "picking does not start the query");

  page.type(".goal", "pen");
  assert.ok(page.$(".combo-list"));
  page.key(".goal", "Escape");
  assert.ok(!page.$(".combo-list"), "Escape closes the list");
  assert.equal(goalInput(page).value, "pen", "and keeps the text");
  page.key(".goal", "ArrowDown");
  assert.ok(page.$(".combo-list"), "↓ opens it again");
  page.key(".goal", "Tab");
  assert.ok(!page.$(".combo-list"), "Tab closes it");
  await page.close();
});

test("an empty query lists every goal in two groups, with no active row until ↓", async () => {
  const page = loadPanel();
  assert.ok(!page.$(".combo-list"), "the list is closed until asked for");
  page.click(".goal");
  const heads = page.$$(".combo-head").map((h) => page.text(h));
  assert.deepEqual(heads, ["Inferred by rules (5)", "Other relationships (3)"]);
  assert.deepEqual(rowNames(page), [
    "has total income",
    "total penalty",
    "penalty subtotal one",
    "penalty subtotal two",
    "speaks",
    "lives in",
    "national language",
    "date of birth",
  ]);
  assert.ok(!activeRow(page), "no active row until ↓");
  page.key(".goal", "Enter");
  assert.equal(page.lastPosted("start"), undefined, "Enter with nothing typed and nothing active does nothing");
  page.click(".goal");
  page.key(".goal", "ArrowDown");
  assert.equal(activeRow(page)?.getAttribute("data-name"), "has total income");
  await page.close();
});

test("a long goal list is never cut off: every goal is listed, the box scrolls", async () => {
  const many = Array.from({ length: 150 }, (_, i) => ({
    name: `rel ${i + 1}`,
    subject: "A",
    object: "B",
    plural: false,
    askable: "all",
    rules: i >= 100 ? 1 : 0,
    facts: 0,
    objectType: "string",
  }));
  const page = loadPanel({ goals: many, askableMixed: false });
  assert.equal(goalInput(page).getAttribute("placeholder"), "Type to search 150 relationships…");
  page.click(".goal");
  assert.equal(page.$$(".combo-row").length, 150);
  assert.deepEqual(
    page.$$(".combo-head").map((h) => page.text(h)),
    ["Inferred by rules (50)", "Other relationships (100)"],
    "groups count over all goals, including those past the 100th"
  );
  page.type(".goal", "rel");
  assert.equal(page.$$(".combo-row").length, 150, "typed matches are not capped either");
  await page.close();
});

test("“Use … as typed” appears only when nothing matches, and Start then sends the text as typed", async () => {
  const page = loadPanel();
  page.type(".goal", "spe");
  assert.ok(!page.$(".combo-free"), "not offered while a goal matches");
  page.type(".goal", "zzz");
  assert.equal(page.text(".combo-empty"), "No relationship in the open map matches “zzz”.");
  assert.equal(page.text(".combo-free"), "Use “zzz” as typed");
  assert.ok(activeRow(page)?.classList.contains("combo-free"));
  page.key(".goal", "Enter");
  assert.equal(goalInput(page).value, "zzz");
  assert.ok(!page.$(".combo-list"));
  assert.equal(page.text(".goalMeta"), "“zzz” is not a relationship in the open map — Start query will send it exactly as typed.");
  page.click(".go");
  assert.equal(page.lastPosted("start")?.relationship, "zzz");
  await page.close();
});

test("acronym matches are offered but never the Enter default", async () => {
  const page = loadPanel();
  page.type(".goal", "hti");
  assert.deepEqual(rowNames(page), ["free:Use “hti” as typed", "has total income"]);
  assert.ok(activeRow(page)?.classList.contains("combo-free"), "the typed text, not the acronym row, is the default");
  assert.equal(page.$$(".combo-name")[0].innerHTML, "<b>h</b>as <b>t</b>otal <b>i</b>ncome", "the matched initials are bolded");
  page.key(".goal", "Enter");
  assert.equal(goalInput(page).value, "hti", "Enter keeps what was typed");

  page.type(".goal", "hti");
  page.key(".goal", "ArrowDown");
  assert.equal(activeRow(page)?.getAttribute("data-name"), "has total income");
  page.key(".goal", "Enter");
  assert.equal(goalInput(page).value, "has total income", "↓ then Enter picks the acronym match");
  await page.close();
});

test("a case mismatch shows the declared spelling, and Start query sends it", async () => {
  const page = loadPanel();
  page.type(".goal", "Speaks");
  assert.equal(page.text(".goalMeta"), "Did you mean “speaks”? Names are case-sensitive — Start query will use that spelling.");
  assert.ok(page.$(".goalMeta")!.classList.contains("warn"));
  assert.ok(page.$(".combo > .goalMeta") && page.$(".combo")!.lastElementChild === page.$("#goalList"), "the list opens below the hint, never over it");
  page.key(".goal", "Escape");
  assert.match(page.text(".goalMeta"), /Did you mean “speaks”\?/, "the hint stays with the list closed");
  page.click(".go");
  assert.equal(page.lastPosted("start")?.relationship, "speaks");
  assert.equal(goalInput(page).value, "speaks");
  await page.close();
});

test("a spacing-only difference names the declared spelling", async () => {
  const page = loadPanel();
  page.type(".goal", "lives  in");
  assert.equal(page.text(".goalMeta"), "Start query will use the declared spelling “lives in”.");
  page.click(".go");
  assert.equal(page.lastPosted("start")?.relationship, "lives in");
  await page.close();
});

test("Enter in the subject or object field starts the query once the goal is one of the map's", async () => {
  const page = loadPanel();
  page.type(".goal", "spe");
  page.type(".subject", "Fred");
  page.key(".subject", "Enter");
  assert.equal(page.lastPosted("start"), undefined, "a partial name does not start");
  page.type(".goal", "speaks");
  page.key(".subject", "Enter");
  const start = page.lastPosted("start");
  assert.ok(start, "a start message was posted");
  assert.equal(start.relationship, "speaks");
  assert.equal(start.subject, "Fred");
  assert.deepEqual(start.target, { kind: "draft" });
  page.key(".object", "Enter");
  assert.equal(page.posted.filter((m) => m.type === "start").length, 1, "a query that is starting is not started twice");
  await page.close();
});

test("Enter that confirms an input method's composition neither picks nor starts", async () => {
  const page = loadPanel();
  page.type(".goal", "pen");
  page.key(".goal", "Enter", { isComposing: true });
  assert.equal(goalInput(page).value, "pen");
  assert.ok(page.$(".combo-list"), "the list stays open");
  page.type(".goal", "speaks");
  page.key(".subject", "Enter", { isComposing: true });
  assert.equal(page.lastPosted("start"), undefined);
  await page.close();
});

test("Enter in the goal field starts the query when the list is closed and the goal is exact", async () => {
  const page = loadPanel();
  page.type(".goal", "speaks");
  page.key(".goal", "Escape");
  page.key(".goal", "Enter");
  assert.equal(page.lastPosted("start")?.relationship, "speaks");
  await page.close();
});

test("init.preselect fills the goal, says why, and leaves the subject next", async () => {
  const page = loadPanel({ preselect: "lives in", preselectFrom: "editor" });
  assert.equal(goalInput(page).value, "lives in");
  assert.equal(page.text(".goalMeta"), "Person → Country · no rules or facts in the open map — from the editor");
  assert.ok(focused(page) === page.$(".subject"), "the subject is next");
  assert.ok(!page.$(".combo-list"), "a prefill does not open the list");
  page.key(".goal", "Enter");
  assert.equal(page.lastPosted("start")?.relationship, "lives in");
  await page.close();

  const remembered = loadPanel({ preselect: "speaks", preselectFrom: "last" });
  assert.equal(remembered.text(".goalMeta"), "Person → Language · plural · 1 rule · 0 facts — last goal for this map");
  await remembered.close();
});

test("New query starts from the goal just run", async () => {
  const page = loadPanel();
  page.type(".goal", "speaks");
  page.click(".go");
  page.send({ type: "busy" });
  page.click("#newQuery");
  assert.equal(goalInput(page).value, "speaks");
  assert.match(page.text(".goalMeta"), /— last goal for this map$/);
  await page.close();
});

test("with no goal list the field stays a plain text input", async () => {
  const page = loadPanel({ goals: [], goalsFrom: "none", askableMixed: false });
  const input = goalInput(page);
  assert.equal(input.getAttribute("role"), null);
  assert.equal(input.getAttribute("aria-expanded"), null);
  assert.equal(input.getAttribute("placeholder"), "e.g. speaks");
  assert.equal(page.text("label[for=goalInput]"), "Goal relationship");
  assert.equal(page.$$(".hint")[0] && page.text(page.$$(".hint")[0]), "Type the relationship name exactly as the map declares it — names are case-sensitive.");
  page.type(".goal", "Speaks");
  page.click(".goal");
  page.key(".goal", "ArrowDown");
  assert.ok(!page.$(".combo-list") && !page.$("[role=listbox]"), "no list to open");
  page.key(".goal", "Enter");
  assert.equal(page.lastPosted("start")?.relationship, "Speaks", "sent as typed: there is nothing to correct it against");
  await page.close();
});

test("the label says where the goals came from", async () => {
  const editor = loadPanel();
  assert.match(editor.text("label[for=goalInput]"), /^Goal relationship \(from the open map\)$/);
  await editor.close();
  const platform = loadPanel({ goalsFrom: "platform" });
  assert.match(platform.text("label[for=goalInput]"), /^Goal relationship \(from the platform draft\)$/);
  platform.click(".goal");
  const livesIn = platform.$$(".combo-row").find((r) => r.getAttribute("data-name") === "lives in")!;
  assert.equal(textOf(livesIn.querySelector(".combo-count")), "no rules or facts in the platform draft");
  await platform.close();
});

test("rows show subject → object, plural, rule and fact counts, and tags", async () => {
  const page = loadPanel();
  page.click(".goal");
  const row = (name: string) => page.$$(".combo-row").find((r) => r.getAttribute("data-name") === name)!;
  const sub = (name: string) => [textOf(row(name).querySelector(".combo-link")), textOf(row(name).querySelector(".combo-count"))];
  const tags = (name: string) => [...row(name).querySelectorAll(".combo-tag")].map((t) => textOf(t));
  assert.deepEqual(sub("speaks"), ["Person → Language · plural", "1 rule · 0 facts"]);
  assert.deepEqual(sub("has total income"), ["Person → Amount", "2 rules · 0 facts"]);
  assert.deepEqual(sub("national language"), ["Country → Language", "0 rules · 2 facts"]);
  assert.deepEqual(sub("lives in"), ["Person → Country", "no rules or facts in the open map"]);
  assert.equal(page.text(row("speaks")), "speaks Person → Language · plural 1 rule · 0 facts", "the option reads as one line");
  assert.equal(
    page.text(row("date of birth")),
    "date of birth the engine cannot answer it without injected facts Person → Birth date no rules or facts in the open map"
  );
  assert.deepEqual(tags("lives in"), [], "askable with nothing in the map: a neutral note, no warning");
  assert.deepEqual(tags("date of birth"), ["the engine cannot answer it without injected facts"]);
  assert.ok(row("date of birth").querySelector(".combo-tag.warn"));
  assert.deepEqual(tags("national language"), ["not askable"], "askable=none in a map that mixes askable values");
  assert.deepEqual(tags("speaks"), []);
  await page.close();

  const headless = loadPanel({ askableMixed: false });
  headless.click(".goal");
  assert.equal(headless.$$(".combo-tag").filter((t) => headless.text(t) === "not askable").length, 0, "no tag when every goal is askable=none");
  await headless.close();
});

test("ARIA: a combobox whose listbox, aria-controls and aria-activedescendant exist only while it is open", async () => {
  const page = loadPanel();
  const input = goalInput(page);
  assert.equal(input.getAttribute("role"), "combobox");
  assert.equal(input.getAttribute("aria-expanded"), "false");
  assert.equal(input.getAttribute("aria-controls"), null);
  assert.equal(input.getAttribute("aria-activedescendant"), null);
  page.type(".goal", "pen");
  const list = page.$("#goalList")!;
  assert.equal(list.getAttribute("role"), "listbox");
  assert.equal(input.getAttribute("aria-expanded"), "true");
  assert.equal(input.getAttribute("aria-controls"), "goalList");
  assert.ok(page.$$(".combo-row").every((r) => r.getAttribute("role") === "option"));
  assert.equal(input.getAttribute("aria-activedescendant"), activeRow(page)!.id);
  assert.equal(activeRow(page)!.getAttribute("aria-selected"), "true");
  page.key(".goal", "ArrowDown");
  assert.equal(input.getAttribute("aria-activedescendant"), activeRow(page)!.id);
  assert.equal(page.$$("[aria-selected=true]").length, 1);
  page.key(".goal", "Escape");
  assert.ok(!page.$("#goalList"));
  assert.equal(input.getAttribute("aria-expanded"), "false");
  assert.equal(input.getAttribute("aria-controls"), null);
  assert.equal(input.getAttribute("aria-activedescendant"), null);
  await page.close();
});

test("rows are picked on mousedown without taking focus; other presses in the list keep it open", async () => {
  const page = loadPanel();
  const window = page.window;
  const press = (target: { dispatchEvent(event: unknown): boolean }) => {
    const event = new window.MouseEvent("mousedown", { bubbles: true, cancelable: true });
    target.dispatchEvent(event);
    return event;
  };
  const release = () => window.document.dispatchEvent(new window.MouseEvent("mouseup", { bubbles: true }));

  goalInput(page).focus();
  page.click(".goal");
  assert.equal(press(page.$(".combo-head")!).defaultPrevented, false, "a heading or the scrollbar keeps its default (scrollbar drags work)");
  field(page, "#goalList").focus(); // the browser focuses the (focusable) list itself
  assert.ok(page.$(".combo-list"), "focus moving into the list keeps it open");
  release();
  assert.ok(focused(page) === page.$(".goal"), "the field gets its focus back");

  press(page.$(".combo-head")!);
  goalInput(page).blur(); // or the press leaves focus on nothing
  assert.ok(page.$(".combo-list"), "the list survives the field losing focus while the button is down in it");
  release();
  assert.ok(focused(page) === page.$(".goal"), "the release gives the field its focus back");

  page.type(".goal", "pen");
  const third = page.$$(".combo-row")[2];
  assert.equal(press(third.querySelector(".combo-name")!).defaultPrevented, true, "a row press keeps the focus in the field");
  assert.equal(goalInput(page).value, "total penalty");
  assert.ok(!page.$(".combo-list"));
});

test("a press in the list that ends with focus on another control closes the list and leaves focus there", async () => {
  const page = loadPanel();
  const window = page.window;
  goalInput(page).focus();
  page.click(".goal");
  page.$(".combo-head")!.dispatchEvent(new window.MouseEvent("mousedown", { bubbles: true, cancelable: true }));
  field(page, ".object").focus();
  window.document.dispatchEvent(new window.MouseEvent("mouseup", { bubbles: true }));
  assert.ok(!page.$(".combo-list"));
  assert.ok(focused(page) === page.$(".object"), "focus is not pulled back to the goal field");
});

test("the list closes when focus leaves the field, and the line under it points to the matches", async () => {
  const page = loadPanel();
  goalInput(page).focus();
  page.type(".goal", "pen");
  assert.ok(page.$(".combo-list"));
  field(page, ".object").focus();
  assert.ok(!page.$(".combo-list"));
  assert.equal(page.text(".goalMeta"), "“pen” is not a relationship in the open map — choose one of the 3 that match from the list.");
  goalInput(page).focus();
  page.type(".goal", "amount");
  field(page, ".object").focus();
  assert.equal(page.text(".goalMeta"), "“amount” is not a relationship in the open map — choose the one that matches from the list.");
  goalInput(page).focus();
  page.type(".goal", "hti");
  field(page, ".object").focus();
  assert.equal(
    page.text(".goalMeta"),
    "“hti” is not a relationship in the open map — Start query will send it exactly as typed.",
    "an acronym match does not count: the text is meant as typed"
  );
  await page.close();
});

test("the panel losing focus ends a press in the list that was released outside it", async () => {
  const page = loadPanel();
  const window = page.window;
  goalInput(page).focus();
  page.click(".goal");
  page.$(".combo-head")!.dispatchEvent(new window.MouseEvent("mousedown", { bubbles: true, cancelable: true }));
  goalInput(page).blur();
  assert.ok(page.$(".combo-list"), "held open while the button is down");
  window.dispatchEvent(new window.Event("blur")); // the mouseup happened outside the webview
  assert.ok(!page.$(".combo-list"), "the list closes");
  window.document.dispatchEvent(new window.MouseEvent("mouseup", { bubbles: true }));
  assert.ok(!page.$(".combo-list"), "a late mouseup changes nothing");

  goalInput(page).focus(); // a real click focuses the field
  page.click(".goal");
  assert.ok(page.$(".combo-list"));
  field(page, ".object").focus();
  assert.ok(!page.$(".combo-list"), "the press no longer holds the list open");
  await page.close();
});

test("a new query shows its list from the top", async () => {
  const page = loadPanel();
  page.click(".goal");
  const list = page.$("#goalList") as unknown as { scrollTop: number };
  list.scrollTop = 120;
  page.type(".goal", "pen");
  assert.equal((page.$("#goalList") as unknown as { scrollTop: number }).scrollTop, 0);
  await page.close();
});

test("Start query asks once before sending a name that only partly matches the map's relationships", async () => {
  /** A real click on Start query moves focus to the button first, which closes the list. */
  const clickStart = (page: WebviewHarness) => {
    field(page, ".go").focus();
    page.click(".go");
  };
  const page = loadPanel();
  goalInput(page).focus();
  page.type(".goal", "pen");
  clickStart(page);
  assert.equal(page.lastPosted("start"), undefined, "the first click sends nothing");
  assert.equal(
    page.text(".startErr"),
    "“pen” is not one of the map’s relationships — pick one from the list, or click Start query again to send it as typed."
  );
  assert.ok(focused(page) === page.$(".goal"), "the goal field is next");
  clickStart(page);
  assert.equal(page.lastPosted("start")?.relationship, "pen", "the second click sends it as typed");
  await page.close();

  const changed = loadPanel();
  goalInput(changed).focus();
  changed.type(".goal", "pen");
  clickStart(changed);
  assert.match(changed.text(".startErr"), /^“pen” is not one of/);
  changed.type(".goal", "pena");
  assert.equal(changed.text(".startErr"), "", "typing clears the question");
  clickStart(changed);
  assert.equal(changed.lastPosted("start"), undefined, "a different name is asked about again");
  assert.match(changed.text(".startErr"), /^“pena” is not one of/);
  changed.key(".goal", "ArrowDown");
  changed.key(".goal", "Enter");
  assert.equal(goalInput(changed).value, "penalty subtotal one");
  assert.equal(changed.text(".startErr"), "", "picking a row clears it too");
  clickStart(changed);
  assert.equal(changed.lastPosted("start")?.relationship, "penalty subtotal one");
  await changed.close();

  const acronym = loadPanel();
  goalInput(acronym).focus();
  acronym.type(".goal", "hti");
  clickStart(acronym);
  assert.equal(acronym.lastPosted("start")?.relationship, "hti", "only acronyms match: “Use … as typed” applies, no question");
  await acronym.close();
});

test("after Start query writes the declared spelling, the line under the field describes that goal", async () => {
  const page = loadPanel();
  page.type(".goal", "Speaks");
  assert.match(page.text(".goalMeta"), /^Did you mean “speaks”\?/);
  page.click(".go");
  assert.equal(page.lastPosted("start")?.relationship, "speaks");
  page.send({ type: "startError", message: "The facts could not be read." });
  assert.equal(goalInput(page).value, "speaks");
  assert.equal(page.text(".goalMeta"), "Person → Language · plural · 1 rule · 0 facts", "no stale case hint");
  assert.equal(page.text(".startErr"), "The facts could not be read.");
  page.type(".goal", "spe");
  assert.equal(page.text(".startErr"), "The facts could not be read.", "only the question about a partial name is cleared by typing");
  await page.close();
});

test("New query tells the extension, so ▶ does not ask about a query nobody sees", async () => {
  const page = loadPanel();
  page.type(".goal", "speaks");
  page.click(".go");
  page.send({ type: "busy" });
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
  page.click("#newQuery");
  assert.deepEqual(page.lastPosted("newQuery"), { type: "newQuery" });
  assert.match(page.text(), /What should Rainbird work out\?/, "a fresh setup card");
  assert.doesNotMatch(page.text(), /Does Fred speak French\?/);
  await page.close();
});

test("the Change… link beside the map badge posts changeKm", async () => {
  const page = track(loadWebview(render("test-nonce")));
  assert.equal(page.text("#changeKm"), "Choose map…", "before any map is known");
  page.send({ type: "init", goals: GOALS, goalsFrom: "editor", kmId: "km-1", apiUrl: "https://api.rainbird.ai", useDraft: true, fileName: "hello-world.rbl" });
  assert.equal(page.text("#changeKm"), "Change…");
  assert.equal(page.$("#changeKm")!.getAttribute("title"), "Bind hello-world.rbl to a different Knowledge Map ID");
  assert.ok(page.$("#km")!.nextElementSibling === page.$("#changeKm"), "it sits right after the badge");
  page.click("#changeKm");
  assert.deepEqual(page.lastPosted("changeKm"), { type: "changeKm" });
  page.send({ type: "init", goals: GOALS, goalsFrom: "platform", kmId: "km-2", apiUrl: "https://api.rainbird.ai", useDraft: false });
  assert.equal(page.$("#changeKm")!.getAttribute("title"), "Query a different map by its Knowledge Map ID");
  assert.match(page.text("#km"), /^live · km-2$/);
  await page.close();
});

test("the shared goals keep objectType, and setup() stays a top-level function", async () => {
  const page = loadPanel();
  const probe = (page.window as unknown as { __setupProbe: { goals(): Array<Record<string, unknown>>; setupType(): string } }).__setupProbe;
  assert.deepEqual(
    probe.goals().map((g) => [g.name, g.objectType]),
    GOALS.map((g) => [g.name, g.objectType])
  );
  page.click("#newQuery");
  assert.equal(probe.goals()[0].objectType, "number", "a new setup card does not reshape them");
  assert.equal(probe.setupType(), "function");
  await page.close();
});

test("startError puts the card back to Start query", async () => {
  const page = loadPanel();
  page.type(".goal", "speaks");
  page.click(".go");
  assert.equal(page.text(".go"), "Starting…");
  page.send({ type: "startError", message: "No map chosen yet." });
  assert.equal(page.text(".startErr"), "No map chosen yet.");
  assert.equal(page.text(".go"), "Start query");
  await page.close();
});

// ── Host helpers (VS Code-free) ──

const MAP = `<?xml version="1.0" encoding="utf-8"?>
<rbl:kb xmlns:rbl="http://rbl.io/schema/RBLang">
  <concept name="Person" type="string"/>
  <concept name="Language" type="string"/>
  <concept name="Income" type="number"/>
  <concept name="Birthday" type="date"/>
  <concept name="Flag" type="boolean"/>
  <concept name="Verdict" type="truth"/>
  <rel name="speaks" subject="Person" object="Language" plural="true" askable="all"/>
  <rel name="earns" subject="Person" object="Income" askable="none"/>
  <rel name="born on" subject="Person" object="Birthday"/>
  <rel name="is flagged" subject="Person" object="Flag"/>
  <rel name="is eligible" subject="Person" object="Verdict"/>
  <rel name="has pet" subject="Person" object="Animal"/>
  <relinst type="earns" subject="Fred" object="100" cf="100"/>
</rbl:kb>`;

test("panelGoals: the goal list with each object concept's type", () => {
  const list = panelGoals(MAP);
  assert.deepEqual(
    list.goals.map((g) => [g.name, g.objectType]),
    [
      ["speaks", "string"],
      ["earns", "number"],
      ["born on", "date"],
      ["is flagged", "truth"],
      ["is eligible", "truth"],
      ["has pet", "string"],
    ]
  );
  const earns = list.goals.find((g) => g.name === "earns")!;
  assert.deepEqual(
    { askable: earns.askable, rules: earns.rules, facts: earns.facts, plural: earns.plural },
    { askable: "none", rules: 0, facts: 1, plural: false }
  );
  assert.equal(list.askableMixed, true);
  assert.deepEqual(panelGoals(""), { goals: [], askableMixed: false });
});

test("preselectGoal: the cursor wins when the map declares it, else the last goal", () => {
  const goals = [
    { name: "speaks", subject: "Person", object: "Language" },
    { name: "lives in", subject: "Person", object: "Country" },
  ];
  assert.deepEqual(preselectGoal(goals, "lives in", "speaks"), { goal: "lives in", from: "editor" });
  assert.deepEqual(preselectGoal(goals, "Lives In", undefined), { goal: "lives in", from: "editor" }, "in the declared spelling");
  assert.deepEqual(preselectGoal(goals, "undeclared", "speaks"), { goal: "speaks", from: "last" });
  assert.deepEqual(preselectGoal(goals, undefined, "speaks"), { goal: "speaks", from: "last" });
  assert.equal(preselectGoal(goals, undefined, "renamed since"), undefined);
  assert.equal(preselectGoal(goals, undefined, undefined), undefined);
  assert.deepEqual(preselectGoal([], "speaks", undefined), { goal: "speaks", from: "editor" }, "no list to check it against");
  assert.equal(preselectGoal([], undefined, "speaks"), undefined);
});

test("withLastGoal / lastGoalFor: per map, most recent first, at most 100 maps", () => {
  let stored: Record<string, string> = withLastGoal(undefined, "AAAAAAAA-0000-0000-0000-000000000001", "speaks");
  assert.deepEqual(stored, { "aaaaaaaa-0000-0000-0000-000000000001": "speaks" }, "kmIDs are normalised");
  stored = withLastGoal(stored, "bbbbbbbb-0000-0000-0000-000000000002", "lives in");
  stored = withLastGoal(stored, "aaaaaaaa-0000-0000-0000-000000000001", "national language");
  assert.deepEqual(Object.entries(stored), [
    ["aaaaaaaa-0000-0000-0000-000000000001", "national language"],
    ["bbbbbbbb-0000-0000-0000-000000000002", "lives in"],
  ]);
  const goals = [{ name: "national language" }, { name: "speaks" }];
  assert.equal(lastGoalFor(stored, "AAAAAAAA-0000-0000-0000-000000000001", goals), "national language");
  assert.equal(lastGoalFor(stored, "bbbbbbbb-0000-0000-0000-000000000002", goals), undefined, "a goal the map no longer declares");
  assert.equal(lastGoalFor(stored, "cccccccc-0000-0000-0000-000000000003", goals), undefined);
  assert.equal(lastGoalFor("corrupt", "aaaaaaaa-0000-0000-0000-000000000001", goals), undefined);

  let many: Record<string, string> = {};
  for (let i = 0; i < 105; i++) many = withLastGoal(many, `${String(i).padStart(8, "0")}-0000-0000-0000-00000000000a`, `goal ${i}`);
  const keys = Object.keys(many);
  assert.equal(keys.length, LAST_GOALS_CAP);
  assert.equal(many[keys[0]], "goal 104", "the most recent first");
  assert.equal(many[keys[keys.length - 1]], "goal 5", "the oldest dropped");
});

test("unknownGoalNote: push or bind only when the panel queries a file, else Change…", () => {
  const km = "2fd1be28-b38d-4fa3-8b9d-b0976821912c";
  assert.equal(
    unknownGoalNote({ kmId: km, relationship: "Speaks", goalsFrom: "editor", file: true, target: { kind: "draft" } }),
    `The map (${km}) has no relationship named exactly "Speaks" — names are case-sensitive. ` +
      "The goal list comes from your open .rbl file; check the map name in the header above. " +
      "If it's a different map, push the open file first (cloud icon), or point the file at the right map: " +
      "click “Change…” beside the map in the header, or run “Rainbird: Bind Open File to a Knowledge Map ID…”."
  );
  assert.equal(
    unknownGoalNote({ kmId: km, relationship: "speaks", goalsFrom: "platform", file: false, target: { kind: "draft" } }),
    `The map (${km}) has no relationship named exactly "speaks" — names are case-sensitive. ` +
      "Check the map name in the header above. " +
      "If it's a different map, click “Change…” beside the map in the header to query another Knowledge Map ID.",
    "a map chosen by ID (or a read-only platform document): nothing to push or bind"
  );
  assert.match(
    unknownGoalNote({ kmId: km, relationship: "speaks", goalsFrom: "editor", file: true, target: { kind: "live" } }),
    /case-sensitive\. This query ran against the live version, which may not have every relationship the goal list shows\. The goal list comes from/
  );
  assert.match(
    unknownGoalNote({ kmId: km, relationship: "speaks", goalsFrom: "platform", file: false, target: { kind: "version", version: 3 } }),
    /This query ran against version 3, which may not/
  );
  assert.doesNotMatch(
    unknownGoalNote({ kmId: km, relationship: "speaks", goalsFrom: "none", file: false, target: { kind: "live" } }),
    /goal list/,
    "no goal list to compare with"
  );
});

test("noMapNote: what the panel still queries, and which file “Choose map…” / “Change…” asks about", () => {
  assert.equal(noMapNote({}), "No map chosen. Click “Choose map…” at the top, or open the map's .rbl file and press ▶ in its title bar.");
  assert.equal(noMapNote({ file: "scratch.rbl", retry: true }), "No map chosen for scratch.rbl. Click “Choose map…” at the top to pick one.");
  assert.equal(
    noMapNote({ current: "km-1", file: "scratch.rbl", retry: true }),
    "No map chosen for scratch.rbl, so the panel still queries km-1. Click “Change…” at the top to pick one for it."
  );
  assert.equal(
    noMapNote({ current: "km-1", file: "scratch.rbl", retry: false }),
    "No map chosen, so the panel still queries km-1. Click “Change…” at the top to pick another.",
    "Change… binds the panel's own file instead"
  );
  assert.equal(noMapNote({ current: "km-1" }), "No map chosen, so the panel still queries km-1. Click “Change…” at the top to pick another.");
});
