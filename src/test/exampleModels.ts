/**
 * The bundled example models, for tests that run over all of them. It fails when the well-known
 * examples are missing, so a renamed extension or a moved folder cannot quietly turn those tests
 * into loops over nothing.
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { isRaelogFileName } from "../fileTypes";

export const EXAMPLES_DIR = path.join(__dirname, "..", "..", "examples");
const REQUIRED = ["hello-world.raelog", "eligibility.raelog", "bigger_map.raelog"];

/** Absolute paths of the example models: the top level only, or every folder with `recursive`. */
export function exampleModels(options: { recursive?: boolean } = {}): string[] {
  const list = (dir: string): string[] =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) return options.recursive && !entry.name.startsWith(".") ? list(full) : [];
      return isRaelogFileName(entry.name) ? [full] : [];
    });
  const files = list(EXAMPLES_DIR);
  const names = files.map((file) => path.basename(file));
  for (const required of REQUIRED) {
    assert.ok(names.includes(required), `examples/${required} is missing (found ${names.length} example models)`);
  }
  return files;
}
