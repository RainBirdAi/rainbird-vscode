/**
 * Unit tests for the editor-agnostic linter core (lint.ts). Runs under plain
 * node (`npm test`): no VS Code host needed. Each case is a small RBLang
 * snippet with the findings it must (or must not) produce; the example maps
 * in examples/ double as a regression corpus that must stay error-free.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { collectIssues, literalMatchesType, LintFix, LintIssue } from "../lint";

const wrap = (body: string): string =>
  `<?xml version="1.0" encoding="UTF-8"?>\n<rbl:kb xmlns:rbl="http://rbl.io/schema/RBLang">\n${body}\n</rbl:kb>\n`;

const lint = (body: string): LintIssue[] => collectIssues(wrap(body));
const ofSeverity = (issues: LintIssue[], severity: LintIssue["severity"]): string[] =>
  issues.filter((i) => i.severity === severity).map((i) => i.message);
const errors = (body: string): string[] => ofSeverity(lint(body), "error");
const warnings = (body: string): string[] => ofSeverity(lint(body), "warning");
const infos = (body: string): string[] => ofSeverity(lint(body), "info");

const some = (messages: string[], re: RegExp): boolean => messages.some((m) => re.test(m));
const assertHas = (messages: string[], re: RegExp): void =>
  assert.ok(some(messages, re), `expected a message matching ${re}\n  got: ${JSON.stringify(messages, null, 2)}`);
const assertNone = (messages: string[], re: RegExp): void =>
  assert.ok(!some(messages, re), `expected no message matching ${re}\n  got: ${JSON.stringify(messages, null, 2)}`);

/** Apply a fix's edits (offsets into `text`) — highest offset first so earlier offsets stay valid. */
const applyFix = (text: string, fix: LintFix): string => {
  let out = text;
  for (const e of [...fix.edits].sort((a, b) => b.start - a.start)) out = out.slice(0, e.start) + e.newText + out.slice(e.end);
  return out;
};

const BASE = `
  <concept name="Person" type="string"/>
  <concept name="Country" type="string"/>
  <concept name="Age" type="number"/>
  <concept name="Birthday" type="date"/>
  <concept name="Resident" type="truth"/>
  <concinst name="Julio" type="Person"/>
  <concinst name="France" type="Country"/>
  <rel name="lives in" subject="Person" object="Country"/>
  <rel name="has age" subject="Person" object="Age"/>
  <rel name="was born on" subject="Person" object="Birthday"/>
  <rel name="is resident" subject="Person" object="Resident"/>
`;

describe("clean maps", () => {
  test("a well-formed map has no errors or warnings", () => {
    const issues = lint(`${BASE}<relinst type="lives in" subject="Julio" object="France"/>`);
    assert.deepEqual(ofSeverity(issues, "error"), []);
    assert.deepEqual(ofSeverity(issues, "warning"), []);
  });

  test("the example maps stay free of errors", () => {
    const dir = path.join(__dirname, "..", "..", "examples");
    const files = fs.readdirSync(dir).filter((f) => f.endsWith(".rbl"));
    assert.ok(files.length > 0, "no example maps found");
    for (const file of files) {
      const issues = collectIssues(fs.readFileSync(path.join(dir, file), "utf8"));
      assert.deepEqual(ofSeverity(issues, "error"), [], `${file} has errors`);
    }
  });
});

describe("instance identity is name + concept", () => {
  test("the same name under two concepts is two instances, not a duplicate", () => {
    const body = `${BASE}
      <concept name="Team" type="string"/>
      <concinst name="France" type="Team"/>
      <rel name="supports" subject="Person" object="Team"/>
      <relinst type="lives in" subject="Julio" object="France"/>
      <relinst type="supports" subject="Julio" object="France"/>`;
    const issues = lint(body);
    assert.deepEqual(ofSeverity(issues, "error"), []);
    assert.deepEqual(ofSeverity(issues, "warning"), []);
  });

  test("an exact repeat is a duplicate instance warning", () => {
    const w = warnings(`${BASE}<concinst name="France" type="Country"/>`);
    assertHas(w, /Duplicate concept instance: "France" of "Country"/);
  });

  test("an instance of another concept on the wrong side is a warning naming its concepts", () => {
    const w = warnings(`${BASE}
      <concept name="Team" type="string"/>
      <concinst name="Lyon" type="Team"/>
      <rel name="supports" subject="Person" object="Team"/>
      <relinst type="lives in" subject="Julio" object="Lyon"/>`);
    assertHas(w, /"Lyon" is an instance of "Team", but object of this relationship must be a "Country"/);
  });
});

describe("concept types", () => {
  test("boolean is accepted as a legacy spelling of truth, with a rename fix", () => {
    const text = wrap(`<concept name="Flag" type="boolean"/>\n<rel name="has flag" subject="Flag" object="Flag"/>`);
    const issues = collectIssues(text);
    assertNone(ofSeverity(issues, "error"), /invalid value for attribute: type/);
    const hint = issues.find((i) => /legacy spelling of "truth"/.test(i.message));
    assert.ok(hint?.fixes?.length, "expected a hint with a fix");
    const fixed = applyFix(text, hint!.fixes![0]);
    assert.match(fixed, /type="truth"/);
    assertNone(collectIssues(fixed).map((i) => i.message), /legacy spelling/);
  });

  test("boolean literals are validated like truth", () => {
    const body = `${BASE}
      <concept name="Flag" type="boolean"/>
      <rel name="has flag" subject="Person" object="Flag"/>`;
    assert.deepEqual(errors(`${body}<relinst type="has flag" subject="Julio" object="true"/>`), []);
    assertHas(errors(`${body}<relinst type="has flag" subject="Julio" object="TRUE"/>`), /Relationship "has flag" must have true or false as its object/);
  });
});

describe("typed literals follow the platform's rules (stricter than Studio's linter)", () => {
  test("dates: ISO-8601 or epoch milliseconds only", () => {
    for (const ok of ["2026-09-10", "2026-09-10T12:00:00Z", "2026-09-10T12:00:00.000+01:00", "1725926400000", "0"]) {
      assert.ok(literalMatchesType(ok, "date"), `${ok} should be a valid date`);
    }
    for (const bad of ["10 September 2026", "09/10/2026", "2026-13-45", "someday", ""]) {
      assert.ok(!literalMatchesType(bad, "date"), `${bad} should not be a valid date`);
    }
  });

  test("numbers: anything Number() accepts, within 15 digits", () => {
    for (const ok of ["42", "-3.5", "1e3", "999999999999999"]) assert.ok(literalMatchesType(ok, "number"), `${ok} should be a valid number`);
    for (const bad of ["abc", "", "1,000", "1000000000000000"]) assert.ok(!literalMatchesType(bad, "number"), `${bad} should not be a valid number`);
  });

  test("truth: exactly true or false, lower-case", () => {
    for (const ok of ["true", "false"]) assert.ok(literalMatchesType(ok, "truth"));
    for (const bad of ["TRUE", "False", "yes", "1"]) assert.ok(!literalMatchesType(bad, "truth"), `${bad} should not be a valid truth`);
  });

  test("rejected literals are reported in the platform's own words", () => {
    assertHas(errors(`${BASE}<relinst type="was born on" subject="Julio" object="10 September 1990"/>`), /^Relationship "was born on" expects a date as its object \(got "10 September 1990"\)/);
    assertHas(errors(`${BASE}<relinst type="is resident" subject="Julio" object="TRUE"/>`), /^Relationship "is resident" must have true or false as its object \(got "TRUE"\)/);
    assertHas(errors(`${BASE}<relinst type="has age" subject="Julio" object="abc"/>`), /^Relationship "has age" expects a number as its object \(got "abc"\)/);
    assert.deepEqual(errors(`${BASE}<relinst type="was born on" subject="Julio" object="1990-09-10"/>`), []);
  });

  test("literals inside rule conditions are checked the same way", () => {
    assertHas(
      errors(`${BASE}<relinst type="is resident" subject="%S" object="true"><condition rel="was born on" subject="%S" object="last year"/></relinst>`),
      /Relationship "was born on" expects a date as its object \(got "last year"\)/
    );
  });
});

describe("empty attribute values", () => {
  test("an empty name is an error, not silently ignored", () => {
    assertHas(errors(`<concept name="" type="string"/>`), /concept element has empty attribute: name/);
  });

  test("an empty enum attribute reports emptiness rather than an invalid value", () => {
    const e = errors(`<concept name="X" type=""/>`);
    assertHas(e, /empty attribute: type/);
    assertNone(e, /invalid value/);
  });

  test("empty fact endpoints and cf are errors", () => {
    assertHas(errors(`${BASE}<relinst type="lives in" subject="Julio" object=""/>`), /relinst element has empty attribute: object/);
    assertHas(errors(`${BASE}<relinst type="lives in" subject="Julio" object="France" cf=""/>`), /empty attribute: cf/);
  });

  test("datasource path may be empty", () => {
    const e = errors(`${BASE}
      <concept name="Postcode" type="string">
        <datasource hostname="https://api.example.com" path=""/>
      </concept>
      <rel name="has postcode" subject="Person" object="Postcode"/>`);
    assertNone(e, /empty attribute/);
  });
});

describe("lexical checks", () => {
  test("a duplicate attribute is an error; the first value wins; the fix removes the repeat", () => {
    const text = wrap(`<concept name="A" type="string" type="number"/>\n<rel name="r" subject="A" object="A"/>`);
    const issues = collectIssues(text);
    const dup = issues.find((i) => /Duplicate attribute type on <concept>/.test(i.message));
    assert.ok(dup, "expected a duplicate attribute error");
    assert.equal(dup!.severity, "error");
    assertNone(issues.map((i) => i.message), /subjects must be string/); // first value ("string") was kept
    const fixed = applyFix(text, dup!.fixes![0]);
    assert.doesNotMatch(fixed, /type="number"/);
    assert.match(fixed, /type="string"/);
    assertNone(collectIssues(fixed).map((i) => i.message), /Duplicate attribute/);
  });

  test("a tag with an unbalanced quote that cannot be parsed is reported where it is", () => {
    const e = errors(`<concept name="A type="string"/>`);
    assertHas(e, /Malformed element: "<concept name="A type="string"\/>" could not be parsed — check for unbalanced quotes/);
  });

  test("an unbalanced quote that swallows the following element is reported as quote trouble, without bogus duplicate-attribute fixes", () => {
    const issues = lint(`<concept name="A type="string"/>\n<concept name="B type="string"/>`);
    assertHas(ofSeverity(issues, "error"), /Unbalanced double quotes? in <concept>|runs into the next element/);
    assertNone(issues.map((i) => i.message), /Duplicate attribute/);
    assert.ok(issues.every((i) => !i.fixes || !i.fixes.some((f) => /Remove duplicate/.test(f.title))));
  });

  test("an unquoted attribute value is a malformed attribute", () => {
    assertHas(errors(`<concept name=Person type="string"/>`), /Malformed attribute in <concept>: "name=Person"/);
  });

  test("text outside elements is an error; text inside question forms and comments is fine", () => {
    assertHas(errors(`<concept name="A" type="string"/>\nhello there`), /Unexpected text outside an element: "hello there"/);
    const ok = errors(`${BASE}
      <!-- a comment with words in it -->
      <rel name="knows" subject="Person" object="Person">
        <firstForm>Does %S know %O?</firstForm>
      </rel>`);
    assertNone(ok, /Unexpected text/);
  });

  test("text after the root element is an error", () => {
    const e = collectIssues(wrap(`<concept name="A" type="string"/>`) + "trailing").filter((i) => i.severity === "error").map((i) => i.message);
    assertHas(e, /Unexpected text outside an element: "trailing"/);
  });

  test("an unclosed root is reported at its opening tag", () => {
    const text = `<rbl:kb xmlns:rbl="http://rbl.io/schema/RBLang">\n<concept name="A" type="string"/>\n`;
    const issue = collectIssues(text).find((i) => /Unclosed element <rbl:kb>/.test(i.message));
    assert.ok(issue);
    assert.equal(issue!.line, 0);
  });

  test("a closing tag with nothing open, or carrying attributes, is an error", () => {
    assertHas(collectIssues(wrap(``) + "</extra>\n").map((i) => i.message), /Unexpected closing tag <\/extra>: no element is open/);
    assertHas(errors(`<rel name="r" subject="Person" object="Person"></rel name="r">`), /Closing tag <\/rel> cannot have attributes/);
  });
});

/**
 * Document-level structure, mirroring the platform parser's own acceptance
 * tests: root element present, correctly named and closed; no text where the
 * schema allows none; XML character rules. Whole documents, not wrapped bodies.
 */
describe("document structure", () => {
  const XML = `<?xml version="1.0" encoding="utf-8"?>\n`;
  const OPEN = `<rbl:kb xmlns:rbl="http://rbl.io/schema/RBLang">\n`;
  const docErrors = (text: string): string[] => ofSeverity(collectIssues(text), "error");

  const BUS_PASS = (concinstWorking: string, ageCondition: string, relinstLead = "") => `${XML}${OPEN}
    <concept name="Person" type="string"/>
    <concept name="Age" type="number"/>
    <concept name="Pass" type="string"/>
    <concept name="Occupation Status" type="string"/>
    <concinst name="Bus Pass" type="Pass"/>
    <concinst name="Retired's" type="Occupation Status"/>
    ${concinstWorking}
    <rel name="is aged" subject="Person" object="Age" askable="secondFormObject">
      <secondFormObject>How old is %S?</secondFormObject>
    </rel>
    <rel name="has occupation status" subject="Person" object="Occupation Status" askable="secondFormObject">
      <secondFormObject>What is the occupation status of %S?</secondFormObject>
    </rel>
    <rel name="is eligible for" subject="Person" object="Pass" askable="none"/>
    <relinst type="is eligible for" object="Bus Pass" cf="100">
      ${relinstLead}
      ${ageCondition}
      <condition rel="has occupation status" subject="%S" object="%OCCUPATION_STATUS"/>
      <condition expression="(%AGE is greater than 60) or (%OCCUPATION_STATUS is equal to 'Retired\\'s')"/>
    </relinst>
    </rbl:kb>`;

  test("the platform's bus-pass map is accepted verbatim: apostrophes in names, \\' escapes in expressions", () => {
    const issues = collectIssues(`${XML}${OPEN}
  <concept name="Person" type="string"/>
  <concept name="Age" type="number"/>
  <concept name="Pass" type="string"/>
  <concept name="Occupation Status" type="string"/>
  <concinst name="Bus Pass" type="Pass"/>
  <concinst name="Retired's" type="Occupation Status"/>
  <concinst name="Working" type="Occupation Status"/>
  <rel name="is aged" subject="Person" object="Age" askable="secondFormObject">
    <secondFormObject>How old is %S?</secondFormObject>
  </rel>
  <rel name="has occupation status" subject="Person" object="Occupation Status" askable="secondFormObject">
    <secondFormObject>What is the occupation status of %S?</secondFormObject>
  </rel>
  <rel name="is eligible for" subject="Person" object="Pass" askable="none"/>
  <relinst type="is eligible for" object="Bus Pass" cf="100">
    <condition rel="is aged" subject="%S" object="%AGE"/>
    <condition rel="has occupation status" subject="%S" object="%OCCUPATION_STATUS"/>
    <condition expression="(%AGE is greater than 60) or (%OCCUPATION_STATUS is equal to 'Retired\\'s')"/>
  </relinst>
  <relinst type="is eligible for" object="Bus Pass" cf="100">
    <condition rel="is aged" subject="%S" object="%AGE"/>
    <condition rel="has occupation status" subject="%S" object="%OCCUPATION_STATUS"/>
    <condition expression="((%AGE is greater than 60) and (%AGE is less than 80)) or (%OCCUPATION_STATUS is equal to 'Retired\\'s')"/>
  </relinst>
</rbl:kb>`);
    assert.deepEqual(ofSeverity(issues, "error"), []);
    assert.deepEqual(ofSeverity(issues, "warning"), []);
  });

  test("quote balance in expressions understands the \\' escape", () => {
    const rule = (expr: string) => `${BASE}<relinst type="is resident" subject="%S" object="true"><condition rel="lives in" subject="%S" object="%C"/><condition expression="${expr}"/></relinst>`;
    assertNone(errors(rule(`%C is equal to 'Retired\\'s'`)), /Unbalanced single quote/);
    assertNone(errors(rule(`includes(%C, 'it\\'s') or includes(%C, 'wasn\\'t')`)), /Unbalanced single quote/);
    assertHas(errors(rule(`%C is equal to 'Retired\\'s`)), /Unbalanced single quote/);
    assertHas(errors(rule(`includes(%C, 'SW1)`)), /Unbalanced single quote/);
  });

  test("names may contain apostrophes but not quotes, backslashes or angle brackets", () => {
    assertNone(errors(`<concept name="Retired's" type="string"/><rel name="r" subject="Retired's" object="Retired's"/>`), /Names cannot contain/);
    for (const bad of ["Bad\\Name", "Bad<Name", "Bad>Name"]) assertHas(errors(`<concept name="${bad}" type="string"/>`), /Names cannot contain/);
  });

  test("the bus-pass map used by the structure cases is itself clean", () => {
    assert.deepEqual(docErrors(BUS_PASS(`<concinst name="Working" type="Occupation Status"/>`, `<condition rel="is aged" subject="%S" object="%AGE"/>`)), []);
  });

  test("missing opening root tag", () => {
    const e = docErrors(`${XML}</rbl:kb>\n`);
    assertHas(e, /Missing root element/);
    assertHas(e, /Unexpected closing tag <\/rbl:kb>: no element is open/);
  });

  test("missing closing root tag", () => {
    assertHas(docErrors(`${XML}${OPEN}`), /Unclosed element <rbl:kb>: missing <\/rbl:kb>/);
  });

  test("wrong root prefix, with or without a namespace declaration", () => {
    for (const root of [`<xyz:kb>\n</xyz:kb>`, `<xyz:kb xmlns:xyz="http://rbl.io/schema/RBLang">\n</xyz:kb>`]) {
      const e = docErrors(`${XML}${root}\n`);
      assertHas(e, /Unrecognised element: xyz:kb/);
      assertHas(e, /Missing root element/);
    }
  });

  test("wrong root local name", () => {
    const e = docErrors(`${XML}<rbl:lc>\n</rbl:lc>\n`);
    assertHas(e, /Unrecognised element: rbl:lc/);
    assertHas(e, /Missing root element/);
  });

  test("a second root element is an error", () => {
    assertHas(docErrors(`${XML}${OPEN}</rbl:kb>\n${OPEN}</rbl:kb>\n`), /Only one <rbl:kb> root is allowed/);
  });

  test("random text inside the root element", () => {
    assertHas(docErrors(`${XML}${OPEN}This is some random text\n<concept name="animal" type="string"/>\n</rbl:kb>\n`), /Unexpected text outside an element: "This is some random text"/);
  });

  test("random text inside rel", () => {
    const e = docErrors(`${XML}${OPEN}
      <concept name="animal" type="string"/>
      <concept name="legs" type="number"/>
      <concept name="bipedal" type="truth"/>
      <rel name="is" subject="animal" object="bipedal">
        This is some random text
      </rel>
      <rel name="has number of legs" subject="animal" object="legs"/>
      <relinst type="has number of legs" object="2" cf="100">
        <condition rel="is" subject="%S" object="true"/>
      </relinst>
      </rbl:kb>`);
    assertHas(e, /Unexpected text outside an element: "This is some random text"/);
  });

  test("random text inside concinst, condition and relinst", () => {
    const RANDOM = /Unexpected text outside an element: "This is some random text"/;
    assertHas(docErrors(BUS_PASS(`<concinst name="Working" type="Occupation Status">\n  This is some random text\n</concinst>`, `<condition rel="is aged" subject="%S" object="%AGE"/>`)), RANDOM);
    assertHas(docErrors(BUS_PASS(`<concinst name="Working" type="Occupation Status"/>`, `<condition rel="is aged" subject="%S" object="%AGE">\n  This is some random text\n</condition>`)), RANDOM);
    assertHas(docErrors(BUS_PASS(`<concinst name="Working" type="Occupation Status"/>`, `<condition rel="is aged" subject="%S" object="%AGE"/>`, "This is some random text")), RANDOM);
  });

  test("random text inside concept", () => {
    const e = docErrors(`${XML}${OPEN}<concept name="Person" type="string">\n  This is some random text\n</concept>\n<rel name="knows" subject="Person" object="Person"/>\n</rbl:kb>`);
    assertHas(e, /Unexpected text outside an element: "This is some random text"/);
  });

  test("the XML declaration is optional", () => {
    assert.deepEqual(docErrors(`${OPEN}</rbl:kb>\n`), []);
  });

  test("a root without xmlns:rbl is an error (Studio requires the namespace verbatim)", () => {
    assertHas(docErrors(`${XML}<rbl:kb>\n</rbl:kb>\n`), /rbl:kb element has missing attribute: xmlns:rbl/);
  });

  test("no XML at all", () => {
    const e = docErrors(`This is just plain text with no XML whatsoever.`);
    assertHas(e, /Missing root element/);
    assertHas(e, /Unexpected text outside an element/);
  });

  test("only the processing instruction, no root element", () => {
    assertHas(docErrors(`<?xml version="1.0" encoding="utf-8"?>`), /Missing root element/);
  });

  test("a mid-line <?xml with no real document is an error", () => {
    const e = docErrors(`The <?xml processing instruction starts every document.`);
    assertHas(e, /Missing root element/);
  });

  test("a blank document is left alone", () => {
    assert.deepEqual(collectIssues("").map((i) => i.message), []);
    assert.deepEqual(collectIssues("\n  \n").map((i) => i.message), []);
  });

  test("LLM-style preface, postscript and code fences around the map are errors in a file", () => {
    assertHas(docErrors(`Hi, I am a helpful LLM\n${XML}${OPEN}</rbl:kb>\n`), /Unexpected text outside an element: "Hi, I am a helpful LLM"/);
    assertHas(docErrors(`${XML}${OPEN}</rbl:kb>\nI am a LLM and I really like RBLang\n`), /Unexpected text outside an element: "I am a LLM and I really like RBLang"/);
    const fenced = "Here is the RBLang:\n\n```xml\n" + XML + OPEN + "</rbl:kb>\n```\n\nI hope this helps!";
    const e = docErrors(fenced);
    assertHas(e, /Unexpected text outside an element: "Here is the RBLang: ```xml"/);
    assertHas(e, /Unexpected text outside an element: "``` I hope this helps!"/);
  });

  test("an unclosed child element is rejected", () => {
    const e = docErrors(`${XML}${OPEN}<concept name="animal" type="string">\n</rbl:kb>`);
    assertHas(e, /Mismatched closing tag: expected <\/concept>/);
  });

  test("a mismatched closing tag is rejected", () => {
    assertHas(docErrors(`${XML}${OPEN}<concept name="animal" type="string"></rel>\n</rbl:kb>`), /Mismatched closing tag: expected <\/concept>/);
  });

  test("a bare ampersand in an attribute is rejected, with an &amp; fix", () => {
    const text = `${XML}${OPEN}<concept name="cats & dogs" type="string"/>\n<rel name="likes" subject="cats & dogs" object="cats & dogs"/>\n</rbl:kb>`;
    const issue = collectIssues(text).find((i) => /Bare "&" in name of <concept>/.test(i.message));
    assert.ok(issue, "expected a bare-ampersand error");
    assert.equal(issue!.severity, "error");
    const fixed = applyFix(text, issue!.fixes![0]);
    assert.match(fixed, /name="cats &amp; dogs" type="string"/);
    assertNone(collectIssues(fixed).map((i) => i.message), /Bare "&" in name of <concept>/);
  });

  test("a bare ampersand in text is rejected; entities and comments are fine", () => {
    const body = (q: string) => `${BASE}<rel name="knows" subject="Person" object="Person"><firstForm>${q}</firstForm></rel>`;
    assertHas(errors(body("Does %S know %O & like them?")), /Bare "&" in text/);
    assertNone(errors(body("Does %S know %O &amp; like them? &lt;3 &#38; &#x26;")), /Bare "&"/);
    assertNone(errors(`${BASE}<!-- pros & cons -->`), /Bare "&"/);
  });

  test("a datasource path may contain a raw query string", () => {
    const e = errors(`${BASE}
      <concept name="Postcode" type="string">
        <datasource hostname="https://api.example.com" path="/lookup?a=1&b=2"/>
      </concept>
      <rel name="has postcode" subject="Person" object="Postcode"/>`);
    assertNone(e, /Bare "&"/);
  });
});

describe("datasource inputs", () => {
  const withDatasource = (inputs: string) => `${BASE}
    <concept name="Postcode" type="string">
      <datasource hostname="https://api.example.com" path="/lookup">
        ${inputs}
        <action map="lives in=/Response/Country"/>
      </datasource>
    </concept>
    <rel name="has postcode" subject="Person" object="Postcode"/>`;

  test("%S bound where the relationship expects another concept is an error", () => {
    const e = errors(withDatasource(`<input rel="has age" object="%S"/>`));
    assertHas(e, /Datasource input: %S is a "Postcode" \(this datasource's concept\), but the object of "has age" must be a "Age"/);
  });

  test("%S on a side that expects the datasource's concept is fine", () => {
    assertNone(errors(withDatasource(`<input rel="has postcode" object="%S" subject="%PERSON"/>`)), /Datasource input/);
  });

  test("an unknown relationship in an input is an error", () => {
    assertHas(errors(withDatasource(`<input rel="has postcod" object="%S"/>`)), /Unknown relationship in datasource input: "has postcod"/);
  });
});

describe("duplicate declarations", () => {
  test("duplicate concepts and relationships are errors, duplicate facts are warnings", () => {
    const issues = lint(`${BASE}
      <concept name="Person" type="string"/>
      <rel name="lives in" subject="Person" object="Country"/>
      <relinst type="lives in" subject="Julio" object="France"/>
      <relinst type="lives in" subject="Julio" object="France"/>`);
    assertHas(ofSeverity(issues, "error"), /Duplicate concept: "Person"/);
    assertHas(ofSeverity(issues, "error"), /Duplicate relationship: "lives in"/);
    assertHas(ofSeverity(issues, "warning"), /Duplicate fact: Julio lives in France/);
  });
});

describe("fixes clear the finding they belong to", () => {
  const cases: { name: string; body: string; re: RegExp }[] = [
    { name: "duplicate attribute", body: `<concept name="A" type="string" name="B"/>`, re: /Duplicate attribute name/ },
    { name: "legacy boolean", body: `<concept name="A" type="boolean"/>`, re: /legacy spelling/ },
    { name: "unrecognised attribute", body: `<concept name="A" type="string" colour="red"/>`, re: /unrecognised attribute: colour/ },
    { name: "duplicate concept", body: `<concept name="A" type="string"/>\n<concept name="A" type="string"/>`, re: /Duplicate concept/ },
    { name: "invalid enum", body: `<concept name="A" type="text"/>`, re: /invalid value for attribute: type/ },
    { name: "undeclared instance", body: `${BASE}<relinst type="lives in" subject="Julio" object="Spain"/>`, re: /"Spain" is not a declared instance/ },
    { name: "wrong-concept instance", body: `${BASE}<concept name="Team" type="string"/><concinst name="Lyon" type="Team"/><rel name="supports" subject="Person" object="Team"/><relinst type="lives in" subject="Julio" object="Lyon"/>`, re: /"Lyon" is an instance of "Team"/ },
  ];
  for (const c of cases) {
    test(c.name, () => {
      const text = wrap(c.body);
      const issue = collectIssues(text).find((i) => c.re.test(i.message));
      assert.ok(issue, `expected a finding matching ${c.re}`);
      assert.ok(issue!.fixes?.length, "expected at least one fix");
      const fixed = applyFix(text, issue!.fixes![0]);
      assertNone(collectIssues(fixed).map((i) => i.message), c.re);
    });
  }
});

describe("examples/broken/diagnostics-tour.rbl", () => {
  const file = path.join(__dirname, "..", "..", "examples", "broken", "diagnostics-tour.rbl");
  const text = fs.readFileSync(file, "utf8");
  const lines = text.split("\n");
  const issues = collectIssues(text);
  const byLine = new Map<number, LintIssue[]>();
  for (const i of issues) byLine.set(i.line, [...(byLine.get(i.line) ?? []), i]);

  /** Lines (0-based) from the one after `from` up to the next blank line. */
  const block = (from: number): number[] => {
    const out: number[] = [];
    for (let l = from + 1; l < lines.length && lines[l].trim() !== ""; l++) out.push(l);
    return out;
  };

  for (let l = 0; l < lines.length; l++) {
    const expect = /^\s*<!-- EXPECT (error|warning|info)\b/.exec(lines[l]);
    if (expect) {
      test(`line ${l + 1}: ${lines[l].trim().slice(5, 80)}`, () => {
        const found = block(l).flatMap((b) => byLine.get(b) ?? []);
        assert.ok(
          found.some((i) => i.severity === expect[1]),
          `expected a ${expect[1]} on lines ${block(l).map((b) => b + 1).join(",")}; got ${JSON.stringify(found.map((i) => `[${i.severity}] ${i.message}`), null, 2)}`
        );
      });
    } else if (/^\s*<!-- OK\b/.test(lines[l])) {
      test(`line ${l + 1}: ${lines[l].trim().slice(5, 80)}`, () => {
        const found = block(l).flatMap((b) => byLine.get(b) ?? []);
        assert.deepEqual(found.map((i) => `[${i.severity}] ${i.message}`), []);
      });
    }
  }

  test("every finding sits in an EXPECT block (nothing unexplained)", () => {
    const explained = new Set<number>();
    for (let l = 0; l < lines.length; l++) if (/^\s*<!-- EXPECT/.test(lines[l])) for (const b of block(l)) explained.add(b);
    const unexplained = issues.filter((i) => !explained.has(i.line)).map((i) => `L${i.line + 1} [${i.severity}] ${i.message}`);
    assert.deepEqual(unexplained, []);
  });
});
