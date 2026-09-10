/**
 * Unit tests for the parts of the platform client that are pure: reading a
 * POST /maps response. The fixtures are bodies captured from api.rainbird.ai.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { parseCreateMapResponse } from "../api";

describe("parseCreateMapResponse", () => {
  test("a 201 with an error field: the map exists AND carries a validation message", () => {
    // Captured 2026-09-10 pushing examples/broken/diagnostics-tour.rbl.
    const result = parseCreateMapResponse({
      kmID: "6428f29c-cd76-4537-bd18-7f467a6e3995",
      id: "36167",
      error: "Line: 35 - Datasource hostname must start with 'http://' or 'https://' followed by a valid hostname.",
    });
    assert.equal(result.kmId, "6428f29c-cd76-4537-bd18-7f467a6e3995");
    assert.deepEqual(result.validation, ["Line: 35 - Datasource hostname must start with 'http://' or 'https://' followed by a valid hostname."]);
  });

  test("a clean 201 has no validation messages", () => {
    const result = parseCreateMapResponse({ kmID: "abc", id: "1" });
    assert.equal(result.kmId, "abc");
    assert.deepEqual(result.validation, []);
  });

  test("array-shaped errors and nested payloads are read too", () => {
    const result = parseCreateMapResponse({ map: { kmId: "nested" }, errors: ["one", { message: "two" }] });
    assert.equal(result.kmId, "nested");
    assert.deepEqual(result.validation, ["one", "two"]);
  });

  test("the numeric id is never mistaken for the kmID", () => {
    assert.equal(parseCreateMapResponse({ id: "36167" }).kmId, undefined);
  });
});
