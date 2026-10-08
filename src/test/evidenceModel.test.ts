/**
 * The evidence model: expanding a tree from single-node GETs (order, memo,
 * budget, depth, errors, repeats, cycles, determinism), walking it, listing
 * its inputs, and the helpers every surface shares. Uses the real HelloWorld
 * sandbox captures plus synthetic trees (src/test/fixtures/evidenceFixtures.ts).
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { ApiError, RainbirdClient } from "../api";
import {
  ExpandedNode,
  bindingText,
  bindingValue,
  expandEvidence,
  formatValue,
  impactScale,
  isSynthesisFactId,
  isUnmet,
  leafFacts,
  maxImpact,
  normaliseSource,
  overlayFromEvidence,
  sourceLabel,
  substituteAlt,
  walkEvidence,
} from "../evidenceModel";
import {
  CLAIM,
  CLAIM_HOLDS_ID,
  CLAIM_PLURAL_ID,
  CLAIM_ROOT_ID,
  CYCLE,
  CYCLE_A_ID,
  CYCLE_B_ID,
  DATES,
  DATES_ROOT_ID,
  EMPTY_LIST,
  EMPTY_LIST_ROOT_ID,
  HELLO_WORLD,
  HELLO_WORLD_INJECTED_ID,
  HELLO_WORLD_KM_ID,
  HELLO_WORLD_ROOT,
  HELLO_WORLD_ROOT_ID,
  HELLO_WORLD_SESSION_ID,
  INCOME,
  INCOME_ANSWER_ID,
  INCOME_INJECTED_ID,
  INCOME_KM_ID,
  INCOME_ROOT_ID,
  LOAN,
  LOAN_ROOT_ID,
  REPEAT,
  REPEAT_ROOT_ID,
  SKIPPED,
  SKIPPED_ROOT_ID,
  SYNTHESIS_ID,
  fakeFetch,
} from "./fixtures/evidenceFixtures";

describe("expandEvidence", () => {
  test("the real HelloWorld capture: each condition carries the fact that satisfied it, in rule order", async () => {
    const tree = await expandEvidence(fakeFetch(HELLO_WORLD), HELLO_WORLD_ROOT_ID);
    const [livesIn, language] = tree.rule?.conditions ?? [];
    assert.equal(livesIn.relationship, "lives in");
    assert.equal(livesIn.evidence?.factID, HELLO_WORLD_INJECTED_ID);
    assert.equal(livesIn.evidence?.source, "injection");
    assert.equal(language.relationship, "national language");
    assert.equal(language.evidence?.factID, HELLO_WORLD_KM_ID);
    assert.equal(language.evidence?.source, "km");
    assert.equal(tree.rule?.ruleMaxCertainty, 75);
    assert.deepEqual(tree.meta, { nodes: 3, truncated: false, errors: 0 });
  });

  test("fetches each factID once and never writes into the objects the fetcher returned", async () => {
    const before = JSON.stringify(HELLO_WORLD);
    const fetcher = fakeFetch(HELLO_WORLD);
    await expandEvidence(fetcher, HELLO_WORLD_ROOT_ID);
    assert.deepEqual([...fetcher.calls].sort(), [HELLO_WORLD_INJECTED_ID, HELLO_WORLD_KM_ID, HELLO_WORLD_ROOT_ID].sort());
    assert.equal(JSON.stringify(HELLO_WORLD), before);

    // A fetcher that hands out the same object every time must not see flags or evidence appear on it.
    const shared = JSON.parse(JSON.stringify(HELLO_WORLD_ROOT));
    const snapshot = JSON.stringify(shared);
    await expandEvidence(async (id) => (id === HELLO_WORLD_ROOT_ID ? shared : HELLO_WORLD[id]), HELLO_WORLD_ROOT_ID);
    assert.equal(JSON.stringify(shared), snapshot);
    assert.equal(JSON.stringify(HELLO_WORLD), before);
  });

  test("serialises as a tree without `children`", async () => {
    const tree = await expandEvidence(fakeFetch(HELLO_WORLD), HELLO_WORLD_ROOT_ID);
    const json = JSON.stringify(tree);
    assert.ok(!json.includes('"children"'));
    assert.equal(json.split(HELLO_WORLD_INJECTED_ID).length - 1, 2, "the injected fact appears once as the condition's factID and once as its node");
    assert.ok(!Object.keys(tree).includes("children"));
  });

  test("the root's error is rethrown unchanged, so callers can branch on ApiError.status", async () => {
    const locked = new ApiError("Rainbird API 403 on /analysis/evidence: locked", 403, "locked");
    await assert.rejects(
      expandEvidence(fakeFetch(HELLO_WORLD, { fail: { [HELLO_WORLD_ROOT_ID]: locked } }), HELLO_WORLD_ROOT_ID),
      (error) => error === locked
    );
  });

  test("a failed child becomes fetchError on its condition and is counted, without failing the tree", async () => {
    const tree = await expandEvidence(
      fakeFetch(HELLO_WORLD, { fail: { [HELLO_WORLD_KM_ID]: new Error("Rainbird API 500 on /analysis/evidence: boom") } }),
      HELLO_WORLD_ROOT_ID
    );
    const [livesIn, language] = tree.rule?.conditions ?? [];
    assert.equal(livesIn.evidence?.source, "injection");
    assert.equal(language.evidence, undefined);
    assert.match(language.fetchError ?? "", /500/);
    assert.equal(tree.meta.errors, 1);
    assert.equal(tree.meta.truncated, false);
    assert.equal(tree.meta.nodes, 2, "meta.nodes counts the nodes loaded: the root and the injected fact");
  });

  test("an unmet optional condition (factID WA:XX) is never fetched: it gets a local synthesis node, not an error", async () => {
    const fetcher = fakeFetch(LOAN);
    const tree = await expandEvidence(fetcher, LOAN_ROOT_ID);
    assert.ok(!fetcher.calls.includes(SYNTHESIS_ID), "the engine never stores it, so GET would 404");
    assert.deepEqual(tree.meta, { nodes: 6, truncated: false, errors: 0 }, "root, nested rule, three incomes, lives in");
    const guarantor = tree.rule?.conditions?.[1];
    assert.equal(guarantor?.fetchError, undefined);
    assert.equal(guarantor?.repeat, undefined);
    assert.equal(guarantor?.evidence?.source, "synthesis");
    assert.equal(guarantor?.evidence?.factID, SYNTHESIS_ID);
    assert.deepEqual(guarantor?.evidence?.fact, {
      subject: { value: "Tom" },
      relationship: { type: "has guarantor" },
      object: { value: "Ann", dataType: "string" },
      certainty: 0,
    });
    assert.equal(isUnmet(guarantor), true);

    // Every WA:XX reference gets its own node: they share the ID, not the fact.
    const two = JSON.parse(JSON.stringify(LOAN));
    two[LOAN_ROOT_ID].rule.conditions.push({ certainty: 0, factID: "WA:XX", impact: 0, object: "yes", relationship: "owns home", salience: 50, subject: "Tom" });
    const twice = await expandEvidence(fakeFetch(two), LOAN_ROOT_ID);
    const [first, second] = [twice.rule?.conditions?.[1], twice.rule?.conditions?.[5]];
    assert.equal(second?.repeat, undefined, "not a repeat of the first placeholder");
    assert.equal(first?.evidence?.fact.relationship.type, "has guarantor");
    assert.equal(second?.evidence?.fact.relationship.type, "owns home");
    assert.equal(twice.meta.errors, 0);
  });

  test("maxNodes: relationship conditions claim the budget before list-function facts, in declared order", async () => {
    // Root with a list function declared FIRST and a relationship condition second.
    const nodes = {
      ...INCOME,
      "WA:RF:budget": {
        factID: "WA:RF:budget",
        source: "rule" as const,
        fact: { subject: { value: "Tom" }, relationship: { type: "is eligible" }, object: { value: "yes" }, certainty: 100 },
        rule: {
          conditions: [
            INCOME[INCOME_ROOT_ID].rule!.conditions![0],
            { certainty: 90, factID: HELLO_WORLD_INJECTED_ID, impact: 50, object: "France", relationship: "lives in", salience: 100, subject: "Tom" },
          ],
        },
      },
      [HELLO_WORLD_INJECTED_ID]: HELLO_WORLD[HELLO_WORLD_INJECTED_ID],
    };
    const tree = await expandEvidence(fakeFetch(nodes), "WA:RF:budget", { maxNodes: 3 });
    const [sum, livesIn] = tree.rule?.conditions ?? [];
    assert.equal(livesIn.evidence?.source, "injection", "the relationship condition got its slot first");
    const facts = Object.values(sum.expression?.functions ?? {})[0].facts ?? [];
    assert.equal(facts[0].evidence?.factID, INCOME_INJECTED_ID, "then the first list-function fact");
    assert.equal(facts[1].truncated, true);
    assert.equal(facts[2].truncated, true);
    assert.deepEqual(tree.meta, { nodes: 3, truncated: true, errors: 0 });
  });

  test("maxDepth: references below the deepest level are marked truncated, not fetched", async () => {
    const fetcher = fakeFetch(LOAN);
    const tree = await expandEvidence(fetcher, LOAN_ROOT_ID, { maxDepth: 1 });
    const income = tree.rule?.conditions?.[0];
    assert.equal(income?.evidence?.factID, INCOME_ROOT_ID);
    const facts = Object.values(income?.evidence?.rule?.conditions?.[0].expression?.functions ?? {})[0].facts ?? [];
    assert.ok(facts.every((f) => f.truncated && !f.evidence));
    assert.ok(!fetcher.calls.includes(INCOME_INJECTED_ID));
    assert.equal(tree.meta.truncated, true);
  });

  test("one factID shared by several list-function facts is fetched once; the later facts are repeat header copies", async () => {
    const fetcher = fakeFetch(CLAIM);
    const tree = await expandEvidence(fetcher, CLAIM_ROOT_ID);
    assert.equal(fetcher.calls.filter((id) => id === CLAIM_PLURAL_ID).length, 1);
    const facts = Object.values(tree.rule?.conditions?.[7].expression?.functions ?? {})[0].facts ?? [];
    assert.deepEqual(facts.map((f) => f.object), ["laptop", "headphones", "bicycle"], "the inline triples stay as sent");
    assert.equal(facts[0].repeat, undefined);
    assert.equal(facts[0].evidence?.source, "answer");
    assert.ok(facts[1].repeat && facts[1].evidence?.repeat && facts[1].evidence.source === "answer");
    assert.ok(facts[2].repeat);
    assert.equal(tree.meta.nodes, 9, "the root, seven relationship supports and the shared answer");
  });

  test("a rule-derived fact used twice is expanded once; the second reference is a header copy without its rule", async () => {
    const fetcher = fakeFetch(REPEAT);
    const tree = await expandEvidence(fetcher, REPEAT_ROOT_ID);
    const [first, second] = tree.rule?.conditions ?? [];
    assert.ok(first.evidence?.rule?.conditions?.length);
    assert.equal(second.repeat, true);
    assert.equal(second.evidence?.repeat, true);
    assert.equal(second.evidence?.rule, undefined);
    assert.equal(second.evidence?.fact.object.value, 4500);
    assert.equal(fetcher.calls.filter((id) => id === INCOME_ROOT_ID).length, 1);
    // The incomes behind the shared rule appear once in the serialised tree.
    assert.equal(JSON.stringify(tree).split(`"factID":"${INCOME_ANSWER_ID}"`).length - 1, 2, "once inline, once as its node");
  });

  test("a cycle is cut: the reference back up the branch is flagged cyclic with a header copy", async () => {
    const tree = await expandEvidence(fakeFetch(CYCLE), CYCLE_A_ID);
    const toB = tree.rule?.conditions?.[0];
    assert.equal(toB?.evidence?.factID, CYCLE_B_ID);
    const backToA = toB?.evidence?.rule?.conditions?.[0];
    assert.equal(backToA?.cyclic, true);
    assert.equal(backToA?.evidence?.cyclic, true);
    assert.equal(backToA?.evidence?.factID, CYCLE_A_ID);
    assert.equal(backToA?.evidence?.rule, undefined);
    assert.equal(tree.meta.nodes, 2);
  });

  test("the expanded tree does not depend on the order responses arrive in", async () => {
    const delays = [(id: string) => (id.length * 7) % 13, (id: string) => (id.charCodeAt(5) * 3) % 11, () => 0];
    const trees: string[] = [];
    for (const delay of delays) {
      trees.push(JSON.stringify(await expandEvidence(fakeFetch(LOAN, { delay }), LOAN_ROOT_ID, { maxNodes: 4 })));
    }
    assert.equal(trees[1], trees[0]);
    assert.equal(trees[2], trees[0]);
  });

  test("never has more than `concurrency` GETs in flight", async () => {
    const nodes: Record<string, (typeof INCOME)[string]> = { ...INCOME };
    const root = JSON.parse(JSON.stringify(INCOME[INCOME_ROOT_ID]));
    const facts = root.rule.conditions[0].expression.functions["sumObjects( 'Tom', 'has income', *)"].facts;
    for (let i = 0; i < 12; i++) {
      const id = `WA:AF:extra${i}`;
      facts.push({ certainty: 100, factID: id, object: i, relationship: "has income", subject: "Tom" });
      nodes[id] = { factID: id, source: "answer", fact: { subject: { value: "Tom" }, relationship: { type: "has income" }, object: { value: i }, certainty: 100 } };
    }
    nodes[INCOME_ROOT_ID] = root;
    const fetcher = fakeFetch(nodes, { delay: () => 2 });
    const tree = await expandEvidence(fetcher, INCOME_ROOT_ID, { concurrency: 3 });
    assert.ok(fetcher.peak <= 3, `peak ${fetcher.peak}`);
    assert.equal(tree.meta.nodes, 16);
  });
});

describe("walking the tree", () => {
  test("walkEvidence visits in document order and can skip a subtree", async () => {
    const tree = await expandEvidence(fakeFetch(LOAN), LOAN_ROOT_ID);
    const order: string[] = [];
    walkEvidence(tree, (node, context) => {
      order.push(`${context.depth}:${node.factID}`);
    });
    assert.deepEqual(order, [
      `0:${LOAN_ROOT_ID}`,
      `1:${INCOME_ROOT_ID}`,
      `2:${INCOME_INJECTED_ID}`,
      `2:${INCOME_ANSWER_ID}`,
      `2:${INCOME_KM_ID}`,
      `1:${SYNTHESIS_ID}`,
      "1:WA:IF:5d4e0lives0in0france",
    ]);
    const skipped: string[] = [];
    walkEvidence(tree, (node) => {
      skipped.push(node.factID);
      return node.factID !== INCOME_ROOT_ID;
    });
    assert.ok(!skipped.includes(INCOME_INJECTED_ID));
  });

  test("leafFacts lists every input (answers, injected, datasource, knowledge map), never rules or synthesis", async () => {
    const hello = leafFacts(await expandEvidence(fakeFetch(HELLO_WORLD), HELLO_WORLD_ROOT_ID));
    assert.deepEqual(
      hello.map((f) => `${f.kind}: ${f.subject} ${f.relationship} ${f.object} ${f.certainty}%`),
      ["injection: Tom lives in France 90%", "knowledgemap: France national language French 100%"]
    );
    assert.equal(hello[1].source, "km");
    assert.equal(hello[0].objectType, "string", "the data type, never the concept name (country)");

    const income = leafFacts(await expandEvidence(fakeFetch(INCOME), INCOME_ROOT_ID));
    assert.deepEqual(
      income.map((f) => `${f.kind} ${f.object}`),
      ["injection 1500", "answer 2000", "knowledgemap 1000"]
    );

    const loan = leafFacts(await expandEvidence(fakeFetch(LOAN), LOAN_ROOT_ID));
    assert.equal(loan.length, 4, "three incomes behind the nested rule + the zero-weight lives-in fact");
    assert.ok(!loan.some((f) => f.relationship === "has guarantor"));
    assert.ok(!loan.some((f) => f.kind === "rule" || f.kind === "synthesis"));

    // Document order; three values behind one shared factID are three inputs.
    const claim = leafFacts(await expandEvidence(fakeFetch(CLAIM), CLAIM_ROOT_ID));
    assert.equal(claim.length, 10);
    assert.equal(`${claim[0].subject} ${claim[0].relationship} ${claim[0].object}`, "Ben holds Gold");
    assert.deepEqual(
      claim.slice(-3).map((f) => `${f.kind} ${f.object}`),
      ["answer laptop", "answer headphones", "answer bicycle"]
    );
    assert.equal(claim[1].kind, "knowledgemap", "the OpenAPI spelling knowledgemap is the same kind as km");
  });

  test("leafFacts lists an input that could not be loaded as kind unknown, unless the triple is known elsewhere", async () => {
    const tree = await expandEvidence(fakeFetch(CLAIM, { fail: { [CLAIM_HOLDS_ID]: new Error("timeout") } }), CLAIM_ROOT_ID);
    const holds = leafFacts(tree).find((f) => f.relationship === "holds");
    assert.equal(holds?.kind, "unknown");
    assert.equal(holds?.factID, CLAIM_HOLDS_ID);
  });

  test("isUnmet: wasMet false, a synthesis support and a synthesis node are unmet; met conditions are not", async () => {
    const tree = await expandEvidence(fakeFetch(LOAN), LOAN_ROOT_ID);
    const flags = (tree.rule?.conditions ?? []).map((c) => isUnmet(c));
    assert.deepEqual(flags, [false, true, false, false, true]);
    assert.equal(isUnmet(tree.rule?.conditions?.[1].evidence), true);
    assert.equal(isUnmet(tree), false);
    assert.equal(isUnmet(undefined), false);
    // As sent, before expansion: no wasMet on relationship conditions, only the placeholder ID.
    assert.equal(isUnmet(LOAN[LOAN_ROOT_ID].rule!.conditions![1]), true);
    assert.equal(isUnmet(HELLO_WORLD_ROOT.rule!.conditions![0]), false);
  });

  test("isSynthesisFactId: the literal WA:XX and WA:XX:<hash>, nothing else", () => {
    assert.equal(isSynthesisFactId("WA:XX"), true);
    assert.equal(isSynthesisFactId(" WA:XX "), true);
    assert.equal(isSynthesisFactId("WA:XX:1f2e3d"), true);
    for (const id of ["WA:RF:abc", "WA:KF:XX", "WA:XXL:abc", "XX", "", undefined, 42]) assert.equal(isSynthesisFactId(id), false, String(id));
  });

  test("overlayFromEvidence: relationships with their highest certainty, instances, list-function inputs, 0 and false kept", async () => {
    const hello = overlayFromEvidence(await expandEvidence(fakeFetch(HELLO_WORLD), HELLO_WORLD_ROOT_ID));
    assert.deepEqual(hello.rels, [
      { name: "speaks", certainty: 71 },
      { name: "lives in", certainty: 90 },
      { name: "national language", certainty: 100 },
    ]);
    assert.deepEqual(hello.instances.sort(), ["France", "French", "Tom"]);

    const income = overlayFromEvidence(await expandEvidence(fakeFetch(INCOME), INCOME_ROOT_ID));
    assert.ok(income.rels.some((r) => r.name === "has income" && r.certainty === 100));
    assert.ok(["1500", "2000", "1000", "4500"].every((v) => income.instances.includes(v)));

    const zeroAndFalse: ExpandedNode = {
      factID: "WA:RF:z",
      source: "rule",
      fact: { subject: { value: "Tom" }, relationship: { type: "owes" }, object: { value: 0 }, certainty: 100 },
      rule: { conditions: [{ subject: "Tom", relationship: "is retired", object: false, certainty: 100 }, { subject: "%S", relationship: "has", object: "%X" }] },
    };
    const overlay = overlayFromEvidence(zeroAndFalse);
    assert.ok(overlay.instances.includes("0"), "numeric 0 is a value");
    assert.ok(overlay.instances.includes("false"), "boolean false is a value");
    assert.ok(!overlay.instances.some((i) => i.startsWith("%")), "variables are not instances");

    const loan = overlayFromEvidence(await expandEvidence(fakeFetch(LOAN), LOAN_ROOT_ID));
    assert.ok(!loan.instances.includes("Ann"), "an unmet optional condition adds no instance");
    assert.ok(!loan.rels.some((r) => r.name === "has guarantor"), "nor its relationship");
    assert.ok(loan.rels.some((r) => r.name === "has income"), "list-function inputs behind the nested rule do");
  });
});

describe("evidence helpers", () => {
  test("substituteAlt fills {{%VAR}} and {{VAR}} from bindings and leaves the rest as written", () => {
    const bindings = { S: "Tom", COUNTRY: "France", O: "French", TOTAL: 4500 };
    assert.equal(substituteAlt("{{%S}} lives in {{%COUNTRY}}, whose national language is {{%O}}", bindings), "Tom lives in France, whose national language is French");
    assert.equal(substituteAlt("{{S}} earns {{ %TOTAL }}", bindings), "Tom earns 4500");
    assert.equal(substituteAlt("{{%UNKNOWN}} and {{%COUNTRY.is in continent}}", bindings), "{{%UNKNOWN}} and {{%COUNTRY.is in continent}}");
    assert.equal(substituteAlt("Tom lives in France", bindings), "Tom lives in France");
    assert.equal(substituteAlt("{{%S}}", undefined), "{{%S}}");
    assert.equal(substituteAlt(undefined, bindings), "");
    // Typed variables arrive as {value, type}: unwrapped, dates as YYYY-MM-DD; empty ones left as written.
    const typed = { O: { value: 5, type: "number" }, D: { type: "date", value: 655516800000 }, N: { type: "number", value: null }, S: "Tom" };
    assert.equal(substituteAlt("{{%S}} has {{%O}} items since {{%D}} ({{%N}})", typed), "Tom has 5 items since 1990-10-10 ({{%N}})");
  });

  test("bindingValue / bindingText unwrap the engine's {value, type} variables", () => {
    assert.deepEqual(bindingValue({ value: 5, type: "number" }), { value: 5, type: "number" });
    assert.deepEqual(bindingValue("Tom"), { value: "Tom" });
    assert.equal(bindingText({ value: 4500, type: "number" }), "4500");
    assert.equal(bindingText({ type: "date", value: 631152000000 }), "1990-01-01");
    assert.equal(bindingText({ type: "boolean", value: false }), "false");
    assert.equal(bindingText({ type: "number", value: null }), "–");
    assert.equal(bindingText(null), "–");
    assert.equal(bindingText("France"), "France");
    assert.equal(bindingText(0), "0");
  });

  test("formatValue: only the date data type turns epoch milliseconds into YYYY-MM-DD", () => {
    assert.equal(formatValue(1751328000000, "date"), "2025-07-01");
    assert.equal(formatValue("1751328000000", "DATE"), "2025-07-01");
    assert.equal(formatValue(0, "date"), "1970-01-01", "any epoch value, not only large ones");
    assert.equal(formatValue(12345678901, "candidate"), "12345678901", "a concept name containing 'date' is not a date type");
    assert.equal(formatValue(12345678901, "string"), "12345678901");
    assert.equal(formatValue("not a date", "date"), "not a date");
    assert.equal(formatValue(false), "false");
    assert.equal(formatValue(undefined), "?");
    assert.equal(formatValue([1, 2], "number"), "1, 2");
  });

  test("normaliseSource: km and knowledgemap are one kind; unknown strings stay recognisable", () => {
    assert.equal(normaliseSource("km"), "knowledgemap");
    assert.equal(normaliseSource("knowledgemap"), "knowledgemap");
    assert.equal(normaliseSource("KM"), "knowledgemap");
    assert.equal(normaliseSource("injection"), "injection");
    assert.equal(normaliseSource("synthesis"), "synthesis");
    assert.equal(normaliseSource("something-new"), "unknown");
    assert.equal(normaliseSource(undefined), "unknown");
    assert.equal(sourceLabel("km"), "knowledge map");
    assert.equal(sourceLabel("knowledgemap"), "knowledge map");
    assert.equal(sourceLabel("injection"), "injected");
    assert.equal(sourceLabel("synthesis"), "not met");
    assert.equal(sourceLabel("something-new"), "something-new");
    assert.equal(sourceLabel(undefined), "fact");
  });

  test("maxImpact = ruleMaxCertainty × weight ÷ the total weight, as verified on the sandbox", () => {
    const rule = HELLO_WORLD_ROOT.rule!;
    const [livesIn, language] = rule.conditions!;
    assert.equal(maxImpact(rule, livesIn), 37.5);
    assert.equal(maxImpact(rule, language), 37.5);
    // impact = max × certainty / 100 — the sandbox's own numbers.
    assert.equal((maxImpact(rule, livesIn)! * livesIn.certainty!) / 100, livesIn.impact);
    assert.equal((maxImpact(rule, language)! * language.certainty!) / 100, language.impact);
    assert.deepEqual(impactScale(rule), { cap: 75, total: 200, fromImpacts: false });
    assert.equal(maxImpact(undefined, livesIn), undefined);
  });

  test("the total weight includes expressions, as in the engine's own examples", () => {
    const round = (n: number | undefined) => Math.round(n! * 100) / 100;
    // "Evidence With Dates": three relationship conditions and three expressions, weight 100 each.
    const dates = DATES[DATES_ROOT_ID].rule!;
    assert.deepEqual(impactScale(dates), { cap: 100, total: 600, fromImpacts: false });
    for (const condition of dates.conditions!) {
      assert.equal(round(maxImpact(dates, condition)), 16.67, "a fully met condition reaches its maximum");
      assert.equal(condition.impact, 16.67);
    }
    // "Numerical Function Over Empty List": four weight-10 tests and "1 = 1" at weight 100.
    const empty = EMPTY_LIST[EMPTY_LIST_ROOT_ID].rule!;
    assert.deepEqual(
      empty.conditions!.map((c) => round(maxImpact(empty, c))),
      [7.14, 7.14, 7.14, 7.14, 71.43]
    );
    // The loan: 100 + 50 + 100 + 0 + 100 = 350 at cap 80.
    const loan = LOAN[LOAN_ROOT_ID].rule!;
    assert.deepEqual(impactScale(loan), { cap: 80, total: 350, fromImpacts: false });
    assert.deepEqual(
      loan.conditions!.map((c) => round(maxImpact(loan, c))),
      [22.86, 11.43, 22.86, 0, 22.86]
    );
  });

  test("when the reported weights do not explain the impacts, the total comes from the impacts", () => {
    // The engine counted a skipped optional condition (weight 40) it left out of the payload.
    const skipped = SKIPPED[SKIPPED_ROOT_ID].rule!;
    const scale = impactScale(skipped)!;
    assert.equal(scale.fromImpacts, true);
    assert.ok(Math.abs(scale.total - 240) < 0.5, `total ${scale.total}`);
    for (const condition of skipped.conditions!) assert.equal(Math.round(maxImpact(skipped, condition)! * 100) / 100, 41.67);

    // The OpenAPI example's hand-edited impacts (nine conditions at 14.29) do not add up either.
    const claim = CLAIM[CLAIM_ROOT_ID].rule!;
    assert.equal(impactScale(claim)?.fromImpacts, true);
    for (const condition of claim.conditions!) assert.equal(Math.round(maxImpact(claim, condition)! * 100) / 100, 14.29);
  });

  test("RainbirdClient.fullEvidence delegates to expandEvidence over GET /analysis/evidence, sending the evidence key", async () => {
    const realFetch = globalThis.fetch;
    const seen: { url: string; key?: string }[] = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const headers = (init?.headers ?? {}) as Record<string, string>;
      seen.push({ url, key: headers["x-evidence-key"] });
      const id = decodeURIComponent(url.split("/analysis/evidence/")[1].split("/")[0]);
      const node = HELLO_WORLD[id];
      return new Response(JSON.stringify(node), { status: node ? 200 : 404 });
    }) as typeof fetch;
    try {
      const client = new RainbirdClient("https://api.rainbird.ai", "api-key");
      const tree = await client.fullEvidence(HELLO_WORLD_ROOT_ID, HELLO_WORLD_SESSION_ID, "secret");
      assert.equal(tree.rule?.conditions?.[1].evidence?.source, "km");
      assert.deepEqual(tree.meta, { nodes: 3, truncated: false, errors: 0 });
      assert.equal(seen.length, 3);
      assert.ok(seen.every((s) => s.key === "secret" && s.url.endsWith(`/${HELLO_WORLD_SESSION_ID}`)));
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test("RainbirdClient.fullEvidence on a locked map rejects with ApiError status 403", async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response('{"err":["evidence is secured"]}', { status: 403 })) as typeof fetch;
    try {
      const client = new RainbirdClient("https://api.rainbird.ai", "api-key");
      await assert.rejects(client.fullEvidence(HELLO_WORLD_ROOT_ID, HELLO_WORLD_SESSION_ID), (error) => error instanceof ApiError && error.status === 403);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
