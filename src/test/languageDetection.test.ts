/**
 * Unit tests for recognising Raelog held in a document VS Code typed as XML
 * or plain text (languageDetection.ts).
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { looksLikeRaelog } from "../detect";
import { exampleModels } from "./exampleModels";

const examples = path.join(__dirname, "..", "..", "examples");

describe("Raelog detection in foreign-typed documents", () => {
  test("the namespace declaration on line two is recognised", () => {
    assert.ok(looksLikeRaelog('<?xml version="1.0" encoding="utf-8"?>\n<rbl:kb xmlns:rbl="http://rbl.io/schema/RBLang">\n</rbl:kb>\n'));
  });

  test("single quotes and whitespace around the namespace binding are accepted", () => {
    assert.ok(looksLikeRaelog("<rbl:kb xmlns:rbl = 'http://rbl.io/schema/RBLang'>"));
  });

  test("a bare <rbl:kb> root with no namespace binding is recognised", () => {
    assert.ok(looksLikeRaelog("<rbl:kb>\n  <concept name=\"person\" type=\"string\"/>\n</rbl:kb>"));
    assert.ok(looksLikeRaelog("<rbl:kb/>"));
  });

  test("comments and a leading XML declaration before the root do not hide it", () => {
    assert.ok(looksLikeRaelog('<?xml version="1.0"?>\n<!-- exported from Studio -->\n<!-- second comment -->\n<rbl:kb xmlns:rbl="http://rbl.io/schema/RBLang"/>'));
  });

  test("ordinary XML is left alone", () => {
    assert.equal(looksLikeRaelog('<?xml version="1.0"?>\n<project xmlns="http://maven.apache.org/POM/4.0.0"></project>'), false);
    assert.equal(looksLikeRaelog("<html><body>rbl:kb mentioned in prose</body></html>"), false);
    assert.equal(looksLikeRaelog(""), false);
  });

  test("an rbl prefix bound to a different namespace is not ours", () => {
    assert.equal(looksLikeRaelog('<rbl:kb xmlns:rbl="http://example.com/other">'), false);
  });

  test("a namespace declaration far past the head of the file is not consulted", () => {
    const filler = "<!-- " + "x".repeat(4000) + " -->\n";
    assert.equal(looksLikeRaelog(filler + '<rbl:kb xmlns:rbl="http://rbl.io/schema/RBLang"/>'), false);
  });

  test("every example map is recognised", () => {
    const files = exampleModels({ recursive: true });
    for (const f of files) assert.ok(looksLikeRaelog(fs.readFileSync(f, "utf8")), f);
  });
});
