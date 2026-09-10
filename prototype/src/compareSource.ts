/**
 * "What have I changed in the draft since the last saved version?"
 *
 * Each side of the comparison can come from the platform (draft, live, latest
 * or a numbered version via GET /analysis/file), from the open editor, or from
 * a Studio .rbird export / .rbl file. Both sources open side by side in the
 * diff editor (like git diff: added / removed / changed lines highlighted),
 * with the model-level semantic report — "rule X: cf 100 → 75, condition Y now
 * optional" — summarised in the notification and a click away.
 */
import * as vscode from "vscode";
import { getClientSilent } from "./queryRunner";
import { EXPORT_SCHEME, exportUri, readRblang } from "./rbird";
import { buildModel, diffReportDetailed, DiffSide as Side, showSideBySideDiff } from "./semanticDiff";
import { pickPlatformRef, platformUri, resolveKmId } from "./platform";

const EXPORT_FILTER = { "Studio export or RBLang": ["rbird", "rbl", "rblang", "xml"] };

async function fileSide(file: vscode.Uri): Promise<Side> {
  return { label: file.path.split("/").pop() ?? "export", text: await readRblang(file), uri: exportUri(file) };
}

async function pickFileSide(title: string): Promise<Side | undefined> {
  const picked = await vscode.window.showOpenDialog({ title, filters: EXPORT_FILTER, canSelectMany: false });
  return picked?.[0] ? fileSide(picked[0]) : undefined;
}

type Choice = vscode.QuickPickItem & {
  source: "platform-draft" | "platform-version" | "editor" | "clicked" | "file";
};

export function registerCompareSource(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(EXPORT_SCHEME, {
      provideTextDocumentContent: (uri) => readRblang(vscode.Uri.file(decodeURIComponent(uri.query))),
    }),
    vscode.commands.registerCommand("rainbird.compareDraft", (uri?: vscode.Uri) => compareDraft(context, uri))
  );
}

export async function compareDraft(context: vscode.ExtensionContext, clicked?: vscode.Uri): Promise<void> {
  try {
    const client = await getClientSilent(context);
    const editor = vscode.window.activeTextEditor;
    const editorSide: Side | undefined =
      editor?.document.languageId === "rblang"
        ? { label: `${editor.document.uri.path.split("/").pop()} (open editor)`, text: editor.document.getText(), uri: editor.document.uri }
        : undefined;
    let kmId: string | undefined;
    const needKm = async () => (kmId ??= await resolveKmId(context));

    const resolve = async (choice: Choice, role: "draft" | "base"): Promise<Side | undefined> => {
      switch (choice.source) {
        case "platform-draft": {
          const id = await needKm();
          if (!id || !client) return undefined;
          const file = await client.getFile(id);
          return { label: `platform draft`, text: file.rblang, uri: platformUri(id, { kind: "draft" }) };
        }
        case "platform-version": {
          const id = await needKm();
          if (!id || !client) return undefined;
          const pick = await pickPlatformRef(client, id, role === "base" ? "Saved version to compare the draft against" : "Which version is the newer side?", role === "base" ? "latest" : "version");
          if (!pick) return undefined;
          const file = await client.getFile(id, pick.ref.kind === "version" ? pick.ref.version : undefined);
          return { label: `platform ${pick.label}`, text: file.rblang, uri: platformUri(id, pick.ref) };
        }
        case "editor":
          return editorSide;
        case "clicked":
          return clicked ? fileSide(clicked) : undefined;
        case "file":
          return pickFileSide(role === "draft" ? "The newer side — a Studio export or .rbl file" : "The base — a Studio export or .rbl file of the saved version");
      }
    };

    // Newer side.
    const newerChoices: Choice[] = [];
    if (clicked) newerChoices.push({ label: `$(file-zip) This export: ${clicked.path.split("/").pop()}`, source: "clicked" });
    if (client) newerChoices.push({ label: "$(cloud) Platform draft", description: "what Studio currently holds", source: "platform-draft" });
    if (editorSide) newerChoices.push({ label: `$(file) Open editor`, description: editorSide.label, source: "editor" });
    newerChoices.push({ label: "$(folder-opened) A Studio export or .rbl file…", source: "file" });
    if (client) newerChoices.push({ label: "$(history) A platform version…", source: "platform-version" });
    if (!client) newerChoices[0].detail = "Run “Rainbird: Connect” to compare against the platform draft or its versions directly.";
    const newer = await vscode.window.showQuickPick(newerChoices, { title: "Compare — the newer side (your draft)" });
    if (!newer) return;
    const draft = await resolve(newer, "draft");
    if (!draft) return;

    // Base side.
    const baseChoices: Choice[] = [];
    if (client) {
      baseChoices.push({ label: "$(history) A saved version (latest / live / number)", description: "from the platform", source: "platform-version" });
      if (newer.source !== "platform-draft") baseChoices.push({ label: "$(cloud) Platform draft", source: "platform-draft" });
    }
    if (editorSide && newer.source !== "editor") baseChoices.push({ label: "$(file) Open editor", description: editorSide.label, source: "editor" });
    baseChoices.push({ label: "$(folder-opened) A Studio export or .rbl file…", source: "file" });
    const baseChoice = await vscode.window.showQuickPick(baseChoices, { title: `Compare "${draft.label}" against — the base (saved version)` });
    if (!baseChoice) return;
    const base = await resolve(baseChoice, "base");
    if (!base) return;

    const report = diffReportDetailed(buildModel(base.text), buildModel(draft.text), base.label, draft.label);
    report.markdown = report.markdown.replace(
      /^# Semantic diff — .*$/m,
      `# Draft vs saved version — ${draft.label} vs ${base.label}\n\n_Changes are read from **${base.label}** (base) to **${draft.label}** (newer)._`
    );
    await showSideBySideDiff(base, draft, report);
  } catch (error) {
    vscode.window.showErrorMessage(`Could not compare: ${(error as Error).message}`);
  }
}
