/**
 * Unit tests for the editor-agnostic symbol core (symbols.ts): what a rename
 * or linked-editing session touches, and what it must leave alone. Runs under
 * plain node (`npm test`).
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { applyEdits, linkedSpans, renameEdits, Span, spansAt, symbolAt } from "../symbols";
import { collectIssues } from "../lint";

const wrap = (body: string): string =>
  `<?xml version="1.0" encoding="UTF-8"?>\n<rbl:kb xmlns:rbl="http://rbl.io/schema/RBLang">\n${body}\n</rbl:kb>\n`;

/** Offset of the first character inside the quotes of `attr="value"`, as written in `text`. */
const inside = (text: string, attrText: string): number => {
  const at = text.indexOf(attrText);
  assert.ok(at >= 0, `snippet not found: ${attrText}`);
  return at + attrText.indexOf('"') + 1;
};

const slices = (text: string, spans: Span[]): string[] => spans.map((s) => text.slice(s.start, s.end));
const count = (text: string, needle: string): number => text.split(needle).length - 1;

const MAP = wrap(`
  <concept name="Person" type="string"/>
  <concept name="Country" type="string"/>
  <concept name="Team" type="string"/>
  <concept name="Age" type="number"/>
  <concept name="Postcode" type="string">
    <datasource hostname="https://api.example.com" path="/lookup">
      <input rel="has postcode" subject="%S"/>
      <action map="lives in=/Response/Country"/>
    </datasource>
  </concept>

  <concinst name="Julio" type="Person"/>
  <concinst name="France" type="Country"/>
  <concinst name="France" type="Team"/>

  <rel name="lives in" subject="Person" object="Country"/>
  <rel name="supports" subject="Person" object="Team"/>
  <rel name="has age" subject="Person" object="Age"/>
  <rel name="has postcode" subject="Person" object="Postcode"/>
  <rel name="has score" subject="Person" object="Age"/>

  <relinst type="lives in" subject="Julio" object="France"/>
  <relinst type="supports" subject="Julio" object="France"/>
  <relinst type="has age" subject="Julio" object="42"/>

  <relinst type="has score" subject="%S" object="%O" alt="{{%S}} scored via {{%S.lives in}}">
    <condition rel="has age" subject="%S" object="%AGE"/>
    <condition expression="countRelationshipInstances(%S, 'lives in', *) + %AGE" value="%O"/>
  </relinst>
`);

describe("symbols: resolution", () => {
  test("a declaration name resolves as a declaration, a reference does not", () => {
    const decl = symbolAt(MAP, inside(MAP, 'concept name="Person"')).hit;
    assert.deepEqual([decl?.kind, decl?.name, decl?.declaration], ["concept", "Person", true]);
    const ref = symbolAt(MAP, inside(MAP, 'rel name="lives in" subject="Person"') + 'rel name="lives in" '.length).hit;
    assert.deepEqual([ref?.kind, ref?.name, ref?.declaration], ["concept", "Person", false]);
  });

  test("variables, plain literals and text outside tags are not symbols", () => {
    assert.equal(symbolAt(MAP, inside(MAP, 'subject="%S" object="%AGE"')).hit, undefined);
    assert.equal(symbolAt(MAP, inside(MAP, 'object="42"')).hit, undefined);
    assert.equal(symbolAt(MAP, MAP.indexOf("<concept") - 1).hit, undefined);
  });

  test("a name embedded in a longer attribute value wins over the whole value", () => {
    const hit = symbolAt(MAP, inside(MAP, "'lives in'") + 1).hit;
    assert.deepEqual([hit?.kind, hit?.name], ["rel", "lives in"]);
    const alt = symbolAt(MAP, MAP.indexOf("{{%S.lives in}}") + "{{%S.".length).hit;
    assert.deepEqual([alt?.kind, alt?.name], ["rel", "lives in"]);
  });
});

describe("symbols: linked editing", () => {
  test("a concept declaration links to every subject, object and instance type", () => {
    const linked = linkedSpans(MAP, inside(MAP, 'concept name="Person"'));
    assert.ok(linked);
    assert.equal(linked.spans.length, count(MAP, '"Person"'));
    assert.equal(linked.spans.length, 7);
    for (const s of slices(MAP, linked.spans)) assert.equal(s, "Person");
  });

  test("a relationship declaration links into facts, evidence text, expressions and datasource maps", () => {
    const linked = linkedSpans(MAP, inside(MAP, 'rel name="lives in"'));
    assert.ok(linked);
    // declaration, relinst type, action map key, {{%S.lives in}}, 'lives in'
    assert.equal(linked.spans.length, 5);
    for (const s of slices(MAP, linked.spans)) assert.equal(s, "lives in");
    const starts = linked.spans.map((s) => s.start);
    assert.ok(starts.includes(MAP.indexOf("lives in=/Response")));
    assert.ok(starts.includes(MAP.indexOf("{{%S.lives in}}") + "{{%S.".length));
    assert.ok(starts.includes(MAP.indexOf("'lives in'") + 1));
  });

  test("references do not start a linked edit", () => {
    const relSubject = inside(MAP, 'rel name="lives in" subject="Person"') + 'rel name="lives in" '.length;
    assert.equal(linkedSpans(MAP, relSubject), undefined);
    assert.equal(linkedSpans(MAP, inside(MAP, 'relinst type="lives in"')), undefined);
    assert.equal(linkedSpans(MAP, inside(MAP, 'concinst name="Julio" type="Person"') + 'concinst name="Julio" '.length), undefined);
    assert.equal(linkedSpans(MAP, inside(MAP, 'subject="%S" object="%AGE"')), undefined);
  });

  test("an instance declaration links only to mentions under its own concept", () => {
    const team = linkedSpans(MAP, inside(MAP, 'concinst name="France" type="Team"'));
    assert.ok(team);
    assert.equal(team.spans.length, 2);
    const teamStarts = team.spans.map((s) => s.start);
    assert.ok(teamStarts.includes(MAP.indexOf('<relinst type="supports"') + '<relinst type="supports" subject="Julio" object="'.length));
    assert.ok(!teamStarts.includes(MAP.indexOf('<relinst type="lives in"') + '<relinst type="lives in" subject="Julio" object="'.length));

    const country = linkedSpans(MAP, inside(MAP, 'concinst name="France" type="Country"'));
    assert.ok(country);
    assert.equal(country.spans.length, 2);
    assert.ok(country.spans.map((s) => s.start).includes(MAP.indexOf('<relinst type="lives in"') + '<relinst type="lives in" subject="Julio" object="'.length));
  });

  test("a span whose text is not the name verbatim is left out of linked editing but still renamed", () => {
    const map = wrap(`
      <concept name="Person" type="string"/>
      <concept name="Status" type="string"/>
      <concinst name="Retired's" type="Status"/>
      <rel name="has status" subject="Person" object="Status"/>
      <rel name="is done" subject="Person" object="Status"/>
      <relinst type="is done" subject="%S" object="%O">
        <condition rel="has status" subject="%S" object="%ST"/>
        <condition expression="%ST is 'Retired\\'s'" value="%O"/>
      </relinst>
    `);
    const linked = linkedSpans(map, inside(map, `concinst name="Retired's"`));
    assert.ok(linked);
    assert.equal(linked.spans.length, 1);

    const edits = renameEdits(map, inside(map, `concinst name="Retired's"`), "Veteran");
    assert.ok(edits);
    assert.equal(edits.length, 2);
    const renamed = applyEdits(map, edits);
    assert.ok(renamed.includes(`<concinst name="Veteran"`));
    assert.ok(renamed.includes(`%ST is 'Veteran'`));
  });
});

describe("symbols: rename", () => {
  test("renaming an instance from a fact stays within the concept that fact expects", () => {
    const offset = MAP.indexOf('<relinst type="supports"') + '<relinst type="supports" subject="Julio" object="'.length;
    const edits = renameEdits(MAP, offset, "Lyon");
    assert.ok(edits);
    assert.equal(edits.length, 2);
    const renamed = applyEdits(MAP, edits);
    assert.ok(renamed.includes('<concinst name="Lyon" type="Team"/>'));
    assert.ok(renamed.includes('<concinst name="France" type="Country"/>'));
    assert.ok(renamed.includes('<relinst type="lives in" subject="Julio" object="France"/>'));
    assert.ok(renamed.includes('<relinst type="supports" subject="Julio" object="Lyon"/>'));
  });

  test("invalid new names are rejected", () => {
    const at = inside(MAP, 'concept name="Person"');
    assert.throws(() => renameEdits(MAP, at, ""), /empty/);
    assert.throws(() => renameEdits(MAP, at, 'Per"son'), /cannot contain/);
    assert.throws(() => renameEdits(MAP, at, "Per<son"), /cannot contain/);
    assert.equal(renameEdits(MAP, inside(MAP, 'object="42"'), "x"), undefined);
  });

  test("find-references and rename agree on the set of spans", () => {
    const at = inside(MAP, 'rel name="has age"');
    const found = spansAt(MAP, at);
    const edits = renameEdits(MAP, at, "is aged");
    assert.ok(found && edits);
    assert.deepEqual(edits.map((e) => e.start), found.spans.map((s) => s.start));
    assert.equal(found.spans.length, 3); // rel, relinst type, condition rel
  });

  test("renaming through hello-world.rbl leaves a map with no errors and no trace of the old names", () => {
    const file = path.join(__dirname, "..", "..", "examples", "hello-world.rbl");
    let text = fs.readFileSync(file, "utf8");
    text = applyEdits(text, renameEdits(text, inside(text, 'concept name="Person"'), "Human")!);
    text = applyEdits(text, renameEdits(text, inside(text, 'rel name="lives in"'), "resides in")!);
    text = applyEdits(text, renameEdits(text, inside(text, 'concinst name="France"'), "Republic of France")!);
    assert.equal(count(text, '"Person"'), 0);
    assert.equal(count(text, "lives in"), 1); // only the free-text evidence "{{%S}} lives in {{%COUNTRY}}" stays
    assert.equal(count(text, '"France"'), 0);
    assert.ok(text.includes('<relinst type="national language" subject="Republic of France" object="French"'));
    const errors = collectIssues(text).filter((i) => i.severity === "error");
    assert.deepEqual(errors.map((e) => e.message), []);
  });
});
