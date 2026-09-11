/**
 * Unit tests for placing the platform's validation messages onto RBLang
 * elements (platformErrors.ts). The messages are the platform's real wording
 * as seen on rejected pushes; the map is the diagnostics tour fixture.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { locatePlatformErrors, normaliseErrMessages } from "../platformErrors";

const tour = fs.readFileSync(path.join(__dirname, "..", "..", "examples", "broken", "diagnostics-tour.rbl"), "utf8");
const lineText = (text: string, line: number): string => text.split("\n")[line].trim();
const linesFor = (message: string): string[] => locatePlatformErrors(tour, [message]).map((h) => lineText(tour, h.line));

describe("platform error locator", () => {
  test("a rejected date literal lands on every fact whose date the platform would reject", () => {
    const lines = linesFor("Relationship was born on expects a date as its object");
    assert.equal(lines.length, 2);
    assert.ok(lines.every((l) => l.includes('type="was born on"')), lines.join("\n"));
    assert.ok(lines.some((l) => l.includes("10 September 1990")));
    assert.ok(lines.some((l) => l.includes("someday")));
  });

  test("a rejected truth literal lands on TRUE and yes, not on the valid facts or rule heads", () => {
    const lines = linesFor("Relationship is resident must have true or false as its object");
    assert.deepEqual(
      lines.sort(),
      ['<relinst type="is resident" subject="Ana" object="TRUE"/>', '<relinst type="is resident" subject="Julio" object="yes"/>'].sort()
    );
  });

  test("a rejected number literal lands on the offending facts", () => {
    const lines = linesFor("Relationship has age expects a number as its object");
    assert.ok(lines.some((l) => l.includes('object="abc"')));
    assert.ok(lines.some((l) => l.includes('object="1000000000000000"')));
    assert.ok(lines.every((l) => l.includes('type="has age"')));
  });

  test("a message that only names a relationship lands on its declaration", () => {
    const lines = linesFor("Relationship lives in is not valid");
    assert.deepEqual(lines, ['<rel name="lives in" subject="Person" object="Country" plural="true">']);
  });

  test("a message naming a concept lands on the concept", () => {
    assert.deepEqual(linesFor("Concept Postcode has an invalid datasource"), ['<concept name="Postcode" type="string">']);
  });

  test("a message about an instance lands on that instance of that concept", () => {
    assert.deepEqual(linesFor("Instance Lyon of Team is not allowed"), ['<concinst name="Lyon" type="Team"/>']);
  });

  test("explicit Line: N positions are honoured", () => {
    const [hit] = locatePlatformErrors(tour, ["Unexpected close tag Line: 12 Column: 4"]);
    assert.equal(hit.line, 11);
  });

  test("the platform's upload wording, Line: N - message, positions the line and drops the prefix", () => {
    // Captured from a real 201: the datasource with a bare hostname is on line 35 of the tour map.
    const [hit] = locatePlatformErrors(tour, ["Line: 35 - Datasource hostname must start with 'http://' or 'https://' followed by a valid hostname."]);
    assert.equal(hit.line, 34);
    assert.ok(lineText(tour, hit.line).startsWith("<datasource hostname=\"api.example.com\""), lineText(tour, hit.line));
    assert.equal(hit.message, "Datasource hostname must start with 'http://' or 'https://' followed by a valid hostname.");
  });

  test("messages that cannot be placed land on the root element with their full text", () => {
    const [hit] = locatePlatformErrors(tour, ["Something unexpected happened"]);
    assert.ok(lineText(tour, hit.line).startsWith("<rbl:kb"));
    assert.equal(hit.message, "Something unexpected happened");
  });

  test("every message yields at least one location", () => {
    const hits = locatePlatformErrors(tour, ["Relationship was born on expects a date as its object", "nonsense", "Concept Orphan is unused"]);
    assert.ok(hits.length >= 3);
    assert.ok(hits.some((h) => h.message === "nonsense"));
  });
});

describe("normaliseErrMessages", () => {
  test("accepts a string, an array of strings, and objects with a message field", () => {
    assert.deepEqual(normaliseErrMessages("one"), ["one"]);
    assert.deepEqual(normaliseErrMessages(["one", " two "]), ["one", "two"]);
    assert.deepEqual(normaliseErrMessages([{ message: "three" }, { msg: "four" }, { code: 7 }]), ["three", "four", '{"code":7}']);
    assert.deepEqual(normaliseErrMessages(undefined), []);
  });
});
