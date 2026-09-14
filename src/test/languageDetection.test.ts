/**
 * Unit tests for recognising RBLang held in a document VS Code typed as XML
 * or plain text (languageDetection.ts).
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { looksLikeRblang } from "../detect";

const examples = path.join(__dirname, "..", "..", "examples");

describe("RBLang detection in foreign-typed documents", () => {
  test("the namespace declaration on line two is recognised", () => {
    assert.ok(looksLikeRblang('<?xml version="1.0" encoding="utf-8"?>\n<rbl:kb xmlns:rbl="http://rbl.io/schema/RBLang">\n</rbl:kb>\n'));
  });

  test("single quotes and whitespace around the namespace binding are accepted", () => {
    assert.ok(looksLikeRblang("<rbl:kb xmlns:rbl = 'http://rbl.io/schema/RBLang'>"));
  });

  test("a bare <rbl:kb> root with no namespace binding is recognised", () => {
    assert.ok(looksLikeRblang("<rbl:kb>\n  <concept name=\"person\" type=\"string\"/>\n</rbl:kb>"));
    assert.ok(looksLikeRblang("<rbl:kb/>"));
  });

  test("comments and a leading XML declaration before the root do not hide it", () => {
    assert.ok(looksLikeRblang('<?xml version="1.0"?>\n<!-- exported from Studio -->\n<!-- second comment -->\n<rbl:kb xmlns:rbl="http://rbl.io/schema/RBLang"/>'));
  });

  test("ordinary XML is left alone", () => {
    assert.equal(looksLikeRblang('<?xml version="1.0"?>\n<project xmlns="http://maven.apache.org/POM/4.0.0"></project>'), false);
    assert.equal(looksLikeRblang("<html><body>rbl:kb mentioned in prose</body></html>"), false);
    assert.equal(looksLikeRblang(""), false);
  });

  test("an rbl prefix bound to a different namespace is not ours", () => {
    assert.equal(looksLikeRblang('<rbl:kb xmlns:rbl="http://example.com/other">'), false);
  });

  test("a namespace declaration far past the head of the file is not consulted", () => {
    const filler = "<!-- " + "x".repeat(4000) + " -->\n";
    assert.equal(looksLikeRblang(filler + '<rbl:kb xmlns:rbl="http://rbl.io/schema/RBLang"/>'), false);
  });

  test("every example map is recognised", () => {
    const walk = (dir: string): string[] =>
      fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
        e.isDirectory() ? walk(path.join(dir, e.name)) : e.name.endsWith(".rbl") ? [path.join(dir, e.name)] : []
      );
    const files = walk(examples);
    assert.ok(files.length > 0);
    for (const f of files) assert.ok(looksLikeRblang(fs.readFileSync(f, "utf8")), f);
  });
});
