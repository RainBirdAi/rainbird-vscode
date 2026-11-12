/**
 * Raelog file names in one place: the extension new files get, the older ones still opened with full
 * support, and the helpers every command uses to recognise and name files. VS Code-free, so it is
 * unit-tested; manifest.test.ts checks that package.json's language contribution lists the same
 * extensions.
 */

/** The extension new files are saved with. */
export const RAELOG_EXTENSION = ".raelog";

/** Older extensions, from before Raelog had its own name. Still recognised everywhere. */
export const LEGACY_EXTENSIONS: readonly string[] = [".rbl", ".rblang"];

/** Every extension recognised as Raelog, the current one first. */
export const RAELOG_EXTENSIONS: readonly string[] = [RAELOG_EXTENSION, ...LEGACY_EXTENSIONS];

/** The same, without dots, for file dialog filters. */
export const RAELOG_FILTER_EXTENSIONS: readonly string[] = RAELOG_EXTENSIONS.map((ext) => ext.slice(1));

/** The extension's files in a workspace: Raelog sources, Studio exports and saved query tests. */
export const WORKSPACE_FILES_GLOB = `**/*.{${[...RAELOG_FILTER_EXTENSIONS, "rbird", "rbtest.json"].join(",")}}`;

const RAELOG_NAME = new RegExp(`\\.(${RAELOG_FILTER_EXTENSIONS.join("|")})$`, "i");

/** Whether a file name or path ends in a Raelog extension (any case). */
export function isRaelogFileName(name: string): boolean {
  return RAELOG_NAME.test(name);
}

/** The name without its Raelog extension; other names are returned as they are. */
export function stripRaelogExtension(name: string): string {
  return name.replace(RAELOG_NAME, "");
}

/** The name to save a new file under: a Raelog or .xml extension is replaced by .raelog, and one is added when missing. */
export function raelogFileName(name: string): string {
  return stripRaelogExtension(name).replace(/\.xml$/i, "") + RAELOG_EXTENSION;
}
