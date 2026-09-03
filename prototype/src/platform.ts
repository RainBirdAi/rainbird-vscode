/**
 * The platform as a source of RBLang. GET /analysis/file/{kmID}[?version=N]
 * returns a map's RBLang (draft by default, or any saved version), which makes
 * three things possible that were not before: pull a map into the editor, open
 * the real platform draft from the Maps view, and diff the open file against
 * what the platform actually holds. Platform content is exposed as read-only
 * virtual documents (rainbird-platform:/{kmID}/draft.rbl or /v{N}.rbl) so it
 * can be diffed and browsed without ever pretending to be a local file.
 */
import * as vscode from "vscode";
import { RainbirdClient } from "./api";
import { getClient, getClientSilent } from "./queryRunner";
import { buildModel, diffReport } from "./semanticDiff";

export const PLATFORM_SCHEME = "rainbird-platform";

export type SourceRef = { kind: "draft" } | { kind: "version"; version: number };

export function platformUri(kmId: string, ref: SourceRef): vscode.Uri {
  const name = ref.kind === "draft" ? "draft" : `v${ref.version}`;
  return vscode.Uri.from({ scheme: PLATFORM_SCHEME, path: `/${kmId}/${name}.rbl` });
}

function parsePlatformUri(uri: vscode.Uri): { kmId: string; ref: SourceRef } | undefined {
  const m = /^\/([^/]+)\/(draft|v(\d+))\.rbl$/.exec(uri.path);
  if (!m) return undefined;
  return { kmId: m[1], ref: m[2] === "draft" ? { kind: "draft" } : { kind: "version", version: Number(m[3]) } };
}

/** The kmID the active file is bound to: the workspace setting, else the map it was last pushed as, else ask. */
export async function resolveKmId(context: vscode.ExtensionContext): Promise<string | undefined> {
  const editor = vscode.window.activeTextEditor;
  const config = vscode.workspace.getConfiguration("rainbird", editor?.document.uri);
  const configured = config.get<string>("knowledgeMapId");
  if (configured) return configured;
  if (editor) {
    const pushed = context.workspaceState.get<string>(`rainbird.pushedKm.${editor.document.uri.toString()}`);
    if (pushed) return pushed;
  }
  const typed = await vscode.window.showInputBox({
    prompt: "Knowledge Map ID (from the Publish page in Studio)",
    ignoreFocusOut: true,
  });
  if (typed) await config.update("knowledgeMapId", typed.trim(), vscode.ConfigurationTarget.Workspace);
  return typed?.trim() || undefined;
}

export interface PlatformPick {
  ref: SourceRef;
  label: string;
}

/**
 * Let the user choose which platform state to read: the draft, the live
 * version, the latest saved version, or a specific number. Resolves "live"
 * and "latest" to concrete version numbers so the label is exact.
 */
export async function pickPlatformRef(
  client: RainbirdClient,
  kmId: string,
  title: string,
  preferred: "draft" | "latest" | "live" | "version"
): Promise<PlatformPick | undefined> {
  type Item = vscode.QuickPickItem & { choice: "draft" | "latest" | "live" | "version" };
  const all: Item[] = [
    { label: "$(cloud) Draft", description: "the editable working copy", choice: "draft" },
    { label: "$(history) Latest saved version", description: "the most recent version snapshot", choice: "latest" },
    { label: "$(broadcast) Live version", description: "the version currently serving decisions", choice: "live" },
    { label: "$(symbol-number) Version number…", description: "a specific saved version", choice: "version" },
  ];
  const ordered = [...all.filter((i) => i.choice === preferred), ...all.filter((i) => i.choice !== preferred)];
  const picked = await vscode.window.showQuickPick(ordered, { title });
  if (!picked) return undefined;

  if (picked.choice === "draft") return { ref: { kind: "draft" }, label: "draft" };

  if (picked.choice === "latest") {
    const latest = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: "Rainbird: finding the latest saved version…" },
      () => client.latestVersion(kmId)
    );
    if (latest === undefined) {
      vscode.window.showInformationMessage("This map has no saved versions yet — create one in Studio (Versions → Create version).");
      return undefined;
    }
    return { ref: { kind: "version", version: latest }, label: `version ${latest} (latest)` };
  }

  if (picked.choice === "live") {
    const sessionId = await client.start(kmId, {});
    const info = await client.sessionInfo(sessionId);
    const km = (info.km ?? {}) as Record<string, unknown>;
    if (km.versionStatus === "Draft" || typeof km.versionNumber !== "number") {
      vscode.window.showInformationMessage("This map has no live version — the engine is serving the draft. Set a version live in Studio first.");
      return undefined;
    }
    return { ref: { kind: "version", version: km.versionNumber }, label: `version ${km.versionNumber} (live)` };
  }

  const raw = await vscode.window.showInputBox({
    prompt: "Version number (from the map's Versions page in Studio)",
    validateInput: (v) => (/^\d+$/.test(v.trim()) && Number(v) > 0 ? undefined : "Enter a positive whole number"),
  });
  if (!raw) return undefined;
  return { ref: { kind: "version", version: Number(raw.trim()) }, label: `version ${raw.trim()}` };
}

export function registerPlatformSource(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(PLATFORM_SCHEME, {
      async provideTextDocumentContent(uri) {
        const parsed = parsePlatformUri(uri);
        if (!parsed) throw new Error(`Not a Rainbird platform URI: ${uri.toString()}`);
        const client = await getClientSilent(context);
        if (!client) throw new Error("Not connected — run “Rainbird: Connect” first.");
        const file = await client.getFile(parsed.kmId, parsed.ref.kind === "version" ? parsed.ref.version : undefined);
        return file.rblang;
      },
    }),
    vscode.commands.registerCommand("rainbird.pullMap", () => pullMap(context)),
    vscode.commands.registerCommand("rainbird.diffAgainstDraft", () => diffAgainstDraft(context))
  );
}

/** Open a map's RBLang from the platform (draft or a version) as a read-only document, with Save As. */
async function pullMap(context: vscode.ExtensionContext): Promise<void> {
  const client = await getClient(context);
  if (!client) return;
  const kmId = await resolveKmId(context);
  if (!kmId) return;
  const pick = await pickPlatformRef(client, kmId, "Pull which state of the map?", "draft");
  if (!pick) return;
  try {
    const doc = await vscode.workspace.openTextDocument(platformUri(kmId, pick.ref));
    await vscode.window.showTextDocument(doc, { preview: false });
    const action = await vscode.window.showInformationMessage(
      `Read-only RBLang of the platform ${pick.label} for ${kmId}. Save a local copy to edit it.`,
      "Save as .rbl…"
    );
    if (action) {
      const target = await vscode.window.showSaveDialog({
        filters: { RBLang: ["rbl"] },
        defaultUri: vscode.workspace.workspaceFolders?.[0]
          ? vscode.Uri.joinPath(vscode.workspace.workspaceFolders[0].uri, `${kmId.slice(0, 8)}-${pick.ref.kind === "draft" ? "draft" : `v${pick.ref.version}`}.rbl`)
          : undefined,
      });
      if (target) {
        await vscode.workspace.fs.writeFile(target, Buffer.from(doc.getText(), "utf8"));
        await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(target));
      }
    }
  } catch (error) {
    vscode.window.showErrorMessage(`Could not pull the map: ${(error as Error).message}`);
  }
}

/** Compare the open .rbl with what the platform draft actually holds — the honest "am I in sync?" check. */
async function diffAgainstDraft(context: vscode.ExtensionContext): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document.languageId !== "rblang") {
    vscode.window.showInformationMessage("Open the RBLang (.rbl) file you want to compare first.");
    return;
  }
  const client = await getClient(context);
  if (!client) return;
  const kmId = await resolveKmId(context);
  if (!kmId) return;
  try {
    const file = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: "Rainbird: fetching the platform draft…" },
      () => client.getFile(kmId)
    );
    const local = editor.document.getText();
    const name = editor.document.uri.path.split("/").pop() ?? "local";
    if (file.rblang.trim() === local.trim()) {
      vscode.window.showInformationMessage(`${name} matches the platform draft of ${kmId} exactly.`);
      return;
    }
    const report = diffReport(buildModel(file.rblang), buildModel(local), `platform draft (${kmId})`, name).replace(
      /^# Semantic diff — .*$/m,
      `# Local file vs platform draft — ${name} vs ${kmId}\n\n_Changes are read from the platform draft to your local file: ＋ means your file has it and the draft does not._`
    );
    const md = await vscode.workspace.openTextDocument({ language: "markdown", content: report });
    await vscode.window.showTextDocument(md, { preview: false });
    await vscode.commands.executeCommand("markdown.showPreview", md.uri);
    const open = await vscode.window.showInformationMessage("Semantic report opened.", "Open side-by-side text diff");
    if (open) {
      await vscode.commands.executeCommand("vscode.diff", platformUri(kmId, { kind: "draft" }), editor.document.uri, `platform draft ↔ ${name}`);
    }
  } catch (error) {
    vscode.window.showErrorMessage(`Could not fetch the platform draft: ${(error as Error).message}`);
  }
}
