/**
 * Runs the integration checks (suite.ts) in a real VS Code, downloaded into .vscode-test/.
 * It writes a throwaway profile and workspace (fixture.ts), launches VS Code twice (the second
 * launch checks that the one-time migration is safe to repeat), then checks what was left on disk.
 *
 *   npm run test:integration       (CI runs it under xvfb-run on Linux)
 *   VSCODE_TEST_VERSION=1.90.0 npm run test:integration   to try a particular VS Code
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { downloadAndUnzipVSCode, runTests } from "@vscode/test-electron";
import * as fixture from "./fixture";

const repo = path.join(__dirname, "..", "..");

async function main(): Promise<void> {
  const version = process.env.VSCODE_TEST_VERSION ?? "stable";
  // Started from a terminal inside VS Code, these make the new VS Code run as plain Node or reach the parent window.
  for (const key of Object.keys(process.env)) {
    if (key === "ELECTRON_RUN_AS_NODE" || key.startsWith("VSCODE_")) delete process.env[key];
  }
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "rae-integration-"));
  const layout = fixture.write(scratch);
  const downloaded = await downloadAndUnzipVSCode({ version, cachePath: path.join(repo, ".vscode-test") });
  // @vscode/test-electron 2.5 returns .../MacOS/Electron; newer macOS builds name the binary Code.
  const vscodeExecutablePath = fs.existsSync(downloaded) ? downloaded : path.join(path.dirname(downloaded), "Code");

  const states: ReturnType<typeof fixture.readState>[] = [];
  for (const launch of [1, 2]) {
    console.log(`\nVS Code ${version}, launch ${launch} of 2`);
    await runTests({
      vscodeExecutablePath,
      extensionDevelopmentPath: repo,
      extensionTestsPath: path.join(__dirname, "suite"),
      launchArgs: [layout.workspace, `--user-data-dir=${layout.userData}`, `--extensions-dir=${layout.extensions}`],
    });
    states.push(fixture.readState(layout));
  }

  const [first, second] = states;
  const checks: [string, () => void][] = [
    ["user settings.json was rewritten", () => assert.deepEqual(first.userSettings, fixture.EXPECTED_USER_SETTINGS)],
    ["workspace settings.json was rewritten", () => assert.deepEqual(first.workspaceSettings, fixture.EXPECTED_WORKSPACE_SETTINGS)],
    ["the .rbl snapshot was renamed to .raelog", () => assert.deepEqual(first.snapshots, [`${fixture.KM_ID}.raelog`])],
    ["the second launch changed nothing on disk", () => assert.deepEqual(second, first)],
  ];
  let failed = 0;
  console.log("");
  for (const [name, check] of checks) {
    try {
      check();
      console.log(`PASS  ${name}`);
    } catch (error) {
      failed++;
      console.log(`FAIL  ${name}\n      ${String(error instanceof Error ? error.message : error).split("\n").join("\n      ")}`);
    }
  }
  if (failed) throw new Error(`${failed} of ${checks.length} disk checks failed; the profile and workspace are kept in ${scratch}`);
  fs.rmSync(scratch, { recursive: true, force: true });
  console.log("Integration tests passed");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
