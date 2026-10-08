/**
 * The knowledge reference must be complete, byte-stable and correct: every
 * schema element and function is mentioned, the section order matches the
 * table of contents, nothing volatile leaks in, and every worked example
 * passes the linter with zero errors.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { buildKnowledgeReference, KNOWLEDGE_SECTIONS, KNOWLEDGE_EXAMPLES } from "../knowledge";
import { BEHAVIOUR_PROMPT } from "../knowledge/behaviour";
import { EXPLAIN_SYSTEM_PROMPT } from "../knowledge/engine";
import { SCHEMA, EXPRESSION_FUNCTIONS } from "../schema";
import { collectIssues } from "../lint";

describe("knowledge reference", () => {
  const text = buildKnowledgeReference();

  test("is byte-stable across calls", () => {
    assert.equal(buildKnowledgeReference(), text);
  });

  test("contains every section heading, in order", () => {
    let at = -1;
    for (const title of KNOWLEDGE_SECTIONS) {
      const idx = text.indexOf(`## ${title}`);
      assert.ok(idx > at, `section "${title}" missing or out of order`);
      at = idx;
    }
  });

  test("mentions every schema element and every expression function", () => {
    for (const name of Object.keys(SCHEMA)) assert.ok(text.includes(`<${name}>`), `element ${name} missing`);
    for (const f of EXPRESSION_FUNCTIONS) assert.ok(text.includes(f.name), `function ${f.name} missing`);
  });

  test("covers the facts that matter most", () => {
    for (const phrase of [
      "left to right",
      "minimum-rule-certainty",
      "top-down-strict",
      "countRelationshipInstances",
      "firstFormObject",
      "mutually-exclusive",
      "Match → Infer → Ask",
      "value=",
      "single quotes",
      "%S",
      "%O",
      "allowUnknown",
      "canAdd",
      "isBeforeDate",
      "http://rbl.io/schema/RBLang",
    ]) {
      assert.ok(text.includes(phrase), `expected the reference to mention "${phrase}"`);
    }
    // firstFormObject must be described as non-existent, not taught.
    assert.match(text, /no\*\* `firstFormObject`|no firstFormObject|only firstForm, secondFormObject and secondFormSubject exist/i);
  });

  test("has nothing volatile in it", () => {
    assert.doesNotMatch(text, /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/, "timestamps would break prompt caching");
    assert.ok(!text.includes("undefined"), "an interpolation produced undefined");
    assert.ok(!text.includes("[object Object]"));
  });

  test("stays within a deliberate size budget", () => {
    assert.ok(text.length > 40_000, `unexpectedly short: ${text.length} chars`);
    assert.ok(text.length < 200_000, `reference grew past the budget: ${text.length} chars — trim or raise the budget deliberately`);
  });

  test("every worked example passes the linter with no errors", () => {
    for (const example of KNOWLEDGE_EXAMPLES) {
      const errors = collectIssues(example.rblang).filter((i) => i.severity === "error");
      assert.deepEqual(
        errors.map((e) => `line ${e.line + 1}: ${e.message}`),
        [],
        `example "${example.title}" has lint errors`
      );
    }
  });

  test("teaches the real skip rule and why plural questions are asked after injection", () => {
    assert.match(text, /only when it has `allowUnknown` or non-empty `knownAnswers`; skipping a question that has known answers keeps them/);
    assert.match(text, /asks a plural question even when facts for it already exist/);
    assert.match(text, /Facts injected below 100% certainty may also be asked again for confirmation, even on a singular relationship/);
    assert.match(text, /`askable="none"` is the modelling choice .* but only when every session injects it/);
    assert.match(BEHAVIOUR_PROMPT, /unanswered: true is accepted only when a question has allowUnknown or knownAnswers/);
    assert.match(BEHAVIOUR_PROMPT, /autoSkipped/);
    assert.match(BEHAVIOUR_PROMPT, /When a question lists alreadyKnown values, skip it yourself only when the user's injected facts cover it/);
    assert.match(BEHAVIOUR_PROMPT, /Send a don't-know skip \(allowUnknown\) only when the user says they don't know/);
  });

  test("behaviour and explain prompts are non-empty and mention the tools they rely on", () => {
    for (const tool of ["get_map_overview", "read_map", "get_diagnostics", "edit_map", "create_map", "lint_rblang", "run_query", "push_map"]) {
      assert.ok(BEHAVIOUR_PROMPT.includes(tool), `behaviour prompt should mention ${tool}`);
    }
    assert.ok(EXPLAIN_SYSTEM_PROMPT.length > 200);
    assert.ok(!EXPLAIN_SYSTEM_PROMPT.includes("edit_map"));
  });
});
