/**
 * package.json against the code: one language id everywhere, every contributed command registered,
 * every file the manifest points to present. A rename that misses a spot, or a menu entry with no
 * code behind it, fails here instead of in someone's editor.
 */
import { describe, test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { RAELOG_EXTENSIONS } from "../fileTypes";
import { LANGUAGE_ID } from "../languageMigration";

const root = path.join(__dirname, "..", "..");
const manifest = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const contributes = manifest.contributes;

function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? walk(full) : [full];
  });
}
/** The extension's own source, without tests: what ships. */
const source = walk(path.join(root, "src"))
  .filter((file) => file.endsWith(".ts") && !file.includes(`${path.sep}test${path.sep}`) && !file.includes(`${path.sep}integration${path.sep}`))
  .map((file) => fs.readFileSync(file, "utf8"))
  .join("\n");
const matches = (text: string, pattern: RegExp): string[] => [...text.matchAll(pattern)].map((m) => m[1]);

const raelog = contributes.languages.find((language: { id: string }) => language.id === LANGUAGE_ID);
const declaredCommands: string[] = contributes.commands.map((c: { command: string }) => c.command);
const registeredCommands = new Set(matches(source, /registerCommand\(\s*"([\w.]+)"/g));

describe("package.json: the Raelog language", () => {
  test("is contributed once, named Raelog, with the extensions the code recognises", () => {
    assert.ok(raelog, `no language with id ${LANGUAGE_ID}`);
    assert.equal(raelog.aliases[0], "Raelog");
    assert.deepEqual(raelog.extensions, RAELOG_EXTENSIONS);
  });

  test("grammars and snippets are for that language, and the grammar's scope matches its file", () => {
    for (const grammar of contributes.grammars) {
      assert.equal(grammar.language, LANGUAGE_ID);
      const file = JSON.parse(fs.readFileSync(path.join(root, grammar.path), "utf8"));
      assert.equal(file.scopeName, grammar.scopeName, grammar.path);
      assert.ok(grammar.scopeName.endsWith(`.${LANGUAGE_ID}`), grammar.scopeName);
    }
    for (const snippets of contributes.snippets) assert.equal(snippets.language, LANGUAGE_ID);
  });

  test("editor defaults, activation events and menu conditions use the same id", () => {
    const languageDefaults = Object.keys(contributes.configurationDefaults).filter((key) => key.startsWith("["));
    assert.deepEqual(languageDefaults, [`[${LANGUAGE_ID}]`]);
    const onLanguage = manifest.activationEvents.filter((e: string) => e.startsWith("onLanguage:"));
    assert.ok(onLanguage.includes(`onLanguage:${LANGUAGE_ID}`));
    for (const ext of RAELOG_EXTENSIONS) assert.ok(manifest.activationEvents.includes(`workspaceContains:**/*${ext}`), `no workspaceContains for ${ext}`);
    const conditions = matches(JSON.stringify(contributes.menus), /editorLangId == ([\w-]+)/g);
    assert.ok(conditions.length > 0, "no editorLangId conditions found");
    assert.deepEqual([...new Set(conditions)], [LANGUAGE_ID]);
  });

  test("the code compares, assigns and registers the same id", () => {
    const ids = [
      ...matches(source, /languageId\s*(?:===|!==|==|!=)\s*"([\w-]+)"/g),
      ...matches(source, /setTextDocumentLanguage\([^,]+,\s*"([\w-]+)"/g),
      ...matches(source, /register\w+Provider\(\s*"([\w-]+)"/g),
    ];
    assert.ok(ids.length > 10, `only ${ids.length} language id uses found; did the patterns stop matching?`);
    assert.deepEqual([...new Set(ids)], [LANGUAGE_ID]);
    // Documents opened in another language are reports (JSON, Markdown); anything else is a typo or a leftover.
    for (const id of matches(source, /\blanguage:\s*"([\w-]+)"/g)) assert.ok([LANGUAGE_ID, "json", "markdown"].includes(id), `language: "${id}"`);
  });
});

describe("package.json: commands", () => {
  test("every contributed command is registered in the code", () => {
    const missing = declaredCommands.filter((id) => !registeredCommands.has(id));
    assert.deepEqual(missing, [], "contributed but never registered");
  });

  test("menus only use contributed commands", () => {
    const used = Object.values(contributes.menus).flatMap((items) => (items as { command?: string }[]).map((item) => item.command));
    const unknown = used.filter((id) => id && !declaredCommands.includes(id));
    assert.deepEqual(unknown, []);
  });

  test("command: links in welcome views and the walkthrough point at registered commands", () => {
    const texts = [
      ...contributes.viewsWelcome.map((view: { contents: string }) => view.contents),
      ...contributes.walkthroughs.flatMap((w: { steps: { description: string }[] }) => w.steps.map((s) => s.description)),
    ];
    const links = texts.flatMap((text) => matches(text, /\(command:([\w.]+)\)/g));
    assert.ok(links.length > 0);
    assert.deepEqual(links.filter((id) => !registeredCommands.has(id)), []);
  });

  test("commands shown in the Command Palette are titled Rae: …", () => {
    const hidden = new Set(contributes.menus.commandPalette.filter((m: { when: string }) => m.when === "false").map((m: { command: string }) => m.command));
    const untitled = contributes.commands
      .filter((c: { command: string; title: string }) => !hidden.has(c.command) && !c.title.startsWith("Rae: "))
      .map((c: { title: string }) => c.title);
    assert.deepEqual(untitled, []);
  });
});

describe("package.json: files", () => {
  test("every file the manifest points to exists", () => {
    const files: string[] = [manifest.icon];
    for (const language of contributes.languages) {
      if (language.configuration) files.push(language.configuration);
      if (language.icon) files.push(language.icon.light, language.icon.dark);
    }
    for (const grammar of contributes.grammars) files.push(grammar.path);
    for (const snippets of contributes.snippets) files.push(snippets.path);
    for (const container of contributes.viewsContainers.activitybar) files.push(container.icon);
    for (const views of Object.values(contributes.views) as { icon?: string }[][]) for (const view of views) if (view.icon) files.push(view.icon);
    for (const walkthrough of contributes.walkthroughs) {
      for (const step of walkthrough.steps) for (const media of Object.values(step.media ?? {}) as string[]) files.push(media);
    }
    const missing = files.filter((file) => !fs.existsSync(path.join(root, file)));
    assert.deepEqual(missing, []);
  });

  test("the example the walkthrough opens exists", () => {
    const opened = matches(source, /"examples",\s*"([^"]+)"/g);
    assert.ok(opened.length > 0, "rainbird.openExample no longer names its file");
    for (const file of opened) assert.ok(fs.existsSync(path.join(root, "examples", file)), `examples/${file}`);
  });
});
