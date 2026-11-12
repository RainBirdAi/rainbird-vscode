/**
 * Integration checks, run inside a real VS Code by runTest.ts (its extensionTestsPath) against the
 * extension loaded from this repository. Each check uses VS Code's own APIs, so it covers the glue
 * the unit tests cannot reach: activation, language registration, providers, commands and the
 * migration from the old "rblang" id. run() rejects when any check fails, and VS Code then exits
 * non-zero.
 */
import * as assert from "node:assert/strict";
import * as vscode from "vscode";
import * as fixture from "./fixture";

const EXTENSION_ID = "RainbirdTechnologies.rainbird";
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Read `read` until `done` holds or `ms` pass; the last value either way. */
async function until<T>(read: () => T | Thenable<T>, done: (value: T) => boolean, ms = 15000): Promise<T> {
  const deadline = Date.now() + ms;
  let value = await read();
  while (!done(value) && Date.now() < deadline) {
    await sleep(200);
    value = await read();
  }
  return value;
}

const uri = (name: string) => vscode.Uri.joinPath(vscode.workspace.workspaceFolders![0].uri, name);
async function open(name: string): Promise<vscode.TextDocument> {
  const doc = await vscode.workspace.openTextDocument(uri(name));
  await vscode.window.showTextDocument(doc);
  return doc;
}
function symbolNames(symbols: (vscode.DocumentSymbol | vscode.SymbolInformation)[]): string[] {
  return symbols.flatMap((s) => [s.name, ...("children" in s ? symbolNames(s.children) : [])]);
}

const checks: [string, () => Promise<void>][] = [
  ["the extension activates", async () => {
    const extension = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(extension, `${EXTENSION_ID} not loaded`);
    await extension.activate();
    assert.ok(extension.isActive);
  }],
  ["raelog is a registered language and rblang is not", async () => {
    const ids = await vscode.languages.getLanguages();
    assert.ok(ids.includes("raelog"));
    assert.ok(!ids.includes("rblang"));
  }],
  ["every contributed command is registered", async () => {
    const declared = (vscode.extensions.getExtension(EXTENSION_ID)!.packageJSON.contributes.commands as { command: string }[]).map((c) => c.command);
    const registered = new Set(await vscode.commands.getCommands(true));
    assert.deepEqual(declared.filter((id) => !registered.has(id)), []);
  }],
  ["[rblang] settings and file associations moved to raelog", async () => {
    const config = () => vscode.workspace.getConfiguration();
    // The migration runs in the background from activate(); wait for it.
    await until(() => config().inspect("[rblang]"), (v) => v?.globalValue === undefined && v?.workspaceValue === undefined);
    const c = config();
    assert.equal(c.inspect("[rblang]")?.globalValue, undefined);
    assert.equal(c.inspect("[rblang]")?.workspaceValue, undefined);
    assert.deepEqual(c.inspect("[raelog]")?.globalValue, fixture.EXPECTED_USER_SETTINGS["[raelog]"]);
    assert.deepEqual(c.inspect("[raelog]")?.workspaceValue, fixture.EXPECTED_WORKSPACE_SETTINGS["[raelog]"]);
    assert.deepEqual(c.inspect("files.associations")?.globalValue, fixture.EXPECTED_USER_SETTINGS["files.associations"]);
    const editor = vscode.workspace.getConfiguration("editor", { languageId: "raelog" });
    assert.deepEqual(
      { formatOnSave: editor.get("formatOnSave"), tabSize: editor.get("tabSize"), insertSpaces: editor.get("insertSpaces") },
      fixture.EXPECTED_EDITOR
    );
  }],
  ["legacy extensions, .raelog and associated files open as Raelog", async () => {
    for (const name of fixture.OPENS_AS_RAELOG) assert.equal((await open(name)).languageId, "raelog", name);
  }],
  ["diagnostics come from the raelog linter", async () => {
    const doc = await open("broken.raelog");
    const diagnostics = await until(() => vscode.languages.getDiagnostics(doc.uri), (d) => d.length > 0);
    assert.ok(diagnostics.length > 0, "no diagnostics");
    assert.deepEqual([...new Set(diagnostics.map((d) => d.source))], ["raelog"]);
    assert.ok(diagnostics.some((d) => d.message.includes('type="strin"')), diagnostics.map((d) => d.message).join(" | "));
  }],
  ["document symbols list the model's concepts and relationships", async () => {
    const doc = await open("model.raelog");
    const symbols = await until(
      () => vscode.commands.executeCommand<(vscode.DocumentSymbol | vscode.SymbolInformation)[]>("vscode.executeDocumentSymbolProvider", doc.uri),
      (s) => Array.isArray(s) && s.length > 0
    );
    const names = symbolNames(symbols ?? []);
    for (const name of ["Person", "Language", "speaks"]) assert.ok(names.includes(name), `${name} not in ${names.join(", ")}`);
  }],
  ["completions inside rel=\"\" offer the declared relationships", async () => {
    const doc = await open("completion.raelog");
    const position = doc.positionAt(doc.getText().indexOf('rel=""') + 'rel="'.length);
    const list = await vscode.commands.executeCommand<vscode.CompletionList>("vscode.executeCompletionItemProvider", doc.uri, position);
    const labels = list.items.map((item) => (typeof item.label === "string" ? item.label : item.label.label));
    for (const rel of fixture.RELATIONSHIPS) assert.ok(labels.includes(rel), `${rel} not offered`);
  }],
  ["hovering an element shows its documentation", async () => {
    const doc = await open("model.raelog");
    const position = doc.positionAt(doc.getText().indexOf("<concept") + 3);
    const hovers = await vscode.commands.executeCommand<vscode.Hover[]>("vscode.executeHoverProvider", doc.uri, position);
    assert.ok(hovers.length > 0, "no hover");
  }],
  ["formatting re-indents a model with no indentation", async () => {
    const doc = await open("messy.raelog");
    const edits = await vscode.commands.executeCommand<vscode.TextEdit[]>("vscode.executeFormatDocumentProvider", doc.uri, { tabSize: 2, insertSpaces: true });
    assert.ok(edits && edits.length > 0, "no formatting edits");
  }],
  ["Open example opens hello-world.raelog as Raelog", async () => {
    await vscode.commands.executeCommand("rainbird.openExample");
    const doc = vscode.window.activeTextEditor?.document;
    assert.ok(doc?.uri.path.endsWith("/examples/hello-world.raelog"), doc?.uri.path);
    assert.equal(doc?.languageId, "raelog");
  }],
  ["the graph view opens for the open model", async () => {
    await open("model.raelog");
    await vscode.commands.executeCommand("rainbird.openGraphView");
  }],
];

export async function run(): Promise<void> {
  const failed: string[] = [];
  for (const [name, check] of checks) {
    try {
      await check();
      console.log(`PASS  ${name}`);
    } catch (error) {
      failed.push(name);
      const message = error instanceof Error ? error.message : String(error);
      console.log(`FAIL  ${name}\n      ${message.split("\n").join("\n      ")}`);
    }
  }
  if (failed.length) throw new Error(`${failed.length} of ${checks.length} integration checks failed: ${failed.join("; ")}`);
  console.log(`All ${checks.length} checks inside VS Code passed`);
}
