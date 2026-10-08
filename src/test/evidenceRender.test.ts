/**
 * The Studio-style evidence renderer: fact cards, rule conditions in the order
 * the engine reports them, list functions, impact bars against the maximum
 * possible impact, unmet and zero-salience conditions, inputs used, notes,
 * escaping, the shared stylesheet and colours, the webview script (driven in
 * happy-dom through src/test/webviewHarness.ts) and the text outline.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { ExpandedEvidence, ExpandedNode, expandEvidence } from "../evidenceModel";
import { EVIDENCE_CSS, EVIDENCE_SCRIPT, SOURCE_STYLE, describeEvidence, renderEvidenceHtml, renderEvidencePage } from "../evidenceRender";
import { loadWebview } from "./webviewHarness";
import {
  CLAIM,
  CLAIM_CALL,
  CLAIM_ROOT_ID,
  CYCLE,
  CYCLE_A_ID,
  DATES,
  DATES_ROOT_ID,
  EMPTY_LIST,
  EMPTY_LIST_ROOT_ID,
  HELLO_WORLD,
  HELLO_WORLD_KM_ID,
  HELLO_WORLD_ROOT_ID,
  INCOME,
  INCOME_CALL,
  INCOME_ROOT_ID,
  INCOME_TEXT,
  LOAN,
  LOAN_ROOT_ID,
  NodeMap,
  REPEAT,
  REPEAT_ROOT_ID,
  SKIPPED,
  SKIPPED_ROOT_ID,
  fakeFetch,
} from "./fixtures/evidenceFixtures";

const expand = (nodes: NodeMap, root: string, opts?: Parameters<typeof expandEvidence>[2]) => expandEvidence(fakeFetch(nodes), root, opts);
const count = (html: string, needle: string | RegExp) => (typeof needle === "string" ? html.split(needle).length - 1 : (html.match(new RegExp(needle, "g")) ?? []).length);
const page = (body: string, scripts = `const vscode = acquireVsCodeApi();${EVIDENCE_SCRIPT}`) =>
  `<!DOCTYPE html><html><head><style>${EVIDENCE_CSS}</style></head><body><div id="host">${body}</div><script>${scripts}</script></body></html>`;

describe("renderEvidenceHtml", () => {
  test("the real HelloWorld tree: Studio badges, impacts against their maxima, inputs used", async () => {
    const html = renderEvidenceHtml(await expand(HELLO_WORLD, HELLO_WORLD_ROOT_ID));
    assert.match(html, /<span class="evt-badge evt-k-injection" style="background:#8ce99a;color:#1b1b1b"[^>]*>injected<\/span>/);
    assert.match(html, /<span class="evt-badge evt-k-knowledgemap" style="background:#f76707;color:#1b1b1b"[^>]*>knowledge map<\/span>/);
    assert.ok(!html.includes(">km<"), "the API's km is shown as knowledge map");
    // 33.75 and 37.5 against a grey maximum of 37.5 each, on a 0-100 scale.
    assert.equal(count(html, '<span class="evt-bar-max" style="width:37.5%">'), 2);
    assert.equal(count(html, '<span class="evt-bar-val" style="width:33.75%">'), 1);
    assert.equal(count(html, '<span class="evt-bar-val" style="width:37.5%">'), 1);
    assert.ok(html.includes('title="Impact 33.75% of a possible 37.5% (weight 100)"'));
    assert.ok(html.includes('<span class="evt-pct">33.75%</span>'));
    assert.ok(html.includes("Inputs used by this result (2)"));
    assert.ok(html.includes("1 injected · 1 from the knowledge map"));
    assert.ok(html.includes("certainty cap 75%"));
    assert.ok(html.includes("Conditions, in the order the engine reports them"));
  });

  test("conditions keep the engine's order; a non-rule support is folded into its row, not nested", async () => {
    const html = renderEvidenceHtml(await expand(HELLO_WORLD, HELLO_WORLD_ROOT_ID));
    assert.ok(html.indexOf("lives in") < html.indexOf("national language"));
    assert.equal(count(html, 'class="evt-card'), 1, "only the root is a card");
    const row = html.slice(html.indexOf('<li class="evt-cond'), html.indexOf("</li>"));
    assert.ok(row.includes("<b>Tom</b>") && row.includes(">injected<") && row.includes(">90%<"), "triple, source badge and certainty on one row");
  });

  test("a list function shows the call, its result, the number of facts and one line per fact with its source", async () => {
    const html = renderEvidenceHtml(await expand(INCOME, INCOME_ROOT_ID));
    // The expression is just the call: one row with the call as evaluated, the rule's own text as its tooltip.
    assert.ok(
      html.includes(
        `<code title="In the rule: sumObjects(%S, &#39;has income&#39;, *)">sumObjects( &#39;Tom&#39;, &#39;has income&#39;, *)</code> = <b>4500</b> <span class="evt-count">(3 facts)</span>`
      )
    );
    assert.equal(count(html, `sumObjects(`), 2, "the call once, plus its tooltip");
    assert.ok(!html.includes(`<code>${INCOME_TEXT.replace(/'/g, "&#39;")}</code>`), "the rule text is not a second row");
    const list = html.slice(html.indexOf('<ul class="evt-fn-facts">'), html.indexOf("</ul>"));
    const lines = list.split("<li>").slice(1);
    assert.equal(lines.length, 3);
    assert.ok(lines[0].includes(">injected<") && lines[0].includes("<b>1500</b>") && lines[0].includes(">100%<"));
    assert.ok(lines[1].includes(">answer<") && lines[1].includes("<b>2000</b>") && lines[1].includes(">90%<"));
    assert.ok(lines[2].includes(">knowledge map<") && lines[2].includes("<b>1000</b>"));
    assert.ok(html.includes(">list function<"));
    assert.ok(html.includes("Inputs used by this result (3)"));
    assert.ok(html.includes("1 answered · 1 injected · 1 from the knowledge map"));
  });

  test("a rule support nests a collapsed card; collapseDepth opens it", async () => {
    const tree = await expand(LOAN, LOAN_ROOT_ID);
    const closed = renderEvidenceHtml(tree, { idPrefix: "evt-" });
    assert.match(closed, /<details class="evt-card evt-rulecard evt-root" open id="evt-f0"/);
    assert.match(closed, /<details class="evt-card evt-rulecard" id="evt-f1" data-fact="WA:RF:7a1c0de5income0total"/);
    assert.ok(closed.includes("How this was inferred (1 condition)"));
    const open = renderEvidenceHtml(tree, { collapseDepth: 2, idPrefix: "evt-" });
    assert.match(open, /<details class="evt-card evt-rulecard" open id="evt-f1"/);
    // The incomes behind the nested rule are in the tree and in Inputs used.
    assert.ok(open.includes("<b>2000</b>"));
    assert.ok(open.includes("Inputs used by this result (4)"));
  });

  test("unmet optional conditions are struck through at 0%; zero-weight ones sit under Zero salience conditions", async () => {
    const html = renderEvidenceHtml(await expand(LOAN, LOAN_ROOT_ID));
    const unmet = html.split('<li class="evt-cond evt-rel-cond evt-unmet">')[1].split("</li>")[0];
    assert.ok(unmet.includes("has guarantor") && unmet.includes("<b>Ann</b>"));
    assert.ok(unmet.includes(">not met<"), "the synthesis placeholder's badge");
    assert.ok(unmet.includes('<span class="evt-pct">0%</span>'), "0% impact stays visible");
    assert.ok(unmet.includes('<span class="evt-bar-max" style="width:11.43%">'), "against its maximum possible impact: 80 × 50 ÷ 350");
    assert.ok(!html.includes("Could not load") && !html.includes("could not be loaded"), "WA:XX is not fetched, so nothing failed");
    assert.match(EVIDENCE_CSS, /\.evt \.evt-unmet > \.evt-row \.evt-what \{ text-decoration: line-through;/);
    assert.ok(html.includes('<li class="evt-cond evt-expr-cond evt-unmet">'), "an expression that was false");
    const zero = html.split('<details class="evt-zero" open><summary>Zero salience conditions (1)</summary>')[1];
    assert.ok(zero, "zero-weight block");
    assert.ok(zero.split("</details>")[0].includes("lives in"));
    assert.ok(zero.includes('<span class="evt-n">4</span>'), "numbered by its place in the rule");
    const main = html.split('<ol class="evt-conds">')[1].split('<details class="evt-zero"')[0];
    assert.ok(!main.includes(">lives in<"), "not repeated in the main list");
  });

  test("expressions show their text and a tick or cross, never the variable they were stored in", async () => {
    const claim = renderEvidenceHtml(await expand(CLAIM, CLAIM_ROOT_ID));
    assert.ok(claim.includes('<code>%RELS is less than 10</code> <span class="evt-met" title="The expression was true">✓</span>'));
    assert.ok(!claim.includes("→"), "no arrow to a value");
    const relsRow = claim.split("<code>%RELS is less than 10</code>")[1].split("</li>")[0];
    assert.ok(!relsRow.includes("%O"), "the spec row's value '%O' is not shown");
    assert.ok(!/(→|=)\s*(<b>)?%O\b/.test(claim));
    assert.ok(!claim.includes("%RELS</"), "the list function's value '%RELS' is not shown as its result");
    assert.ok(claim.includes(`(3 facts)`) && claim.includes("<b>3</b>"));
    assert.ok(claim.includes(CLAIM_CALL.replace(/'/g, "&#39;")));
    const loan = renderEvidenceHtml(await expand(LOAN, LOAN_ROOT_ID));
    // The variables filled in, as Studio shows them, go in the tooltip.
    assert.ok(
      loan.includes('<code title="With values: 4500 &gt; 10000">%TOTAL &gt; 10000</code> <span class="evt-met evt-false" title="The expression was false">✗</span>')
    );
    // No certainty cell on expression rows; the maximum is exact (expressions count in the total weight).
    const exprRow = loan.split('<li class="evt-cond evt-expr-cond">')[1].split("</li>")[0];
    assert.ok(!exprRow.includes('class="evt-cf"'));
    assert.ok(exprRow.includes('title="Impact 22.86% of a possible 22.86% (weight 100)"'));
    assert.ok(!loan.includes("approximate"));
  });

  test("dates arrive as epoch milliseconds and are shown as YYYY-MM-DD", () => {
    const tree = {
      factID: "WA:IF:date",
      source: "injection",
      fact: { subject: { value: "Tom" }, relationship: { type: "born on" }, object: { value: 370742400000, dataType: "date" }, certainty: 100 },
    } as ExpandedNode;
    const html = renderEvidenceHtml(tree);
    assert.ok(html.includes("<b>1981-10-01</b>"));
    assert.ok(!html.includes("370742400000"));
  });

  test("evidence text is shown with the rule's bindings filled in", async () => {
    const html = renderEvidenceHtml(await expand(LOAN, LOAN_ROOT_ID));
    assert.ok(html.includes('<div class="evt-alt">Tom earns 4500 a year</div>'), "a typed variable is unwrapped");
    assert.ok(html.includes('<span class="evt-var">%TOTAL = 4500</span>'));
    assert.ok(html.includes('<div class="evt-alt evt-rule-alt">Tom qualifies on income</div>'), "the rule's own evidence text");
  });

  test("repeat, cyclic, not-loaded and failed supports get short notes; meta adds footnotes", async () => {
    const repeat = renderEvidenceHtml(await expand(REPEAT, REPEAT_ROOT_ID), { idPrefix: "evt-" });
    assert.equal(count(repeat, "How this was inferred"), 1, "the shared rule is drawn once");
    assert.ok(repeat.includes('Shown in full elsewhere in this tree. <button type="button" class="evt-link" data-evt-goto="evt-f1">Go to it</button>'));

    const cycle = renderEvidenceHtml(await expand(CYCLE, CYCLE_A_ID), { collapseDepth: 9, idPrefix: "evt-" });
    assert.ok(cycle.includes('Depends on a fact further up this branch, so it is not expanded again. <button type="button" class="evt-link" data-evt-goto="evt-f0">'));

    const cut = renderEvidenceHtml(await expand(LOAN, LOAN_ROOT_ID, { maxNodes: 2 }), { toolbar: { studio: true } });
    assert.ok(cut.includes("Not loaded: the evidence tree reached its size limit."));
    assert.ok(cut.includes('This tree was cut short after 2 facts to keep it fast; rows marked "Not loaded" were not fetched. Open in Studio shows the complete tree.'.replace(/"/g, "&quot;")));

    const failed = renderEvidenceHtml(await expandEvidence(fakeFetch(HELLO_WORLD, { fail: { [HELLO_WORLD_KM_ID]: new Error("Rainbird API 500 on /analysis/evidence: boom") } }), HELLO_WORLD_ROOT_ID));
    assert.ok(failed.includes('<div class="evt-note evt-warn">Could not load this fact: Rainbird API 500 on /analysis/evidence: boom</div>'));
    assert.ok(failed.includes("1 fact could not be loaded; the affected rows say why."));
    assert.ok(failed.includes("Inputs used by this result (2)"), "the unloaded fact is still listed, as not loaded");
    assert.ok(failed.includes("1 injected · 1 not loaded"));
  });

  test("every dynamic string is escaped", async () => {
    const evil = `<img src=x onerror="alert(1)">`;
    const tree = {
      factID: `WA:RF:"><script>alert(1)</script>`,
      source: "rule",
      fact: { subject: { value: evil }, relationship: { type: evil }, object: { value: evil }, certainty: 50 },
      rule: {
        bindings: { [evil]: evil, S: evil },
        alt: `{{%S}} ${evil}`,
        conditions: [
          { subject: evil, relationship: evil, object: evil, certainty: 10, impact: 5, salience: 100, factID: `WA:X:${evil}`, alt: `{{%S}} ${evil}`, fetchError: evil },
          {
            expression: { text: evil, value: "%O", functions: { [evil]: { facts: [{ subject: evil, relationship: evil, object: evil, certainty: 1 }], result: { type: evil, value: evil } } } },
            wasMet: true,
          },
          { subject: evil, relationship: evil, object: evil, certainty: 10, impact: 5, salience: 0, factID: evil, truncated: true },
        ],
      },
      meta: { nodes: 1, truncated: true, errors: 1 },
    } as unknown as ExpandedEvidence;
    const html = renderEvidenceHtml(tree, { toolbar: { studio: true, copyLink: true, openPanel: true }, idPrefix: `"><b>` });
    assert.ok(!html.includes("<img"));
    assert.ok(!html.includes("<script"));
    assert.ok(!html.includes(`onerror="`));
    const h = loadWebview(page(html, ""));
    assert.equal(h.$$("img").length, 0);
    assert.equal(h.$$("script").length, 0);
    assert.ok(h.text().includes(evil));
    assert.equal(h.$(".evt")?.getAttribute("data-fact"), `WA:RF:"><script>alert(1)</script>`);
    await h.close();
  });

  test("never throws on partial or odd payloads", () => {
    const odd = {
      factID: "WA:RF:odd",
      source: "rule",
      rule: { conditions: [null, {}, { expression: {} }, { expression: { functions: { f: null, g: { facts: [null, {}] } } } }, { factID: "WA:AF:x" }] },
    } as unknown as ExpandedNode;
    for (const tree of [undefined, null, {} as ExpandedNode, { factID: "x" } as ExpandedNode, odd]) {
      assert.doesNotThrow(() => renderEvidenceHtml(tree));
      assert.doesNotThrow(() => describeEvidence(tree));
    }
    assert.ok(renderEvidenceHtml(undefined).includes("No evidence to show."));

    // A hand-built tree whose objects loop must not recurse forever.
    const a = { factID: "WA:RF:a", source: "rule", fact: { subject: { value: "A" }, relationship: { type: "r" }, object: { value: "B" }, certainty: 50 }, rule: { conditions: [] as unknown[] } };
    const b = { factID: "WA:RF:b", source: "rule", fact: { subject: { value: "B" }, relationship: { type: "r" }, object: { value: "A" }, certainty: 50 }, rule: { conditions: [{ subject: "A", relationship: "r", object: "B", evidence: a }] } };
    a.rule.conditions.push({ subject: "B", relationship: "r", object: "A", evidence: b });
    assert.ok(renderEvidenceHtml(a as unknown as ExpandedNode, { collapseDepth: 9 }).includes("not expanded again"));
    assert.ok(describeEvidence(a as unknown as ExpandedNode).includes("not expanded again"));
  });

  test("toolbar: Expand all and Collapse all always; Open in Studio, Copy link and Open in panel on request", async () => {
    const tree = await expand(HELLO_WORLD, HELLO_WORLD_ROOT_ID);
    const plain = renderEvidenceHtml(tree);
    assert.ok(plain.includes('data-evt-act="expand"') && plain.includes('data-evt-act="collapse"'));
    assert.ok(!plain.includes("openStudio") && !plain.includes("copyLink") && !plain.includes("openPanel"));
    const full = renderEvidenceHtml(tree, { toolbar: { studio: true, copyLink: true, openPanel: true } });
    for (const act of ["openStudio", "copyLink", "openPanel"]) {
      assert.ok(full.includes(`data-evt-act="${act}" data-fact="${HELLO_WORLD_ROOT_ID}"`), act);
    }
    assert.ok(full.includes("Evidence Tree Link"), "the Studio buttons say what they need");
  });

  test("the legend lists the sources present in the tree", async () => {
    const legend = (html: string) => html.split('<div class="evt-legend">')[1].split("</div>")[0];
    const hello = legend(renderEvidenceHtml(await expand(HELLO_WORLD, HELLO_WORLD_ROOT_ID)));
    assert.ok(hello.includes(">rule<") && hello.includes(">injected<") && hello.includes(">knowledge map<"));
    assert.ok(!hello.includes(">answer<") && !hello.includes(">list function<"));
    const loan = legend(renderEvidenceHtml(await expand(LOAN, LOAN_ROOT_ID)));
    assert.ok(loan.includes(">list function<") && loan.includes(">answer<") && loan.includes(">not met<"));
  });
});

describe("renderEvidenceHtml on the engine's own examples", () => {
  test("typed variables ({value, type}) show their value, dates as YYYY-MM-DD, never [object Object]", async () => {
    const income = renderEvidenceHtml(await expand(INCOME, INCOME_ROOT_ID));
    assert.ok(income.includes('<span class="evt-var">%O = 4500</span>'));
    const dates = renderEvidenceHtml(await expand(DATES, DATES_ROOT_ID));
    assert.ok(dates.includes('<span class="evt-var">%LOWEST_DATE = 1990-01-01</span>'));
    assert.ok(dates.includes('<span class="evt-var">%HIGHEST_DATE = 1990-10-10</span>'));
    assert.ok(dates.includes("<b>1990-05-05</b>"), "a date condition's object");
    assert.ok(dates.includes('title="With values: (1990-01-01 = 1990-01-01)"'));
    const empty = renderEvidenceHtml(await expand(EMPTY_LIST, EMPTY_LIST_ROOT_ID));
    assert.ok(empty.includes('<span class="evt-var">%O = true</span>'));
    for (const html of [income, dates, empty]) assert.ok(!html.includes("[object Object]") && !html.includes("object Object"));
    for (const tree of [await expand(INCOME, INCOME_ROOT_ID), await expand(DATES, DATES_ROOT_ID), await expand(EMPTY_LIST, EMPTY_LIST_ROOT_ID)]) {
      assert.ok(!describeEvidence(tree).includes("[object Object]"));
    }
    assert.ok(describeEvidence(await expand(INCOME, INCOME_ROOT_ID)).includes("Rule (certainty cap 100%); variables %O = 4500, %S = Tom;"));
    assert.ok(describeEvidence(await expand(DATES, DATES_ROOT_ID)).includes("variables %HIGHEST_DATE = 1990-10-10, %LOWEST_DATE = 1990-01-01, %MIDDLE_DATE = 1990-05-05"));
  });

  test("expressions count in the total weight: a fully met condition fills its maximum", async () => {
    // Engine: 3 relationship conditions + 3 expressions at weight 100 → 16.67 each.
    const html = renderEvidenceHtml(await expand(DATES, DATES_ROOT_ID));
    assert.equal(count(html, '<span class="evt-bar-max" style="width:16.67%">'), 6);
    assert.equal(count(html, '<span class="evt-bar-val" style="width:16.67%">'), 6);
    assert.equal(count(html, 'title="Impact 16.67% of a possible 16.67% (weight 100)"'), 6);
    assert.ok(!html.includes("33.33"));
  });

  test("a list function over an empty list: no value, 0 facts, struck through, against a 7.14 maximum", async () => {
    const tree = await expand(EMPTY_LIST, EMPTY_LIST_ROOT_ID);
    const html = renderEvidenceHtml(tree);
    assert.ok(html.includes(`<code>minObjects( &#39;Nigel&#39;, &#39;always empty&#39;, *)</code> = <span class="evt-none">no value</span> <span class="evt-count">(0 facts)</span>`));
    assert.ok(html.includes(`<code>sumObjects( &#39;Nigel&#39;, &#39;always empty&#39;, *)</code> = <b>0</b> <span class="evt-count">(0 facts)</span>`), "0 is a value");
    assert.ok(!html.includes("= <b>?</b>"));
    assert.equal(count(html, '<li class="evt-cond evt-fn-cond evt-unmet">'), 4);
    assert.equal(count(html, '<span class="evt-bar-max" style="width:7.14%">'), 4);
    assert.ok(html.includes('title="Impact 71.43% of a possible 71.43% (weight 100)"'));
    assert.ok(html.includes("Inputs used by this result (0)"));
    const text = describeEvidence(tree);
    assert.ok(text.includes("list function minObjects( 'Nigel', 'always empty', *) = no value (0 facts)"));
    assert.ok(text.includes("impact 0% of a possible 7.14% (weight 10) · NOT MET"));
  });

  test("when the impacts show a condition the payload left out, the maximum is derived and marked approximate", async () => {
    const tree = await expand(SKIPPED, SKIPPED_ROOT_ID);
    const html = renderEvidenceHtml(tree);
    assert.equal(count(html, '<span class="evt-bar-max" style="width:41.67%">'), 2, "not 50: the engine divided by 240");
    assert.ok(html.includes("the maximum is approximate, worked out from the reported impacts"));
    assert.ok(describeEvidence(tree).includes("impact 41.67% of a possible 41.67% (approximate) (weight 100)"));
  });

  test("ids default to a prefix derived from the root fact, so trees on one page do not collide", async () => {
    const ids = (html: string) => [...html.matchAll(/ id="([^"]+)"/g)].map((m) => m[1]);
    const loan = ids(renderEvidenceHtml(await expand(LOAN, LOAN_ROOT_ID)));
    const repeat = ids(renderEvidenceHtml(await expand(REPEAT, REPEAT_ROOT_ID)));
    assert.ok(loan.length && repeat.length);
    assert.ok(loan.every((id) => /^evt-[0-9a-z]+-f\d+$/.test(id)), loan.join());
    assert.ok(!loan.some((id) => repeat.includes(id)), "different results, different ids");
    assert.deepEqual(ids(renderEvidenceHtml(await expand(LOAN, LOAN_ROOT_ID))), loan, "stable for the same result");
    const goto = renderEvidenceHtml(await expand(REPEAT, REPEAT_ROOT_ID));
    const target = /data-evt-goto="([^"]+)"/.exec(goto)?.[1];
    assert.ok(target && goto.includes(` id="${target}"`), "Go to it points at an id in the same tree");
  });
});

describe("evidence styles", () => {
  test("EVIDENCE_CSS scopes every rule under .evt", () => {
    const rules = EVIDENCE_CSS.replace(/\/\*[\s\S]*?\*\//g, "")
      .split("}")
      .map((chunk) => chunk.split("{")[0].trim())
      .filter(Boolean);
    assert.ok(rules.length > 30);
    for (const selectorList of rules) {
      for (const selector of selectorList.split(",")) {
        assert.match(selector.trim(), /^\.evt(?![\w-])/, `unscoped selector: ${selector.trim()}`);
      }
    }
  });

  test("SOURCE_STYLE uses Studio's colours with readable text on every badge", () => {
    const hue = (hex: string) => {
      const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
      return { r, g, b };
    };
    const rule = hue(SOURCE_STYLE.rule.bg);
    assert.ok(rule.b > rule.r && rule.b > rule.g && rule.b < 200, "rule: dark blue");
    const list = hue(SOURCE_STYLE.listFunction.bg);
    assert.ok(list.b > list.r && list.b > 200, "list function: light blue");
    const injected = hue(SOURCE_STYLE.injection.bg);
    assert.ok(injected.g > injected.r && injected.g > 200, "injected: light green");
    const answer = hue(SOURCE_STYLE.answer.bg);
    assert.ok(answer.r > 150 && answer.g < 80, "answer: red");
    const datasource = hue(SOURCE_STYLE.datasource.bg);
    assert.ok(datasource.g > datasource.r && datasource.g < 150, "datasource: dark green");
    const map = hue(SOURCE_STYLE.knowledgemap.bg);
    assert.ok(map.r > 200 && map.g > 70 && map.g < 160 && map.b < 60, "knowledge map: orange");

    const luminance = (hex: string) => {
      const { r, g, b } = hue(hex);
      const [R, G, B] = [r, g, b].map((v) => v / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
      return 0.2126 * R + 0.7152 * G + 0.0722 * B;
    };
    for (const [kind, style] of Object.entries(SOURCE_STYLE)) {
      const [hi, lo] = [luminance(style.bg), luminance(style.fg)].sort((a, b) => b - a);
      const ratio = (hi + 0.05) / (lo + 0.05);
      assert.ok(ratio >= 4.5, `${kind}: contrast ${ratio.toFixed(2)} is below 4.5`);
    }
    assert.equal(SOURCE_STYLE.knowledgemap.label, "knowledge map");
    assert.equal(SOURCE_STYLE.injection.label, "injected");
  });
});

describe("EVIDENCE_SCRIPT in a webview", () => {
  test("Expand all opens every disclosure in its tree; Collapse all closes all but the root card", async () => {
    const h = loadWebview(page(renderEvidenceHtml(await expand(LOAN, LOAN_ROOT_ID))));
    const details = () => h.$$("details").map((d) => (d as unknown as { open: boolean }).open);
    assert.deepEqual(details(), [true, false, true, true], "root, nested rule, zero salience, inputs");
    h.click('[data-evt-act="expand"]');
    assert.deepEqual(details(), [true, true, true, true]);
    h.click('[data-evt-act="collapse"]');
    assert.deepEqual(details(), [true, false, false, false]);
    assert.equal(h.posted.length, 0, "expand and collapse stay in the page");
    await h.close();
  });

  test("Open in Studio, Copy link and Open in panel post one evidenceAction each, even when the script is included twice", async () => {
    const html = renderEvidenceHtml(await expand(HELLO_WORLD, HELLO_WORLD_ROOT_ID), { toolbar: { studio: true, copyLink: true, openPanel: true } });
    const h = loadWebview(page(html, `const vscode = acquireVsCodeApi();${EVIDENCE_SCRIPT}${EVIDENCE_SCRIPT}`));
    h.click('[data-evt-act="openStudio"]');
    h.click('[data-evt-act="copyLink"]');
    h.click('[data-evt-act="openPanel"]');
    assert.deepEqual(h.posted, [
      { type: "evidenceAction", action: "openStudio", factId: HELLO_WORLD_ROOT_ID },
      { type: "evidenceAction", action: "copyLink", factId: HELLO_WORLD_ROOT_ID },
      { type: "evidenceAction", action: "openPanel", factId: HELLO_WORLD_ROOT_ID },
    ]);
    await h.close();
  });

  test("trees inserted after the script loaded work too, each on its own", async () => {
    const h = loadWebview(page(""));
    const host = h.$("#host") as unknown as { insertAdjacentHTML(where: string, html: string): void };
    host.insertAdjacentHTML("beforeend", renderEvidenceHtml(await expand(LOAN, LOAN_ROOT_ID), { idPrefix: "a-" }));
    host.insertAdjacentHTML("beforeend", renderEvidenceHtml(await expand(INCOME, INCOME_ROOT_ID), { idPrefix: "b-", toolbar: { studio: true } }));
    const [loan, income] = h.$$(".evt");
    h.click(loan.querySelector('[data-evt-act="expand"]') as never);
    assert.ok([...loan.querySelectorAll("details")].every((d) => (d as unknown as { open: boolean }).open));
    h.click(income.querySelector('[data-evt-act="collapse"]') as never);
    assert.ok([...loan.querySelectorAll("details")].every((d) => (d as unknown as { open: boolean }).open), "the other tree is untouched");
    h.click(income.querySelector('[data-evt-act="openStudio"]') as never);
    assert.deepEqual(h.lastPosted("evidenceAction"), { type: "evidenceAction", action: "openStudio", factId: INCOME_ROOT_ID });
    await h.close();
  });

  test("Go to it opens the cards around the fact it points at", async () => {
    const h = loadWebview(page(renderEvidenceHtml(await expand(REPEAT, REPEAT_ROOT_ID), { idPrefix: "evt-" })));
    const target = h.$("#evt-f1") as unknown as { open: boolean };
    assert.equal(target.open, false);
    h.click('[data-evt-act="collapse"]');
    h.click("[data-evt-goto]");
    assert.equal(target.open, true);
    assert.equal((h.$("#evt-f0") as unknown as { open: boolean }).open, true);
    await h.close();
  });

  test("the script text is safe inside a template literal", () => {
    assert.ok(!EVIDENCE_SCRIPT.includes("`"));
    assert.ok(!EVIDENCE_SCRIPT.includes("${"));
    assert.doesNotThrow(() => new Function("window", "document", "vscode", EVIDENCE_SCRIPT));
  });
});

describe("renderEvidencePage", () => {
  test("a nonce CSP, no external resources, and the toolbar posts actions", async () => {
    const html = renderEvidencePage(await expand(HELLO_WORLD, HELLO_WORLD_ROOT_ID), {
      nonce: "abc123",
      heading: "Evidence: Tom <speaks> French",
      render: { toolbar: { studio: true, copyLink: true } },
    });
    assert.ok(html.includes(`content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-abc123';"`));
    assert.equal(count(html, "<script"), count(html, '<script nonce="abc123">'));
    assert.ok(!/\s(src|href)=/.test(html), "no external resources");
    assert.ok(html.includes("Evidence: Tom &lt;speaks&gt; French"));
    assert.ok(!html.includes('data-evt-act="openPanel"'), "already in a panel");
    const h = loadWebview(html);
    h.click('[data-evt-act="copyLink"]');
    assert.deepEqual(h.posted, [{ type: "evidenceAction", action: "copyLink", factId: HELLO_WORLD_ROOT_ID }]);
    await h.close();
  });
});

describe("describeEvidence", () => {
  test("the HelloWorld outline: conditions with their sources, impacts against the maximum, inputs used", async () => {
    const text = describeEvidence(await expand(HELLO_WORLD, HELLO_WORLD_ROOT_ID));
    assert.ok(text.startsWith(`Tom speaks French — 71% [inferred by a rule] (factID ${HELLO_WORLD_ROOT_ID})`));
    assert.ok(text.includes("Rule (certainty cap 75%); variables %COUNTRY = France, %O = French, %S = Tom; conditions in the order the engine reports them:"));
    assert.ok(text.includes("  1. Tom lives in France — 90% [injected] · impact 33.75% of a possible 37.5% (weight 100)"));
    assert.ok(text.includes("  2. France national language French — 100% [built into the map] · impact 37.5% of a possible 37.5% (weight 100)"));
    assert.ok(text.includes("Inputs used by this result (2):"));
  });

  test("list functions, nested rules, unmet and zero-salience conditions", async () => {
    const text = describeEvidence(await expand(LOAN, LOAN_ROOT_ID));
    assert.ok(text.includes(`1. list function ${INCOME_CALL} = 4500 (3 facts) · impact 100% of a possible 100% (weight 100)`));
    assert.ok(text.includes("- Tom has income 2000 — 90% [answered by the user]"));
    assert.ok(text.includes('evidence text: "Tom earns 4500 a year"'));
    assert.ok(
      text.includes(
        "2. Tom has guarantor Ann — 0% [synthesised 0% placeholder: optional condition not met] · impact 0% of a possible 11.43% (weight 50) · NOT MET (optional condition; 0% impact)"
      )
    );
    assert.ok(!text.includes("could not load") && !text.includes("could not be loaded"));
    assert.ok(text.includes('expression "%TOTAL > 3000" (with values: 4500 > 3000) was true · impact 22.86% of a possible 22.86% (weight 100)'));
    assert.ok(text.includes("variables %O = premium loan, %S = Tom, %TOTAL = 4500"));
    assert.ok(text.includes("zero salience (weight 0: no effect on the certainty)"));
    assert.ok(!/(→|=)\s*%O\b/.test(text), "never the variable an expression was stored in");
    assert.ok(text.includes("Inputs used by this result (4):"));
  });

  test("a long outline is cut at a line boundary and says so", async () => {
    const text = describeEvidence(await expand(CLAIM, CLAIM_ROOT_ID), { maxChars: 400 });
    assert.ok(text.endsWith("… (outline truncated at 400 characters)"));
    assert.ok(text.length < 400 + 60);
  });
});
