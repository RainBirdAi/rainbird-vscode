import { describe, test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { buildOverview, readRange, formatDiagnostics, lineAt, countLines } from "../mapOverview";
import { collectIssues } from "../lint";

const examples = path.join(__dirname, "..", "..", "examples");
const hello = fs.readFileSync(path.join(examples, "hello-world.rbl"), "utf8");

describe("map overview", () => {
  test("lists concepts with instances, relationships with counts and rules with line ranges", () => {
    const text = buildOverview(hello, { fileName: "hello-world.rbl", apiUrl: "https://api.rainbird.ai" });
    assert.match(text, /^File hello-world.rbl · \d+ lines · 0 errors/);
    assert.match(text, /kmID not set · connected to https:\/\/api.rainbird.ai/);
    assert.match(text, /Concepts \(3\)/);
    assert.match(text, /Person \[string\] L6 · instances: Julio/);
    assert.match(text, /Language \[string\] L8 · instances: English, French/);
    assert.match(text, /Relationships \(3\)/);
    assert.match(text, /speaks: Person → Language · askable=all · plural · wording: firstForm\/secondFormObject\/secondFormSubject · 0 facts · 1 rule · L10/);
    assert.match(text, /national language: Country → Language · askable=none · 2 facts · 0 rules/);
    assert.match(text, /Facts \(2\)/);
    assert.match(text, /England national language English · L27/);
    assert.match(text, /Rules \(1\)/);
    assert.match(text, /"Speaks national language of home country" · speaks · cf 75 · 2 conditions · L31–35/);
  });

  test("reports a missing root and errors", () => {
    const text = buildOverview("<concept name=\"X\" type=\"string\"/>", { fileName: "x.rbl" });
    assert.match(text, /No <rbl:kb> root/);
    assert.match(text, /Errors \(\d+/);
  });

  test("readRange numbers lines, caps output and points at the continuation", () => {
    const out = readRange(hello, 1, 3);
    assert.equal(out.split("\n")[0], '1 | <?xml version="1.0" encoding="utf-8"?>');
    assert.match(out, /\(lines 1–3 of \d+\)/);
    const capped = readRange(hello, 1, undefined, 5);
    assert.match(capped, /showing lines 1–5 of \d+\. Call again with start_line=6/);
    const whole = readRange(hello);
    assert.ok(!/more lines|Call again/.test(whole));
    assert.equal(readRange("a\nb\nc", 5), "3 | c\n(lines 3–3 of 3)");
  });

  test("formatDiagnostics groups by severity and includes fix titles", () => {
    const issues = collectIssues(hello.replace('object="Language" plural', 'object="Languag" plural'));
    const text = formatDiagnostics(issues);
    assert.match(text, /^1 error/);
    assert.match(text, /Errors:\n  L10: Unknown concept in object: "Languag" — fixes: Change to "Language"/);
    assert.equal(formatDiagnostics([]), "No diagnostics — the map passes the linter.");
    assert.match(formatDiagnostics(issues, "warning"), /No warnings\. Overall: 1 error/);
  });

  test("line helpers", () => {
    assert.equal(lineAt("a\nb\nc", 4), 3);
    assert.equal(countLines("a\nb\n"), 2);
    assert.equal(countLines("a\nb"), 2);
    assert.equal(countLines(""), 0);
  });
});
