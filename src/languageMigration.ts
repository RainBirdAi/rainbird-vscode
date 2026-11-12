/**
 * Moving users from the language id "rblang" to "raelog". These helpers decide what moves; they
 * have no VS Code dependency so the rules are unit-tested. migrate.ts applies them to each
 * settings scope and to the snapshot files on disk.
 */

/** The language id before Raelog got its own name. Only read, to migrate what users set for it. */
export const LEGACY_LANGUAGE_ID = "rblang";
export const LANGUAGE_ID = "raelog";

type Settings = Record<string, unknown>;

/**
 * What to write under "[raelog]" given the "[rblang]" and "[raelog]" blocks of one settings scope,
 * or undefined when there is nothing to move. A setting already made for raelog wins.
 */
export function mergeLanguageSettings(legacy: Settings | undefined, current: Settings | undefined): Settings | undefined {
  if (!legacy || typeof legacy !== "object" || Object.keys(legacy).length === 0) return undefined;
  return { ...legacy, ...(current ?? {}) };
}

/** files.associations with every "rblang" value pointed at "raelog", or undefined when none is. */
export function migrateAssociations(associations: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!associations || typeof associations !== "object") return undefined;
  let changed = false;
  const next: Record<string, unknown> = {};
  for (const [pattern, language] of Object.entries(associations)) {
    if (language === LEGACY_LANGUAGE_ID) {
      next[pattern] = LANGUAGE_ID;
      changed = true;
    } else {
      next[pattern] = language;
    }
  }
  return changed ? next : undefined;
}

/** The new name for a snapshot file saved as "<kmID>.rbl", or undefined for any other file. */
export function migratedSnapshotName(name: string): string | undefined {
  return /\.rbl$/i.test(name) ? name.replace(/\.rbl$/i, ".raelog") : undefined;
}
