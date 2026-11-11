/**
 * The rules for moving users from the "rblang" language id to "raelog": which language
 * settings move and which win, how file associations change, and which snapshot files are renamed.
 */
import { describe, test } from "node:test";
import * as assert from "node:assert/strict";
import { LANGUAGE_ID, LEGACY_LANGUAGE_ID, mergeLanguageSettings, migrateAssociations, migratedSnapshotName } from "../languageMigration";

describe("language id migration", () => {
  test("ids", () => {
    assert.equal(LEGACY_LANGUAGE_ID, "rblang");
    assert.equal(LANGUAGE_ID, "raelog");
  });

  test("[rblang] settings move to [raelog]; a setting already made for raelog wins", () => {
    assert.deepEqual(mergeLanguageSettings({ "editor.formatOnSave": true, "editor.tabSize": 4 }, undefined), {
      "editor.formatOnSave": true,
      "editor.tabSize": 4,
    });
    assert.deepEqual(mergeLanguageSettings({ "editor.tabSize": 4, "editor.formatOnSave": true }, { "editor.tabSize": 2 }), {
      "editor.tabSize": 2,
      "editor.formatOnSave": true,
    });
  });

  test("nothing to move when there are no [rblang] settings", () => {
    assert.equal(mergeLanguageSettings(undefined, { "editor.tabSize": 2 }), undefined);
    assert.equal(mergeLanguageSettings({}, undefined), undefined);
  });

  test("files.associations that say rblang say raelog; others are kept", () => {
    assert.deepEqual(migrateAssociations({ "*.kb": "rblang", "*.foo": "xml" }), { "*.kb": "raelog", "*.foo": "xml" });
    assert.equal(migrateAssociations({ "*.foo": "xml" }), undefined, "unchanged means no write");
    assert.equal(migrateAssociations(undefined), undefined);
  });

  test("snapshot files: <kmID>.rbl becomes <kmID>.raelog; anything else is left alone", () => {
    assert.equal(migratedSnapshotName("504436fb-7fbb-44ea-b36c-bfd977aea8c8.rbl"), "504436fb-7fbb-44ea-b36c-bfd977aea8c8.raelog");
    assert.equal(migratedSnapshotName("km-1.RBL"), "km-1.raelog");
    assert.equal(migratedSnapshotName("km-1.raelog"), undefined);
    assert.equal(migratedSnapshotName("km-1.rbird"), undefined);
  });
});
