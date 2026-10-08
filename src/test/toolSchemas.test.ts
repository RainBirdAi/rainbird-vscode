import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { TOOL_SCHEMAS, STRICT_TOOLS, validateToolInput, validateAgainstSchema, toApiSchema, JsonSchema } from "../toolSchemas";

describe("tool schemas", () => {
  test("every schema is a closed object", () => {
    for (const [name, schema] of Object.entries(TOOL_SCHEMAS)) {
      assert.equal(schema.type, "object", name);
      assert.equal(schema.additionalProperties, false, `${name} must set additionalProperties:false`);
      for (const key of schema.required ?? []) assert.ok(schema.properties?.[key], `${name}.required lists unknown ${key}`);
    }
  });

  test("strict tools exist and edit_map / run_query / push_map are client-validated", () => {
    for (const name of STRICT_TOOLS) assert.ok(TOOL_SCHEMAS[name], `strict tool ${name} has no schema`);
    for (const name of ["edit_map", "run_query", "push_map"]) assert.ok(!STRICT_TOOLS.has(name));
  });

  test("API schemas carry no minimum/maximum (the Messages API rejects them) but keep everything else", () => {
    for (const [name, schema] of Object.entries(TOOL_SCHEMAS)) {
      const json = JSON.stringify(toApiSchema(schema));
      assert.ok(!json.includes('"minimum"') && !json.includes('"maximum"'), `${name} still has a numeric bound`);
    }
    const api = toApiSchema(TOOL_SCHEMAS.read_map) as { properties: Record<string, JsonSchema> };
    assert.equal(api.properties.start_line.type, "integer");
    assert.equal(api.properties.element.properties?.line.minimum, undefined);
    assert.equal(TOOL_SCHEMAS.read_map.properties?.start_line.minimum, 1, "client-side schema keeps the bound");
  });

  test("validation accepts good inputs", () => {
    assert.equal(validateToolInput("get_map_overview", {}), undefined);
    assert.equal(validateToolInput("read_map", { start_line: 1, end_line: 40 }), undefined);
    assert.equal(validateToolInput("read_map", { element: { kind: "rule", name: "Adults are eligible" } }), undefined);
    assert.equal(
      validateToolInput("edit_map", {
        operations: [
          { op: "insert_element", kind: "concept", xml: '<concept name="X" type="string"/>' },
          { op: "set_attribute", selector: { kind: "rule", name: "R" }, attr: "cf", value: "90" },
          { op: "set_attribute", selector: { line: 12 }, attr: "weight", value: null },
          { op: "replace_text", old_text: "a", new_text: "b" },
        ],
      }),
      undefined
    );
    assert.equal(validateToolInput("run_query", { relationship: "speaks", facts: [{ subject: "J", relationship: "lives in", object: "France" }], answers: [{ answer: "yes" }] }), undefined);
  });

  test("validation rejects bad inputs with a path", () => {
    assert.match(validateToolInput("edit_map", {})!, /operations is required/);
    assert.match(validateToolInput("edit_map", { operations: [{ op: "explode" }] })!, /operations\[0\]\.op must be one of/);
    assert.match(validateToolInput("edit_map", { operations: [{ op: "delete_element", selector: { kind: "rule", line: 0 } }] })!, /line must be at least 1/);
    assert.match(validateToolInput("read_map", { start_line: "3" })!, /start_line must be integer/);
    assert.match(validateToolInput("read_map", { bogus: 1 })!, /bogus is not a recognised field/);
    assert.match(validateToolInput("get_diagnostics", { severity: "loud" })!, /severity must be one of/);
    assert.match(validateToolInput("nope", {})!, /Unknown tool/);
    assert.match(validateToolInput("read_map", "x")!, /must be an object/);
  });

  test("run_query answers teach the real skip rule, value formats and matching", () => {
    const answers = TOOL_SCHEMAS.run_query.properties!.answers;
    const item = answers.items!.properties!;
    assert.match(item.unanswered.description!, /accepted only when the question has allowUnknown or knownAnswers/i);
    assert.match(item.unanswered.description!, /"no more" and the known answers are kept/);
    assert.doesNotMatch(item.unanswered.description!, /\(allowUnknown relationships\)/, "the old, wrong rule");
    assert.match(item.object.description!, /YYYY-MM-DD/);
    assert.match(answers.description!, /matched to each question by relationship/);
    // A skip is the identifying triple without a value.
    assert.equal(validateToolInput("run_query", { relationship: "speaks", sessionId: "s", answers: [{ relationship: "speaks", subject: "Tom", unanswered: true }] }), undefined);
  });

  test("semantic_diff calls pushed-snapshot the last pulled or pushed snapshot", () => {
    assert.match(TOOL_SCHEMAS.semantic_diff.properties!.against.description!, /pushed-snapshot \(the snapshot taken when this file was last pulled or pushed\)/);
  });

  test("validator handles union types and nested arrays", () => {
    const schema: JsonSchema = { type: "object", properties: { v: { type: ["string", "null"] }, xs: { type: "array", items: { type: "integer" } } }, additionalProperties: false };
    assert.equal(validateAgainstSchema({ v: null, xs: [1, 2] }, schema), undefined);
    assert.match(validateAgainstSchema({ v: 3 }, schema)!, /v must be string or null/);
    assert.match(validateAgainstSchema({ xs: [1.5] }, schema)!, /xs\[0\] must be integer/);
  });
});
