/**
 * The edit engine on the real example maps: placement, selectors, attribute
 * edits, atomicity, snippet linting and the minimal-edit computation.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { applyOperations, EditError, resolveSelector, reindentFragment, computeMinimalEdit, lintSnippet, diagnosticsDelta, describeEdit, modelChanges } from "../mapEdits";
import { buildIndex } from "../mapIndex";
import { collectIssues } from "../lint";

const examples = path.join(__dirname, "..", "..", "examples");
const hello = fs.readFileSync(path.join(examples, "hello-world.rbl"), "utf8"); // tab-indented
const spaced = hello.replace(/^\t+/gm, (m) => "  ".repeat(m.length)); // 2-space variant

const noErrors = (text: string) => assert.deepEqual(collectIssues(text).filter((i) => i.severity === "error").map((i) => i.message), []);
const lineOf = (text: string, needle: string) => text.slice(0, text.indexOf(needle)).split("\n").length;

describe("mapEdits: insert_element", () => {
  test("a concept goes after the last concept with the file's indentation (tabs)", () => {
    const out = applyOperations(hello, [{ op: "insert_element", kind: "concept", xml: '<concept name="City" type="string"/>' }]);
    const lines = out.text.split("\n");
    const at = lineOf(out.text, '<concept name="City"');
    assert.equal(lines[at - 1], '\t<concept name="City" type="string"/>');
    assert.equal(lines[at - 2], '\t<concept name="Language" type="string"/>');
    assert.match(out.summaries[0], /^1\. insert_element concept: "City" → L\d+$/);
    noErrors(out.text);
  });

  test("uses two-space indentation when the file does", () => {
    const out = applyOperations(spaced, [{ op: "insert_element", kind: "concept", xml: '<concept name="City" type="string"/>' }]);
    assert.ok(out.text.includes('\n  <concept name="City" type="string"/>\n'));
  });

  test("a rule is re-indented (nested lines get one more level) and placed after the last rule", () => {
    const xml = `<relinst type="speaks" cf="60" name="Speaks French if lives in France">
    <condition rel="lives in" subject="%S" object="France"/>
    <condition expression="'French'" value="%O"/>
</relinst>`;
    const out = applyOperations(hello, [{ op: "insert_element", kind: "rule", xml }]);
    const idx = out.text.indexOf('<relinst type="speaks" cf="60"');
    assert.ok(idx > out.text.indexOf("Speaks national language"), "placed after the existing rule");
    const block = out.text.slice(idx, out.text.indexOf("</relinst>", idx) + "</relinst>".length);
    assert.deepEqual(block.split("\n").slice(1), [
      '\t\t<condition rel="lives in" subject="%S" object="France"/>',
      "\t\t<condition expression=\"'French'\" value=\"%O\"/>",
      "\t</relinst>",
    ]);
    noErrors(out.text);
  });

  test("facts group with facts of the same relationship; instances with the same concept", () => {
    const fact = applyOperations(hello, [{ op: "insert_element", kind: "fact", xml: '<relinst type="national language" subject="Spain" object="Spanish" cf="100"/>' }]);
    assert.equal(lineOf(fact.text, 'subject="Spain"'), lineOf(fact.text, 'subject="France" object="French"') + 1);
    const inst = applyOperations(hello, [{ op: "insert_element", kind: "concinst", xml: '<concinst name="Spain" type="Country"/>' }]);
    assert.equal(lineOf(inst.text, 'name="Spain"'), lineOf(inst.text, 'name="France" type="Country"') + 1);
  });

  test("after= places the element right after the anchor", () => {
    const out = applyOperations(hello, [{ op: "insert_element", kind: "rel", xml: '<rel name="has lived in" subject="Person" object="Country" plural="true" askable="none"/>', after: { kind: "rel", name: "lives in" } }]);
    assert.ok(out.text.includes('</rel>\n\t<rel name="has lived in" subject="Person" object="Country" plural="true" askable="none"/>\n\t<rel name="national language"'));
  });

  test("an empty document gets the skeleton first", () => {
    const out = applyOperations("", [{ op: "insert_element", kind: "concept", xml: '<concept name="A" type="string"/>' }]);
    assert.match(out.text, /^<\?xml version="1.0" encoding="utf-8"\?>\n<rbl:kb xmlns:rbl="http:\/\/rbl.io\/schema\/RBLang">\n\t<concept name="A" type="string"\/>\n<\/rbl:kb>\n$/);
  });

  test("kind mismatch, malformed xml and stray text are refused", () => {
    assert.throws(() => applyOperations(hello, [{ op: "insert_element", kind: "concept", xml: '<rel name="x" subject="Person" object="Person"/>' }]), /kind is "concept" but the xml contains a relationship/);
    assert.throws(() => applyOperations(hello, [{ op: "insert_element", kind: "concept", xml: '<concept name="X type="string"/>' }]), /parsed|malformed|Unbalanced/);
    assert.throws(() => applyOperations(hello, [{ op: "insert_element", kind: "concept", xml: 'hello <concept name="X" type="string"/>' }]), /text outside/);
    assert.throws(() => applyOperations(hello, [{ op: "insert_element", kind: "rule", xml: '<relinst type="speaks" subject="Julio" object="French"/>' }]), /kind is "rule" but the xml contains a fact/);
  });
});

describe("mapEdits: selectors", () => {
  const index = buildIndex(hello);

  test("resolve by kind + name, by rel + subject + object, and by line", () => {
    assert.equal(resolveSelector(hello, index, { kind: "rule", name: "Speaks national language of home country" }).tag.attrs.type, "speaks");
    assert.equal(resolveSelector(hello, index, { kind: "fact", rel: "national language", subject: "France" }).tag.attrs.object, "French");
    assert.equal(resolveSelector(hello, index, { name: "lives in" }).tag.name, "rel");
    const cond = resolveSelector(hello, index, { line: lineOf(hello, '<condition rel="national language"') });
    assert.equal(cond.tag.name, "condition");
    assert.equal(cond.depth, 2);
    assert.equal(cond.topLevel, false);
  });

  test("case-insensitive fallback", () => {
    assert.equal(resolveSelector(hello, index, { kind: "concept", name: "person" }).tag.attrs.name, "Person");
  });

  test("no match lists what exists; several matches ask for disambiguation", () => {
    assert.throws(() => resolveSelector(hello, index, { kind: "rule", name: "Nope" }), (e: Error) => e instanceof EditError && /No rule matches .*Available: rule "Speaks national language of home country" speaks \(L31–35\)/.test(e.message));
    assert.throws(() => resolveSelector(hello, index, { kind: "fact", rel: "national language" }), /2 elements match .*fact England national language English \(L27\); fact France national language French \(L28\)\. Add name, subject, object or line/);
    assert.throws(() => resolveSelector(hello, index, { line: 2000 }), /Nothing starts on line 2000/);
    assert.throws(() => resolveSelector(hello, index, { kind: "concinst", name: "Nope" }), /Available: instance "Julio" of Person/);
  });
});

describe("mapEdits: replace, delete, set_attribute, replace_text", () => {
  test("replace_element by name keeps indentation and can produce several elements", () => {
    const out = applyOperations(hello, [{ op: "replace_element", selector: { kind: "fact", rel: "national language", subject: "France" }, xml: '<relinst type="national language" subject="France" object="French" cf="90"/>\n<relinst type="national language" subject="Spain" object="French" cf="10"/>' }]);
    assert.ok(out.text.includes('\t<relinst type="national language" subject="France" object="French" cf="90"/>\n\t<relinst type="national language" subject="Spain" object="French" cf="10"/>\n'));
    assert.match(out.summaries[0], /replace_element fact France national language French \(L28\) → "national language", "national language"/);
  });

  test("replace_element of a nested condition re-indents at its depth", () => {
    const line = lineOf(hello, '<condition rel="national language"');
    const out = applyOperations(hello, [{ op: "replace_element", selector: { line }, xml: '<condition rel="national language" subject="%COUNTRY" object="%O" weight="50"/>' }]);
    assert.ok(out.text.includes('\n\t\t<condition rel="national language" subject="%COUNTRY" object="%O" weight="50"/>\n'));
  });

  test("delete_element removes the whole line without leaving a blank artefact", () => {
    const out = applyOperations(hello, [{ op: "delete_element", selector: { kind: "fact", rel: "national language", subject: "France" } }]);
    assert.ok(!out.text.includes('subject="France" object="French"'));
    assert.ok(out.text.includes('subject="England" object="English" cf="100"/>\n\n\t<!-- Rule:'), "no blank line left where the fact was");
    assert.equal(out.text.split("\n").length, hello.split("\n").length - 1);
    const rule = applyOperations(hello, [{ op: "delete_element", selector: { kind: "rule", name: "Speaks national language of home country" } }]);
    assert.ok(!rule.text.includes("<condition"));
    noErrors(rule.text);
  });

  test("set_attribute changes, adds, removes, escapes, validates enums and names", () => {
    const changed = applyOperations(hello, [{ op: "set_attribute", selector: { kind: "rule", name: "Speaks national language of home country" }, attr: "cf", value: "90" }]);
    assert.ok(changed.text.includes('<relinst type="speaks" cf="90" name="Speaks'));
    assert.match(changed.summaries[0], /set_attribute cf on rule .*: "75" → "90"/);

    const added = applyOperations(hello, [{ op: "set_attribute", selector: { kind: "rel", name: "national language" }, attr: "plural", value: "true" }]);
    assert.ok(added.text.includes('<rel name="national language" subject="Country" object="Language" askable="none" plural="true"/>'));

    const removed = applyOperations(hello, [{ op: "set_attribute", selector: { kind: "rel", name: "speaks" }, attr: "plural", value: null }]);
    assert.ok(removed.text.includes('<rel name="speaks" subject="Person" object="Language" askable="all">'));

    const escaped = applyOperations(hello, [{ op: "set_attribute", selector: { kind: "rule", name: "Speaks national language of home country" }, attr: "alt", value: 'Says "hi" & <bye>' }]);
    assert.ok(escaped.text.includes('alt="Says &quot;hi&quot; &amp; &lt;bye>"'));

    const line = lineOf(hello, '<condition rel="lives in"');
    const cond = applyOperations(hello, [{ op: "set_attribute", selector: { line }, attr: "weight", value: "50" }]);
    assert.ok(cond.text.includes('<condition rel="lives in" subject="%S" object="%COUNTRY" weight="50" behaviour="mandatory"/>'));

    assert.throws(() => applyOperations(hello, [{ op: "set_attribute", selector: { kind: "concept", name: "Person" }, attr: "colour", value: "red" }]), /<concept> has no attribute "colour"\. Allowed: name, type, scope, behaviour/);
    assert.throws(() => applyOperations(hello, [{ op: "set_attribute", selector: { kind: "concept", name: "Person" }, attr: "type", value: "text" }]), /expected one of string, number, date, truth/);
    assert.throws(() => applyOperations(hello, [{ op: "set_attribute", selector: { kind: "concept", name: "Person" }, attr: "type", value: null }]), /required .* cannot be removed/);
  });

  test("replace_text requires exactly one match", () => {
    const out = applyOperations(hello, [{ op: "replace_text", old_text: "who speaks what?", new_text: "who speaks which language?" }]);
    assert.ok(out.text.includes("who speaks which language?"));
    assert.throws(() => applyOperations(hello, [{ op: "replace_text", old_text: "nowhere to be found", new_text: "x" }]), /not found/);
    assert.throws(() => applyOperations(hello, [{ op: "replace_text", old_text: 'cf="100"', new_text: 'cf="90"' }]), /matches 2 times/);
  });

  test("operations chain: later selectors resolve against the updated text; failure applies nothing", () => {
    const out = applyOperations(hello, [
      { op: "insert_element", kind: "concept", xml: '<concept name="City" type="string"/>' },
      { op: "insert_element", kind: "rel", xml: '<rel name="lives in city" subject="Person" object="City" askable="secondFormObject"><secondFormObject>Which city does %S live in?</secondFormObject></rel>' },
      { op: "set_attribute", selector: { kind: "rel", name: "lives in city" }, attr: "plural", value: "false" },
      { op: "set_attribute", selector: { kind: "rule", name: "Speaks national language of home country" }, attr: "cf", value: "80" },
    ]);
    assert.equal(out.summaries.length, 4);
    assert.ok(out.text.includes('askable="secondFormObject" plural="false">'));
    assert.ok(out.text.includes('cf="80"'));
    noErrors(out.text);

    assert.throws(
      () => applyOperations(hello, [
        { op: "set_attribute", selector: { kind: "rule", name: "Speaks national language of home country" }, attr: "cf", value: "80" },
        { op: "delete_element", selector: { kind: "rule", name: "Missing" } },
      ]),
      /Operation 2 \(delete_element\) failed: No rule matches .* Nothing was applied\./
    );
  });
});

describe("mapEdits: helpers", () => {
  test("reindentFragment strips common indentation and re-applies the unit at depth", () => {
    assert.equal(reindentFragment("    <a>\n        <b/>\n    </a>", "\t", 1), "<a>\n\t\t<b/>\n\t</a>");
    assert.equal(reindentFragment("\n<a>\n\t<b/>\n</a>\n\n", "  ", 2), "<a>\n      <b/>\n    </a>");
  });

  test("computeMinimalEdit isolates the changed range", () => {
    const e = computeMinimalEdit("abc def ghi", "abc XYZ ghi");
    assert.deepEqual(e, { start: 4, end: 7, newText: "XYZ" });
    const same = computeMinimalEdit("abc", "abc");
    assert.equal(same.newText, "");
    assert.equal(same.start, same.end);
  });

  test("lintSnippet hides host noise and keeps fragment findings with fragment-relative lines", () => {
    const clean = lintSnippet('<relinst type="speaks" cf="50">\n  <condition rel="lives in" subject="%S" object="France"/>\n  <condition expression="\'French\'" value="%O"/>\n</relinst>', hello);
    assert.deepEqual(clean.filter((i) => i.severity === "error"), []);
    const broken = lintSnippet('<relinst type="speaks" cf="50">\n  <condition rel="lives at" subject="%S" object="France"/>\n</relinst>', hello);
    const errors = broken.filter((i) => i.severity === "error");
    assert.equal(errors.length, 1);
    assert.match(errors[0].message, /Unknown relationship in condition: "lives at"/);
    assert.equal(errors[0].line, 1);
    // Without a host, the skeleton is used: unknown relationships are real errors, structure is not.
    const alone = lintSnippet('<concept name="A" type="string"/>');
    assert.deepEqual(alone.filter((i) => i.severity === "error"), []);
  });

  test("diagnosticsDelta matches by message so line shifts do not count", () => {
    const before = collectIssues(hello.replace('object="Language" plural', 'object="Languag" plural'));
    const after = collectIssues("\n\n" + hello);
    const d = diagnosticsDelta(before, after);
    assert.deepEqual(d.introduced, []);
    assert.equal(d.fixed.length, 1);
    assert.match(d.fixed[0].message, /Unknown concept in object/);
  });

  test("describeEdit reports operations, diagnostics delta, model changes and the changed region", () => {
    const out = applyOperations(hello, [{ op: "set_attribute", selector: { kind: "rule", name: "Speaks national language of home country" }, attr: "cf", value: "90" }]);
    const text = describeEdit("hello-world.rbl", hello, out, collectIssues(hello), collectIssues(out.text));
    assert.match(text, /^Applied 1 operation to hello-world.rbl \(now \d+ lines\)\./);
    assert.match(text, /Diagnostics: 0 errors, 0 warnings, 0 hints \(was 0 errors, 0 warnings, 0 hints\)\./);
    assert.match(text, /Model changes:\n  ~ Speaks national language of home country: cf 75 → 90/);
    assert.match(text, /Changed region \(L30–32\):\n30 \| /);
    assert.deepEqual(modelChanges(hello, hello), []);
  });
});
