/**
 * Unit tests for the goal list (goals.ts): what each goal relationship carries
 * into the query panel's picker and the Quick Pick runner. Runs under plain
 * node (`npm test`).
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { goalsFromIndex, goalsFromMap, normaliseAskable } from "../goals";
import { buildIndex } from "../mapIndex";

const examples = path.join(__dirname, "..", "..", "examples");
const read = (name: string): string => fs.readFileSync(path.join(examples, name), "utf8");

const wrap = (body: string): string =>
  `<?xml version="1.0" encoding="utf-8"?>\n<rbl:kb xmlns:rbl="http://rbl.io/schema/RBLang">\n${body}\n</rbl:kb>\n`;

describe("goals: example maps", () => {
  test("hello-world: subject → object, plural, askable and rule / fact counts per relationship", () => {
    const list = goalsFromMap(read("hello-world.rbl"));
    assert.deepEqual(list.goals, [
      { name: "speaks", subject: "Person", object: "Language", plural: true, askable: "all", rules: 1, facts: 0 },
      { name: "lives in", subject: "Person", object: "Country", plural: false, askable: "all", rules: 0, facts: 0 },
      { name: "national language", subject: "Country", object: "Language", plural: false, askable: "none", rules: 0, facts: 2 },
    ]);
    assert.equal(list.askableMixed, true);
  });

  test("eligibility: derived relationships are askable none and inferred by rules", () => {
    const list = goalsFromMap(read("eligibility.rbl"));
    assert.deepEqual(list.goals, [
      { name: "has date of birth", subject: "Applicant", object: "Date Of Birth", plural: false, askable: "all", rules: 0, facts: 0 },
      { name: "has age", subject: "Applicant", object: "Age", plural: false, askable: "none", rules: 1, facts: 0 },
      { name: "has eligibility", subject: "Applicant", object: "Eligibility", plural: false, askable: "none", rules: 2, facts: 0 },
    ]);
    assert.equal(list.askableMixed, true);
  });

  test("bigger_map: every relationship, in document order, all askable none", () => {
    const text = read("bigger_map.rbl");
    const { goals, askableMixed } = goalsFromMap(text);
    const declared = [...text.matchAll(/<rel name="([^"]+)"/g)].map((m) => m[1]);
    assert.equal(goals.length, 261);
    assert.deepEqual(
      goals.map((g) => g.name),
      declared
    );
    assert.ok(goals.every((g) => g.askable === "none"));
    assert.equal(askableMixed, false, "a headless map does not mix askable values");
    assert.equal(goals.filter((g) => g.rules > 0).length, 147);
    assert.equal(goals.filter((g) => g.rules === 0 && g.facts === 0).length, 64);
    assert.equal(goals.filter((g) => g.plural).length, 63);
    assert.deepEqual(goals.find((g) => g.name === "total penalty"), {
      name: "total penalty",
      subject: "Case",
      object: "PenaltyPoints",
      plural: false,
      askable: "none",
      rules: 1,
      facts: 0,
    });
    const facts = goals.reduce((n, g) => n + g.facts, 0);
    const rules = goals.reduce((n, g) => n + g.rules, 0);
    assert.equal(facts + rules, (text.match(/<relinst\b/g) ?? []).length, "every relinst is counted once");
  });

  test("goalsFromIndex gives the same list from an index the caller already built", () => {
    const text = read("hello-world.rbl");
    assert.deepEqual(goalsFromIndex(buildIndex(text)), goalsFromMap(text));
  });
});

describe("goals: askable, duplicates and counts", () => {
  test("askable comes from each <rel> tag: omitted = all, legacy true/false = all/none, other values pass through", () => {
    const { goals, askableMixed } = goalsFromMap(
      wrap(`
  <rel name="omitted" subject="A" object="B"/>
  <rel name="legacy yes" subject="A" object="B" askable="true"/>
  <rel name="legacy no" subject="A" object="B" askable="false"/>
  <rel name="by object" subject="A" object="B" askable="secondFormObject"/>
  <rel name="by subject" subject="A" object="B" askable="secondFormSubject"/>
  <rel name="never" subject="A" object="B" askable="none"/>
  <rel name="odd" subject="A" object="B" askable="sometimes"/>`)
    );
    assert.deepEqual(
      goals.map((g) => [g.name, g.askable]),
      [
        ["omitted", "all"],
        ["legacy yes", "all"],
        ["legacy no", "none"],
        ["by object", "secondFormObject"],
        ["by subject", "secondFormSubject"],
        ["never", "none"],
        ["odd", "sometimes"],
      ]
    );
    assert.equal(askableMixed, true);
    assert.equal(normaliseAskable(undefined), "all");
    assert.equal(normaliseAskable("true"), "all");
    assert.equal(normaliseAskable("false"), "none");
    assert.equal(normaliseAskable("none"), "none");
  });

  test("askableMixed is false when every relationship is askable, and for an empty map", () => {
    assert.equal(goalsFromMap(wrap(`<rel name="a" subject="A" object="B"/><rel name="b" subject="A" object="B" askable="all"/>`)).askableMixed, false);
    assert.deepEqual(goalsFromMap(wrap("")), { goals: [], askableMixed: false });
  });

  test("a duplicated <rel> takes every attribute from one declaration (the one the index keeps), never first-wins askable", () => {
    const { goals, askableMixed } = goalsFromMap(
      wrap(`
  <rel name="dup" subject="First" object="B" askable="all"/>
  <rel name="other" subject="A" object="B" askable="all"/>
  <rel name="dup" subject="Second" object="C" plural="true" askable="none"/>`)
    );
    assert.deepEqual(goals, [
      { name: "dup", subject: "Second", object: "C", plural: true, askable: "none", rules: 0, facts: 0 },
      { name: "other", subject: "A", object: "B", plural: false, askable: "all", rules: 0, facts: 0 },
    ]);
    assert.equal(askableMixed, true);
  });

  test("a <rel> whose tag does not parse cleanly is not a goal (as in the index)", () => {
    const text = wrap(`<rel name="broken" subject=A object="B"/>\n  <rel name="fine" subject="A" object="B"/>`);
    assert.ok(buildIndex(text).tags.some((t) => t.name === "rel" && t.attrs.name === "broken" && t.malformed), "fixture: the tag is indexed as malformed");
    const { goals } = goalsFromMap(text);
    assert.deepEqual(
      goals.map((g) => g.name),
      ["fine"]
    );
  });

  test("rules are relinsts with any condition (relationship or expression); facts have none", () => {
    const { goals } = goalsFromMap(
      wrap(`
  <concept name="P" type="string"/>
  <concept name="N" type="number"/>
  <rel name="has score" subject="P" object="N" askable="none"/>
  <rel name="has base" subject="P" object="N"/>
  <relinst type="has score" subject="Ann" object="3"/>
  <relinst type="has score" subject="Bob" object="4"></relinst>
  <relinst type="has score" cf="100">
    <condition expression="1 + 2" value="%O"/>
  </relinst>
  <relinst type="has score" cf="100">
    <condition rel="has base" subject="%S" object="%B"/>
    <condition expression="%B * 2" value="%O"/>
  </relinst>`)
    );
    assert.deepEqual(
      goals.map((g) => [g.name, g.rules, g.facts]),
      [
        ["has score", 2, 2],
        ["has base", 0, 0],
      ]
    );
  });
});
