/**
 * Raelog file names: which extensions are recognised, how they are stripped, and what a new file is
 * called. Every command that recognises or names a Raelog file goes through these helpers.
 */
import { describe, test } from "node:test";
import * as assert from "node:assert/strict";
import {
  LEGACY_EXTENSIONS,
  RAELOG_EXTENSION,
  RAELOG_EXTENSIONS,
  RAELOG_FILTER_EXTENSIONS,
  WORKSPACE_FILES_GLOB,
  isRaelogFileName,
  raelogFileName,
  stripRaelogExtension,
} from "../fileTypes";

describe("Raelog file types", () => {
  test("extensions: .raelog first, the legacy ones after", () => {
    assert.equal(RAELOG_EXTENSION, ".raelog");
    assert.deepEqual(LEGACY_EXTENSIONS, [".rbl", ".rblang"]);
    assert.deepEqual(RAELOG_EXTENSIONS, [".raelog", ".rbl", ".rblang"]);
    assert.deepEqual(RAELOG_FILTER_EXTENSIONS, ["raelog", "rbl", "rblang"]);
    assert.equal(WORKSPACE_FILES_GLOB, "**/*.{raelog,rbl,rblang,rbird,rbtest.json}");
  });

  test("recognised: every Raelog extension, in any case, as a name or a path", () => {
    for (const name of ["a.raelog", "a.rbl", "a.rblang", "A.RAELOG", "/x/y/model.Rbl"]) assert.ok(isRaelogFileName(name), name);
    for (const name of ["a.xml", "a.rbird", "a.raelog.bak", "raelog", "a.rbtest.json"]) assert.ok(!isRaelogFileName(name), name);
  });

  test("stripping removes only a Raelog extension", () => {
    assert.equal(stripRaelogExtension("eligibility.raelog"), "eligibility");
    assert.equal(stripRaelogExtension("eligibility.RBL"), "eligibility");
    assert.equal(stripRaelogExtension("eligibility.rblang"), "eligibility");
    assert.equal(stripRaelogExtension("eligibility.xml"), "eligibility.xml");
    assert.equal(stripRaelogExtension("map.v2"), "map.v2");
  });

  test("new files are named .raelog whatever extension was asked for", () => {
    assert.equal(raelogFileName("eligibility.raelog"), "eligibility.raelog");
    assert.equal(raelogFileName("eligibility.rbl"), "eligibility.raelog");
    assert.equal(raelogFileName("eligibility.rblang"), "eligibility.raelog");
    assert.equal(raelogFileName("eligibility.xml"), "eligibility.raelog");
    assert.equal(raelogFileName("eligibility"), "eligibility.raelog");
    assert.equal(raelogFileName("risk.v2"), "risk.v2.raelog");
  });
});
