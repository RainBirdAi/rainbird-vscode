/**
 * One-time moves after the language id changed from "rblang" to "raelog", run at activation and
 * safe to repeat (each step only acts when there is something old left):
 *
 * - "[rblang]" language settings move to "[raelog]" in user, workspace and (multi-root) folder
 *   settings, and files.associations entries that say "rblang" say "raelog";
 * - snapshots saved as "<kmID>.rbl" under globalStorage/map-snapshots are renamed to ".raelog",
 *   so diffs against the last pulled or pushed draft keep working.
 *
 * Nothing here may stop the extension from starting: every failure is logged and skipped.
 */
import * as vscode from "vscode";
import { LANGUAGE_ID, LEGACY_LANGUAGE_ID, mergeLanguageSettings, migrateAssociations, migratedSnapshotName } from "./languageMigration";
import { appendRainbirdLog } from "./platformDiagnostics";

const LEGACY_SECTION = `[${LEGACY_LANGUAGE_ID}]`;
const SECTION = `[${LANGUAGE_ID}]`;

type ValueKey = "globalValue" | "workspaceValue" | "workspaceFolderValue";
interface Scope {
  label: string;
  config: vscode.WorkspaceConfiguration;
  target: vscode.ConfigurationTarget;
  key: ValueKey;
}

function settingsScopes(): Scope[] {
  const scopes: Scope[] = [
    { label: "user settings", config: vscode.workspace.getConfiguration(), target: vscode.ConfigurationTarget.Global, key: "globalValue" },
  ];
  if (vscode.workspace.workspaceFolders?.length) {
    scopes.push({ label: "workspace settings", config: vscode.workspace.getConfiguration(), target: vscode.ConfigurationTarget.Workspace, key: "workspaceValue" });
  }
  // A single-folder workspace's folder settings are its workspace settings; only multi-root has more.
  if (vscode.workspace.workspaceFile) {
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      scopes.push({
        label: `folder settings of ${folder.name}`,
        config: vscode.workspace.getConfiguration(undefined, folder.uri),
        target: vscode.ConfigurationTarget.WorkspaceFolder,
        key: "workspaceFolderValue",
      });
    }
  }
  return scopes;
}

async function migrateSettings(): Promise<string[]> {
  const moved: string[] = [];
  for (const scope of settingsScopes()) {
    try {
      const legacy = scope.config.inspect<Record<string, unknown>>(LEGACY_SECTION)?.[scope.key];
      const current = scope.config.inspect<Record<string, unknown>>(SECTION)?.[scope.key];
      const merged = mergeLanguageSettings(legacy, current);
      if (merged) {
        await scope.config.update(SECTION, merged, scope.target);
        await scope.config.update(LEGACY_SECTION, undefined, scope.target);
        moved.push(`${LEGACY_SECTION} → ${SECTION} in ${scope.label}`);
      }
      const associations = migrateAssociations(scope.config.inspect<Record<string, unknown>>("files.associations")?.[scope.key]);
      if (associations) {
        await scope.config.update("files.associations", associations, scope.target);
        moved.push(`files.associations in ${scope.label}`);
      }
    } catch (error) {
      appendRainbirdLog(`Could not migrate ${scope.label} from the "${LEGACY_LANGUAGE_ID}" language id`, [String(error)]);
    }
  }
  return moved;
}

async function migrateSnapshots(context: vscode.ExtensionContext): Promise<number> {
  const root = vscode.Uri.joinPath(context.globalStorageUri, "map-snapshots");
  let environments: [string, vscode.FileType][];
  try {
    environments = await vscode.workspace.fs.readDirectory(root);
  } catch {
    return 0; // no snapshots yet
  }
  let renamed = 0;
  for (const [environment, type] of environments) {
    if (type !== vscode.FileType.Directory) continue;
    const dir = vscode.Uri.joinPath(root, environment);
    for (const [name, fileType] of await vscode.workspace.fs.readDirectory(dir).then(undefined, () => [] as [string, vscode.FileType][])) {
      const next = fileType === vscode.FileType.File ? migratedSnapshotName(name) : undefined;
      if (!next) continue;
      const from = vscode.Uri.joinPath(dir, name);
      try {
        await vscode.workspace.fs.rename(from, vscode.Uri.joinPath(dir, next), { overwrite: false });
        renamed++;
      } catch {
        // A .raelog snapshot already exists: it was written after the rename, so it is the newer one.
        await vscode.workspace.fs.delete(from).then(undefined, () => undefined);
      }
    }
  }
  return renamed;
}

/** Runs both moves; resolves when done and never rejects. Snapshots first, as quick diff reads them. */
export async function migrateFromLegacyLanguageId(context: vscode.ExtensionContext): Promise<void> {
  try {
    const snapshots = await migrateSnapshots(context);
    if (snapshots) appendRainbirdLog(`Renamed ${snapshots} model snapshot${snapshots === 1 ? "" : "s"} from .rbl to .raelog`);
    const moved = await migrateSettings();
    if (moved.length) {
      appendRainbirdLog("Moved settings to the Raelog language id", moved);
      void vscode.window.showInformationMessage(
        `Raelog files now use the language id "${LANGUAGE_ID}". Your "${LEGACY_SECTION}" settings and file associations were moved to "${SECTION}".`
      );
    }
  } catch (error) {
    appendRainbirdLog("Migration from the old language id failed", [String(error)]);
  }
}
