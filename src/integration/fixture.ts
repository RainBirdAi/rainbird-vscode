/**
 * The throwaway VS Code profile and workspace the integration suite runs against, and what they
 * should look like afterwards. Shared by runTest.ts (writes them, checks the disk) and suite.ts
 * (checks inside VS Code), so the expectations live in one place.
 */
import * as fs from "node:fs";
import * as path from "node:path";

export const KM_ID = "504436fb-7fbb-44ea-b36c-bfd977aea8c8";

const HEAD = '<?xml version="1.0" encoding="utf-8"?>\n<rbl:kb xmlns:rbl="http://rbl.io/schema/RBLang">\n';
const BODY = `  <concept name="Person" type="string"/>
  <concept name="Country" type="string"/>
  <concept name="Language" type="string"/>
  <rel name="speaks" subject="Person" object="Language" plural="true" askable="all"/>
  <rel name="lives in" subject="Person" object="Country" askable="all"/>
  <rel name="national language" subject="Country" object="Language" askable="none"/>
  <concinst name="France" type="Country"/>
  <concinst name="French" type="Language"/>
  <relinst type="national language" subject="France" object="French" cf="100"/>
  <relinst type="speaks" cf="75" name="Speaks national language of home country">
    <condition rel="lives in" subject="%S" object="%COUNTRY" weight="100" behaviour="mandatory"/>
    <condition rel="national language" subject="%COUNTRY" object="%O" weight="100" behaviour="mandatory"/>
  </relinst>
`;
/** A valid model. */
export const MODEL = `${HEAD}${BODY}</rbl:kb>\n`;
/** One error: an invalid concept type. */
export const BROKEN = `${HEAD}  <concept name="Person" type="strin"/>\n</rbl:kb>\n`;
/** The valid model with every line's indentation removed, for formatting. */
export const MESSY = MODEL.split("\n").map((line) => line.trimStart()).join("\n");
/** The valid model with an empty rel="" where completions should offer the declared relationships. */
export const COMPLETION = MODEL.replace('rel="lives in"', 'rel=""');

/** Files in the workspace. The first four must open as Raelog: two legacy extensions, the new one, and an association. */
export const FILES: Record<string, string> = {
  "legacy.rbl": MODEL,
  "legacy.rblang": MODEL,
  "model.raelog": MODEL,
  "custom.kb": MODEL,
  "broken.raelog": BROKEN,
  "messy.raelog": MESSY,
  "completion.raelog": COMPLETION,
};
export const OPENS_AS_RAELOG = ["legacy.rbl", "legacy.rblang", "model.raelog", "custom.kb"];
export const RELATIONSHIPS = ["speaks", "lives in", "national language"];

const QUIET = { "workbench.startupEditor": "none", "telemetry.telemetryLevel": "off", "extensions.autoCheckUpdates": false };

/** User settings as an existing user of the "rblang" language id might have them. */
export const USER_SETTINGS = {
  "[rblang]": { "editor.formatOnSave": true, "editor.tabSize": 4 },
  "[raelog]": { "editor.tabSize": 3 },
  "files.associations": { "*.kb": "rblang", "*.foo": "xml" },
  ...QUIET,
};
/** After the migration: [rblang] merged into [raelog] (the existing raelog value wins), associations repointed. */
export const EXPECTED_USER_SETTINGS = {
  "[raelog]": { "editor.formatOnSave": true, "editor.tabSize": 3 },
  "files.associations": { "*.kb": "raelog", "*.foo": "xml" },
  ...QUIET,
};
export const WORKSPACE_SETTINGS = { "[rblang]": { "editor.insertSpaces": false } };
export const EXPECTED_WORKSPACE_SETTINGS = { "[raelog]": { "editor.insertSpaces": false } };
/** What a Raelog file's editor settings should resolve to after the migration. */
export const EXPECTED_EDITOR = { formatOnSave: true, tabSize: 3, insertSpaces: false };

export interface Layout {
  userData: string;
  extensions: string;
  workspace: string;
  userSettings: string;
  workspaceSettings: string;
  snapshots: string;
}

function writeFile(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

/** Write the profile, the workspace and an old-style "<kmID>.rbl" snapshot under `root`. */
export function write(root: string): Layout {
  const userData = path.join(root, "user-data");
  const layout: Layout = {
    userData,
    extensions: path.join(root, "extensions"),
    workspace: path.join(root, "workspace"),
    userSettings: path.join(userData, "User", "settings.json"),
    workspaceSettings: path.join(root, "workspace", ".vscode", "settings.json"),
    snapshots: path.join(userData, "User", "globalStorage", "rainbirdtechnologies.rainbird", "map-snapshots", encodeURIComponent("https://api.rainbird.ai")),
  };
  writeFile(layout.userSettings, JSON.stringify(USER_SETTINGS, null, 2));
  writeFile(layout.workspaceSettings, JSON.stringify(WORKSPACE_SETTINGS, null, 2));
  for (const [name, text] of Object.entries(FILES)) writeFile(path.join(layout.workspace, name), text);
  writeFile(path.join(layout.snapshots, `${KM_ID}.rbl`), MODEL);
  return layout;
}

/** What VS Code and the extension left on disk. */
export function readState(layout: Layout): { userSettings: unknown; workspaceSettings: unknown; snapshots: string[] } {
  const json = (file: string): unknown => JSON.parse(fs.readFileSync(file, "utf8"));
  return { userSettings: json(layout.userSettings), workspaceSettings: json(layout.workspaceSettings), snapshots: fs.readdirSync(layout.snapshots).sort() };
}
