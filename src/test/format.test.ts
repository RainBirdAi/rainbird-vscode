/**
 * Unit tests for the RBLang indent-only formatter (format.ts).
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { formatText, formatLines } from "../format";

const examples = path.join(__dirname, "..", "..", "examples");
const spaces2 = { tabSize: 2, insertSpaces: true };
const tabs = { tabSize: 4, insertSpaces: false };

describe("RBLang formatter", () => {
  test("re-indents from the element nesting", () => {
    const input = ['<?xml version="1.0" encoding="utf-8"?>', '<rbl:kb xmlns:rbl="http://rbl.io/schema/RBLang">', '<concept name="person" type="string"/>', '<rel name="speaks" subject="person" object="language">', '<firstForm>Does %S speak %O?</firstForm>', "</rel>", "</rbl:kb>", ""].join("\n");
    const expected = ['<?xml version="1.0" encoding="utf-8"?>', '<rbl:kb xmlns:rbl="http://rbl.io/schema/RBLang">', '  <concept name="person" type="string"/>', '  <rel name="speaks" subject="person" object="language">', "    <firstForm>Does %S speak %O?</firstForm>", "  </rel>", "</rbl:kb>", ""].join("\n");
    assert.equal(formatText(input, spaces2), expected);
  });

  test("converts existing tab indentation to the requested style and back", () => {
    const tabbed = "<rbl:kb>\n\t<rel name=\"speaks\">\n\t\t<firstForm>Does %S speak %O?</firstForm>\n\t</rel>\n</rbl:kb>";
    const spaced = "<rbl:kb>\n  <rel name=\"speaks\">\n    <firstForm>Does %S speak %O?</firstForm>\n  </rel>\n</rbl:kb>";
    assert.equal(formatText(tabbed, spaces2), spaced);
    assert.equal(formatText(spaced, tabs), tabbed);
  });

  test("wrapped attributes shift with their start tag so alignment is preserved", () => {
    const input = ["<rbl:kb>", '<relinst type="speaks" cf="100" name="Rule"', '         alt="Wrapped attribute">', '<condition rel="born in" subject="%S" object="%C"/>', "</relinst>", "</rbl:kb>"].join("\n");
    const expected = ["<rbl:kb>", '  <relinst type="speaks" cf="100" name="Rule"', '           alt="Wrapped attribute">', '    <condition rel="born in" subject="%S" object="%C"/>', "  </relinst>", "</rbl:kb>"].join("\n");
    assert.equal(formatText(input, spaces2), expected);
  });

  test("multi-line comments move as a block and keep their inner layout", () => {
    const input = ["<rbl:kb>", "      <!-- first", "           second", "      -->", '      <concept name="a" type="string"/>', "</rbl:kb>"].join("\n");
    const expected = ["<rbl:kb>", "  <!-- first", "       second", "  -->", '  <concept name="a" type="string"/>', "</rbl:kb>"].join("\n");
    assert.equal(formatText(input, spaces2), expected);
  });

  test("blank lines become empty and trailing whitespace is trimmed", () => {
    const input = "<rbl:kb>   \n   \n  <concept name=\"a\" type=\"string\"/>  \t\n</rbl:kb>";
    assert.equal(formatText(input, spaces2), "<rbl:kb>\n\n  <concept name=\"a\" type=\"string\"/>\n</rbl:kb>");
  });

  test("lines inside a quoted value or CDATA section are left untouched", () => {
    const quoted = ["<rbl:kb>", '<relinst type="t" alt="line one   ', '     line two"/>', "</rbl:kb>"].join("\n");
    assert.equal(formatText(quoted, spaces2), ["<rbl:kb>", '  <relinst type="t" alt="line one   ', '     line two"/>', "</rbl:kb>"].join("\n"));
    const cdata = ["<rbl:kb>", "<meta><![CDATA[", "   keep   ", "]]></meta>", "</rbl:kb>"].join("\n");
    assert.equal(formatText(cdata, spaces2), ["<rbl:kb>", "  <meta><![CDATA[", "   keep   ", "]]></meta>", "</rbl:kb>"].join("\n"));
  });

  test("self-closing tags, the XML declaration and comments do not change depth", () => {
    const input = ['<?xml version="1.0"?>', "<!-- a comment -->", "<rbl:kb>", '<concept name="a" type="string"/>', "<!-- inline -->", '<concept name="b" type="string" />', "</rbl:kb>"].join("\n");
    const expected = ['<?xml version="1.0"?>', "<!-- a comment -->", "<rbl:kb>", '  <concept name="a" type="string"/>', "  <!-- inline -->", '  <concept name="b" type="string" />', "</rbl:kb>"].join("\n");
    assert.equal(formatText(input, spaces2), expected);
  });

  test("a '>' inside an attribute value does not end the tag", () => {
    const input = ["<rbl:kb>", '<condition expression="%A > 3"/>', '<concept name="x" type="string"/>', "</rbl:kb>"].join("\n");
    assert.equal(formatText(input, spaces2), ["<rbl:kb>", '  <condition expression="%A > 3"/>', '  <concept name="x" type="string"/>', "</rbl:kb>"].join("\n"));
  });

  test("stray and mismatched closing tags are tolerated", () => {
    assert.equal(formatText("</rel>\n<rbl:kb>\n<concept/>\n</rbl:kb>", spaces2), "</rel>\n<rbl:kb>\n  <concept/>\n</rbl:kb>");
    // </rbl:kb> closes back past the unclosed <rel>.
    assert.equal(formatText("<rbl:kb>\n<rel name=\"r\">\n<concept/>\n</rbl:kb>\n<x/>", spaces2), "<rbl:kb>\n  <rel name=\"r\">\n    <concept/>\n</rbl:kb>\n<x/>");
    // An unclosed document never throws.
    assert.doesNotThrow(() => formatText("<rbl:kb>\n<rel name=\"unterminated", spaces2));
  });

  test("CRLF line endings are preserved", () => {
    assert.equal(formatText("<rbl:kb>\r\n<concept/>\r\n</rbl:kb>\r\n", spaces2), "<rbl:kb>\r\n  <concept/>\r\n</rbl:kb>\r\n");
  });

  test("only changed lines are reported", () => {
    const edits = formatLines("<rbl:kb>\n  <concept/>\n<concept/>\n</rbl:kb>", spaces2);
    assert.deepEqual(edits, [{ line: 2, text: "  <concept/>" }]);
  });

  test("formatting is idempotent over the example maps", () => {
    for (const file of fs.readdirSync(examples).filter((f) => f.endsWith(".rbl"))) {
      const text = fs.readFileSync(path.join(examples, file), "utf8");
      const once = formatText(text, spaces2);
      assert.equal(formatText(once, spaces2), once, file);
      const onceTabs = formatText(text, tabs);
      assert.equal(formatText(onceTabs, tabs), onceTabs, file);
    }
  });

  test("an already two-space-indented example needs no edits", () => {
    const text = fs.readFileSync(path.join(examples, "504436fb-v1.rbl"), "utf8");
    assert.deepEqual(formatLines(text, spaces2), []);
  });
});
