import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { buildContextHeader, hashText, INLINE_LIMIT, contextNote } from "../assistantContext";
import { collectIssues } from "../lint";

const small = `<?xml version="1.0" encoding="utf-8"?>\n<rbl:kb xmlns:rbl="http://rbl.io/schema/RBLang">\n  <concept name="Person" type="string"/>\n</rbl:kb>\n`;

describe("context header", () => {
  test("no file open", () => {
    const h = buildContextHeader({ applyMode: "immediately", firstTurn: true });
    assert.match(h.text, /file: none open \(use create_map/);
    assert.match(h.text, /not connected \(Rainbird: Connect\) · kmID not set/);
    assert.match(h.text, /edits: applied immediately, undoable/);
    assert.equal(h.inlined, false);
    assert.equal(contextNote({ applyMode: "immediately", firstTurn: true }, h), undefined);
  });

  test("first turn with a small file inlines it with line numbers", () => {
    const info = { fileName: "a.rbl", text: small, cursorLine: 3, issues: collectIssues(small), apiUrl: "https://api.rainbird.ai", kmId: "km1", kmIdSource: "workspace setting", applyMode: "immediately" as const, firstTurn: true };
    const h = buildContextHeader(info);
    assert.equal(h.inlined, true);
    assert.equal(h.hash, hashText(small));
    assert.match(h.text, /file: a.rbl · 4 lines · \d+ B · rblang/);
    assert.match(h.text, /status: first turn/);
    assert.match(h.text, /cursor: L3/);
    assert.match(h.text, /diagnostics: 0 errors, 0 warnings, 1 hint/);
    assert.match(h.text, /kmID km1 \(workspace setting\)/);
    assert.match(h.text, /full file: included below/);
    assert.match(h.text, /<active-file lines="4">\n1 \| <\?xml/);
    assert.equal(contextNote(info, h), "📎 a.rbl · file attached");
  });

  test("an unchanged file is not resent; a changed one is", () => {
    const seen = hashText(small);
    const same = buildContextHeader({ fileName: "a.rbl", text: small, applyMode: "immediately", firstTurn: false, lastSeenHash: seen });
    assert.equal(same.inlined, false);
    assert.match(same.text, /status: unchanged since your previous turn/);
    assert.match(same.text, /full file: not included/);
    const changed = buildContextHeader({ fileName: "a.rbl", text: small + "\n", applyMode: "immediately", firstTurn: false, lastSeenHash: seen });
    assert.equal(changed.inlined, true);
    assert.match(changed.text, /changed since your previous turn — re-read before editing/);
  });

  test("large files are never inlined", () => {
    const big = small.replace("</rbl:kb>", `${'<concept name="X" type="string"/>\n'.repeat(400)}</rbl:kb>`);
    assert.ok(big.length > INLINE_LIMIT);
    const h = buildContextHeader({ fileName: "big.rbl", text: big, applyMode: "preview", firstTurn: true });
    assert.equal(h.inlined, false);
    assert.match(h.text, /full file: not included \(use get_map_overview \/ read_map\)/);
    assert.match(h.text, /edits: proposed for review/);
  });

  test("selection is attached and noted", () => {
    const info = { fileName: "a.rbl", text: small, selection: { startLine: 3, endLine: 3, text: '  <concept name="Person" type="string"/>' }, applyMode: "preview" as const, firstTurn: false, lastSeenHash: hashText(small), proposalPending: true };
    const h = buildContextHeader(info);
    assert.match(h.text, /selection: L3–L3 \(included below\)/);
    assert.match(h.text, /<selection lines="3-3">\n  <concept name="Person"/);
    assert.match(h.text, /a proposal is pending/);
    assert.equal(contextNote(info, h), "📎 a.rbl · selection L3–3");
  });
});
