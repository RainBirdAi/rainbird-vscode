/**
 * Unit tests for the pure authoring helpers (authoringModel.ts) used by the
 * editor commands — here relationshipAt, which picks the goal to preselect
 * when the query panel opens from the editor. Runs under plain node (`npm test`).
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { relationshipAt } from "../authoringModel";
import { buildIndex } from "../mapIndex";

const examples = path.join(__dirname, "..", "..", "examples");
const read = (name: string): string => fs.readFileSync(path.join(examples, name), "utf8");

const wrap = (body: string): string =>
  `<?xml version="1.0" encoding="utf-8"?>\n<rbl:kb xmlns:rbl="http://rbl.io/schema/RBLang">\n${body}\n</rbl:kb>\n`;

/** Offset of `snippet` in `text` (asserting it is there and unique), plus `delta`. */
const offsetOf = (text: string, snippet: string, delta = 0): number => {
  const at = text.indexOf(snippet);
  assert.ok(at >= 0, `snippet not found: ${snippet}`);
  assert.equal(text.indexOf(snippet, at + 1), -1, `snippet not unique: ${snippet}`);
  return at + delta;
};

describe("relationshipAt: examples/hello-world.rbl", () => {
  const hello = read("hello-world.rbl");
  const index = buildIndex(hello);
  const at = (snippet: string, delta = 0): string | undefined => relationshipAt(index, offsetOf(hello, snippet, delta));

  test("inside a <rel> declaration, wording included → its name", () => {
    assert.equal(at('<rel name="speaks"'), "speaks", "on the opening <");
    assert.equal(at('name="speaks"', 8), "speaks");
    assert.equal(at("<firstForm>Does %S speak %O?"), "speaks");
    assert.equal(at("Which languages does %S speak?", 6), "speaks");
    assert.equal(at("</secondFormSubject>\n\t</rel>", 23), "speaks", "on the closing </rel>");
    assert.equal(at("Which country does %S live in?", 3), "lives in");
    assert.equal(at('<rel name="national language"', 40), "national language", "self-closing declaration");
  });

  test("the element's extent is inclusive at both ends, like ruleAt", () => {
    const start = offsetOf(hello, '<rel name="speaks"');
    const close = "</secondFormSubject>\n\t</rel>";
    const end = offsetOf(hello, close, close.length);
    assert.equal(relationshipAt(index, start), "speaks");
    assert.equal(relationshipAt(index, end), "speaks", "just past the closing >");
    assert.equal(relationshipAt(index, start - 1), undefined, "the indentation before it");
    assert.equal(relationshipAt(index, end + 1), undefined, "the indentation after it");
  });

  test("inside a fact → its type", () => {
    assert.equal(at('<relinst type="national language" subject="England"', 45), "national language");
    assert.equal(at('subject="France" object="French"', 3), "national language");
  });

  test("inside a rule but not on a condition → the relationship it infers", () => {
    assert.equal(at('<relinst type="speaks" cf="75"'), "speaks");
    assert.equal(at('name="Speaks national language of home country"', 10), "speaks");
    assert.equal(at('alt="{{%S}} lives in {{%COUNTRY}}', 13), "speaks", "relationship names in alt text do not count");
    assert.equal(at("</relinst>"), "speaks");
  });

  test("on a <condition …> → still the relationship the rule infers", () => {
    assert.equal(at('<condition rel="lives in"'), "speaks", "not the relationship the condition reads");
    assert.equal(at('object="%COUNTRY" weight="100"', 4), "speaks", "anywhere in the condition tag");
    assert.equal(at('<condition rel="national language"', 20), "speaks", "on the name of the relationship it reads");
    // Either side of the first condition's end: just past its "/>", and the indentation after it.
    const firstEnd = offsetOf(hello, 'object="%COUNTRY" weight="100" behaviour="mandatory"/>', 'object="%COUNTRY" weight="100" behaviour="mandatory"/>'.length);
    assert.equal(relationshipAt(index, firstEnd), "speaks", "just past the condition's />");
    assert.equal(relationshipAt(index, firstEnd + 1), "speaks", "the indentation after it");
  });

  test("undefined outside relationships, rules and facts", () => {
    assert.equal(at('<concept name="Person"', 5), undefined, "concept");
    assert.equal(at('<concinst name="Julio"', 5), undefined, "instance");
    assert.equal(at("The classic Rainbird Hello World"), undefined, "comment between elements");
    assert.equal(at("Rule: people probably speak"), undefined, "a comment that mentions a relationship");
    assert.equal(at("<rbl:kb", 3), undefined, "root tag");
    assert.equal(relationshipAt(index, 0), undefined, "XML prolog");
    assert.equal(relationshipAt(index, hello.length), undefined, "end of file");
    assert.equal(relationshipAt(index, hello.length + 50), undefined, "past the end");
  });
});

describe("relationshipAt: other maps", () => {
  test("eligibility: every condition belongs to its rule, relationship and expression conditions alike", () => {
    const text = read("eligibility.rbl");
    const index = buildIndex(text);
    const at = (snippet: string, delta = 0): string | undefined => relationshipAt(index, offsetOf(text, snippet, delta));
    assert.equal(at('<condition rel="has date of birth"', 12), "has age", "a relationship condition: the rule's, not its own");
    assert.equal(at('<condition expression="yearsBetween(%DOB, today())"', 30), "has age");
    assert.equal(at('<relinst type="has eligibility" object="Eligible"', 40), "has eligibility");
    assert.equal(at('<condition expression="%AGE is greater than or equal to 18"', 25), "has eligibility");
    assert.equal(at('<rel name="has age"', 8), "has age");
  });

  test("returns a relinst's type as written, even when it is not declared", () => {
    const text = wrap(`  <relinst type="speks" subject="Ann" object="French"/>`);
    assert.equal(relationshipAt(buildIndex(text), offsetOf(text, 'type="speks"', 7)), "speks");
  });

  test("undefined where the tag naming the relationship did not parse cleanly", () => {
    const text = wrap(`  <rel name="broken" subject=A object="B"/>
  <relinst type="speaks" cf=75>
    <condition rel="lives in" subject="%S" object="%C" weight="100"/>
    <condition rel="national language" subject=%C object="%O" weight="100"/>
  </relinst>
  <relinst subject="Ann" object="French"/>`);
    const index = buildIndex(text);
    const at = (snippet: string, delta = 0): string | undefined => relationshipAt(index, offsetOf(text, snippet, delta));
    assert.equal(at('<rel name="broken"', 3), undefined, "malformed <rel>");
    assert.equal(at('<relinst type="speaks" cf=75>', 3), undefined, "malformed rule head");
    assert.equal(at('<condition rel="lives in"', 3), undefined, "a clean condition inside it belongs to the malformed head too");
    assert.equal(at('<condition rel="national language"', 3), undefined, "a malformed condition resolves to its rule's (malformed) head");
    assert.equal(at('<relinst subject="Ann"', 3), undefined, "relinst without a type");
  });

  test("a malformed condition in a clean rule resolves to the rule's relationship", () => {
    const text = wrap(`  <relinst type="speaks" cf="75">
    <condition rel="lives in" subject=%S object="%C" weight="100"/>
  </relinst>`);
    assert.equal(relationshipAt(buildIndex(text), offsetOf(text, 'rel="lives in"', 5)), "speaks");
  });

  test("relationships mentioned inside a concept (datasource input) are not goals", () => {
    const text = wrap(`  <concept name="Postcode" type="string">
    <datasource hostname="https://api.example.com" path="/lookup">
      <input rel="has postcode" subject="%S"/>
    </datasource>
  </concept>`);
    assert.equal(relationshipAt(buildIndex(text), offsetOf(text, 'rel="has postcode"', 5)), undefined);
  });
});
