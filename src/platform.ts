/**
 * The platform as a source of RBLang, and which map a file belongs to.
 *
 * GET /analysis/file/{kmID}[?version=N] returns a map's RBLang (draft by
 * default, or any saved version). It is verified live but not in the public
 * API reference, and the API has no way to list an account's maps, so every
 * route starts from a Knowledge Map ID. Built on it: open a map by its ID into
 * an editable .rbl bound to that map, pull the draft or a version as a
 * read-only virtual document (rainbird-platform:/{kmID}/draft.rbl or
 * /v{N}.rbl) so it can be diffed and browsed without pretending to be a local
 * file, and diff the open file against what the platform draft holds.
 *
 * Which map: one precedence everywhere — an explicit override, then the
 * file's own binding, then the resource-scoped rainbird.knowledgeMapId
 * setting (the workspace default), then a prompt. The binding lives in
 * workspaceState "rainbird.pushedKm.<document uri>" (named after its first
 * writer, push) and is written by Open Map by Knowledge Map ID, Pull → Save
 * as .rbl, push and the Bind command. A file saved from a saved version also
 * gets "rainbird.pulledVersion.<document uri>", so quick diff does not compare
 * it with the map's snapshot, which records the draft.
 */
import * as os from "os";
import * as vscode from "vscode";
import { ApiError, RainbirdClient, unknownMapMessage } from "./api";
import { defaultFileName, extractKmId, normaliseKmId, sameKmId } from "./kmId";
import { KNOWN_MAP_SOURCE_LABELS, KnownMap, SNAPSHOT_SCHEME, knownMaps, recordKnownMap, snapshotUri } from "./mapsTree";
import { getClient, getClientSilent } from "./queryRunner";
import { buildModel, diffReportDetailed, showSideBySideDiff } from "./semanticDiff";

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

function apiUrl(): string {
  return vscode.workspace.getConfiguration("rainbird").get<string>("apiUrl") ?? "https://api.rainbird.ai";
}

function fileName(uri: vscode.Uri): string {
  return uri.path.split("/").pop() || uri.toString();
}

// ── Which map a file belongs to ──

const BINDING_PREFIX = "rainbird.pushedKm.";
/** { kmId, version } for a file saved from a saved version rather than the draft. */
const VERSION_PREFIX = "rainbird.pulledVersion.";

/** The kmID this file is bound to (opened, pulled, pushed or bound by ID), if any. */
export function fileKmId(context: vscode.ExtensionContext, uri: vscode.Uri): string | undefined {
  return context.workspaceState.get<string>(`${BINDING_PREFIX}${uri.toString()}`) || undefined;
}

export interface BindFileOptions {
  /**
   * What the file's text started from: a number for a copy of that saved
   * version, null for the draft or a push. Omit it when binding by hand: a
   * mark for the same map stays, and one for another map is ignored anyway.
   */
  version?: number | null;
}

/**
 * Bind a file to a map: from now on queries, diffs and the assistant use that
 * kmID for it (stored in lower case when it is a GUID). See BindFileOptions
 * and fileKmVersion for the saved-version mark.
 */
export function bindFileKmId(
  context: vscode.ExtensionContext,
  uri: vscode.Uri,
  kmId: string,
  opts: BindFileOptions = {}
): Thenable<void> {
  const id = normaliseKmId(kmId);
  const writes = [context.workspaceState.update(`${BINDING_PREFIX}${uri.toString()}`, id)];
  if (opts.version !== undefined) {
    writes.push(
      context.workspaceState.update(
        `${VERSION_PREFIX}${uri.toString()}`,
        opts.version === null ? undefined : { kmId: id, version: opts.version }
      )
    );
  }
  return Promise.all(writes).then(() => undefined);
}

/**
 * The saved version a file was pulled from, when it is a copy of a version
 * rather than the draft and still bound to that map. The map's snapshot
 * records its draft, so quick diff and the snapshot diff skip such files.
 */
export function fileKmVersion(context: vscode.ExtensionContext, uri: vscode.Uri): number | undefined {
  const pulled = context.workspaceState.get<{ kmId?: string; version?: number }>(`${VERSION_PREFIX}${uri.toString()}`);
  return typeof pulled?.version === "number" && sameKmId(pulled.kmId, fileKmId(context, uri)) ? pulled.version : undefined;
}

/** Platform drafts, versions and snapshots carry their kmID in the URI: the document is that map. */
function embeddedKmId(uri: vscode.Uri): string | undefined {
  if (uri.scheme === PLATFORM_SCHEME) return parsePlatformUri(uri)?.kmId;
  if (uri.scheme === SNAPSHOT_SCHEME) return /^\/([^/]+)\.rbl$/.exec(uri.path)?.[1];
  return undefined;
}

/** The RBLang document last active in a text editor (tracked from registerPlatformSource). */
let lastRblangUri: vscode.Uri | undefined;

function noteRblangEditor(editor: vscode.TextEditor | undefined): void {
  if (editor?.document.languageId === "rblang") lastRblangUri = editor.document.uri;
}

/** Whether a document is still open in a tab, on its own or as the edited side of a diff, and still RBLang. */
function isOpenRblangTab(uri: vscode.Uri): boolean {
  const key = uri.toString();
  const doc = vscode.workspace.textDocuments.find((d) => d.uri.toString() === key);
  if (doc && doc.languageId !== "rblang") return false;
  return vscode.window.tabGroups.all.some((group) =>
    group.tabs.some(
      (tab) =>
        (tab.input instanceof vscode.TabInputText && tab.input.uri.toString() === key) ||
        (tab.input instanceof vscode.TabInputTextDiff && tab.input.modified.toString() === key)
    )
  );
}

/**
 * The RBLang file the user is working on: the active editor; else the only
 * visible RBLang editor (focus may be in a webview such as the query panel);
 * else the RBLang editor that was active last, while its tab is open — it may
 * be hidden behind the tab a command was started from, such as the Welcome
 * page's walkthrough. Read its text with openTextDocument(uri), not from
 * visibleTextEditors. Undefined when there is none.
 */
export function activeRblangUri(): vscode.Uri | undefined {
  const active = vscode.window.activeTextEditor;
  if (active?.document.languageId === "rblang") return active.document.uri;
  const visible = vscode.window.visibleTextEditors.filter((e) => e.document.languageId === "rblang");
  if (new Set(visible.map((e) => e.document.uri.toString())).size === 1) return visible[0].document.uri;
  return lastRblangUri && isOpenRblangTab(lastRblangUri) ? lastRblangUri : undefined;
}

/**
 * Make kmId the default map (rainbird.knowledgeMapId) for the folder holding
 * `uri`: the WorkspaceFolder setting when the file is inside a folder, the
 * Workspace setting when folders are open, otherwise nothing — an empty window
 * has no settings file and VS Code rejects the write. Never throws; resolves
 * true when the setting holds kmId afterwards.
 */
export async function rememberKmId(uri: vscode.Uri | undefined, kmId: string): Promise<boolean> {
  const id = normaliseKmId(kmId);
  try {
    const folder = uri ? vscode.workspace.getWorkspaceFolder(uri) : undefined;
    let target: vscode.ConfigurationTarget;
    if (folder) target = vscode.ConfigurationTarget.WorkspaceFolder;
    else if (vscode.workspace.workspaceFolders?.length) target = vscode.ConfigurationTarget.Workspace;
    else return false;
    // A WorkspaceFolder write needs a configuration scoped to a resource in that folder.
    const config = vscode.workspace.getConfiguration("rainbird", folder?.uri ?? uri);
    const inspected = config.inspect<string>("knowledgeMapId");
    const current =
      target === vscode.ConfigurationTarget.WorkspaceFolder ? inspected?.workspaceFolderValue : inspected?.workspaceValue;
    if (current !== id) await config.update("knowledgeMapId", id, target);
    return true;
  } catch (error) {
    console.warn("Rainbird: could not save rainbird.knowledgeMapId:", error);
    return false;
  }
}

export interface PromptKmIdOptions {
  /** Title of the picker and input box, e.g. "Open Map by Knowledge Map ID". */
  title?: string;
  /** The kmID in effect now (binding or setting): marked in the list, and a clipboard ID equal to it is not offered. */
  current?: string;
  /** Offer the maps from the Maps view (default true). */
  includeKnown?: boolean;
}

type KmIdRow = vscode.QuickPickItem & { kmId?: string; enter?: boolean };

/**
 * Ask for a Knowledge Map ID. When the Maps view knows maps, or the clipboard
 * holds an ID, a Quick Pick offers them plus "Enter a Knowledge Map ID…";
 * otherwise the input box opens directly. Pasted Studio or API URLs and lines
 * copied from the Publish page are reduced to the ID (extractKmId); text that
 * is not a GUID only gets a warning, since IDs on private hosts are unverified.
 * Resolves the ID (lower case when it is a GUID) or undefined when cancelled.
 */
export async function promptKmId(
  context: vscode.ExtensionContext,
  opts: PromptKmIdOptions = {}
): Promise<string | undefined> {
  const title = opts.title ?? "Which map?";
  // Started now, awaited only where needed, so the prompt does not wait for the secret store.
  const keys = storedKeys(context);
  const known = opts.includeKnown === false ? [] : knownMaps(context);
  const clipboard = await clipboardKmId(opts.current, keys);
  if (!known.length && !clipboard) return inputKmId(title, opts.current, keys);

  const rows: KmIdRow[] = [];
  if (clipboard) {
    const name = known.find((m) => sameKmId(m.kmId, clipboard))?.name;
    rows.push({
      label: `$(clippy) Use ${clipboard.slice(0, 8)}… from clipboard`,
      description: name ? `${clipboard} · ${name}` : clipboard,
      kmId: clipboard,
    });
  }
  rows.push({ label: "$(edit) Enter a Knowledge Map ID…", description: "from the map's Publish page in Studio", alwaysShow: true, enter: true });
  if (known.length) {
    rows.push({ label: "Maps", kind: vscode.QuickPickItemKind.Separator });
    rows.push(...known.map((map) => knownMapRow(map, opts.current)));
  }

  const picker = vscode.window.createQuickPick<KmIdRow>();
  picker.title = title;
  picker.placeholder = "Paste a Knowledge Map ID or a Studio link, or pick a map you have used";
  picker.matchOnDescription = true;
  // The ID is usually copied from Studio in a browser; leaving VS Code must not close the picker.
  picker.ignoreFocusOut = true;
  picker.items = rows;

  // An ID or link pasted straight into the filter box becomes a "Use …" row,
  // so it never ends in "No matching results". Items are only replaced when
  // that ID changes, so ordinary filtering keeps its selection. Text whose
  // only GUIDs are session IDs or keys, or a stored key itself, gets no row:
  // "Enter a Knowledge Map ID…" carries it to the input box, which explains.
  let keyList: string[] = [];
  void keys.then((list) => (keyList = list));
  let typedId: string | undefined;
  picker.onDidChangeValue((value) => {
    const found = extractKmId(value, { allowOther: false });
    const typed = found && !keyList.some((key) => sameKmId(key, found)) ? found : undefined;
    if (typed === typedId) return;
    typedId = typed;
    if (!typed) {
      picker.items = rows;
      return;
    }
    const name = known.find((m) => sameKmId(m.kmId, typed))?.name;
    const row: KmIdRow = { label: `$(arrow-right) Use ${typed}`, description: name, alwaysShow: true, kmId: typed };
    picker.items = [row, ...rows];
    picker.activeItems = [row];
  });

  const choice = await new Promise<{ row?: KmIdRow; value: string }>((resolve) => {
    let settled = false;
    const finish = (row?: KmIdRow) => {
      if (settled) return;
      settled = true;
      resolve({ row, value: picker.value });
      picker.hide();
    };
    picker.onDidAccept(() => finish(picker.selectedItems[0] ?? picker.activeItems[0]));
    picker.onDidHide(() => {
      finish(undefined);
      picker.dispose();
    });
    picker.show();
  });

  if (choice.row?.kmId) return choice.row.kmId;
  if (choice.row?.enter) return inputKmId(title, choice.value.trim() || opts.current, keys);
  return undefined;
}

function knownMapRow(map: KnownMap, current: string | undefined): KmIdRow {
  const detail = [
    KNOWN_MAP_SOURCE_LABELS[map.source] ?? map.source,
    map.file ? map.file.split(/[\\/]/).pop() : undefined,
    sameKmId(map.kmId, current) ? "current" : undefined,
  ].filter(Boolean);
  return {
    label: map.name ?? map.kmId,
    description: map.name ? map.kmId : undefined,
    detail: detail.join(" · "),
    // Entries from older versions may hold an upper-case ID, or a pasted link.
    kmId: extractKmId(map.kmId) ?? normaliseKmId(map.kmId),
  };
}

/** The input box behind "Enter a Knowledge Map ID…". */
async function inputKmId(title: string, value: string | undefined, keys: Promise<string[]>): Promise<string | undefined> {
  const typed = await vscode.window.showInputBox({
    title,
    prompt: "Knowledge Map ID (kmID)",
    placeHolder:
      "e.g. 504436fb-7fbb-44ea-b36c-bfd977aea8c8 — from the map's Publish page in Studio (or View Knowledge Map ID in the map menu)",
    value,
    ignoreFocusOut: true,
    // Warnings and infos only: Enter always accepts what was typed.
    validateInput: async (text) => {
      const trimmed = text.trim();
      if (!trimmed) return undefined;
      const id = extractKmId(trimmed);
      if (!id) {
        return {
          message: "This does not look like a Knowledge Map ID (36 characters with dashes).",
          severity: vscode.InputBoxValidationSeverity.Warning,
        };
      }
      // The Publish page shows the API key next to the kmID, and both are GUIDs.
      if ((await keys).some((key) => sameKmId(key, id))) {
        return {
          message: "That is the API key (or evidence key) stored for this environment, not a Knowledge Map ID. Copy the Knowledge Map ID from the map's Publish page in Studio.",
          severity: vscode.InputBoxValidationSeverity.Warning,
        };
      }
      if (!extractKmId(trimmed, { allowOther: false })) {
        return {
          message: `${id} is marked as a session ID or a key in the pasted text, not a Knowledge Map ID. The Knowledge Map ID is on the map's Publish page in Studio.`,
          severity: vscode.InputBoxValidationSeverity.Warning,
        };
      }
      if (id !== trimmed.toLowerCase()) {
        return { message: `Will use ${id}, found in the pasted text.`, severity: vscode.InputBoxValidationSeverity.Info };
      }
      return undefined;
    },
  });
  const trimmed = typed?.trim();
  if (!trimmed) return undefined;
  return extractKmId(trimmed) ?? trimmed;
}

/** This environment's stored API and evidence keys: GUIDs too, and never a kmID. Same secret names as queryRunner.ts. */
async function storedKeys(context: vscode.ExtensionContext): Promise<string[]> {
  try {
    const env = apiUrl();
    const keys = await Promise.all([
      context.secrets.get(`rainbird.apiKey.${env}`),
      context.secrets.get(`rainbird.evidenceKey.${env}`),
    ]);
    return keys.filter((key): key is string => !!key);
  } catch {
    return [];
  }
}

/**
 * A Knowledge Map ID on the clipboard that is worth offering: short text (not
 * a pasted document) holding a GUID that is not marked as a session ID or a
 * key (a copied evidence link carries the session ID), different from the map
 * in effect, and not this environment's API or evidence key — the API key is
 * often still on the clipboard right after Connect. Read only while a prompt
 * is open; nothing is sent anywhere.
 */
async function clipboardKmId(current: string | undefined, keys: Promise<string[]>): Promise<string | undefined> {
  try {
    const text = (await vscode.env.clipboard.readText()).trim();
    if (!text || text.length > 500) return undefined;
    const id = extractKmId(text, { allowOther: false });
    if (!id || sameKmId(id, current)) return undefined;
    return (await keys).some((key) => sameKmId(key, id)) ? undefined : id;
  } catch {
    return undefined;
  }
}

export interface ResolveKmIdOptions {
  /** The document the map is wanted for; its binding and folder setting are consulted. */
  uri?: vscode.Uri;
  /** An explicit kmID (e.g. from the Maps view) that wins over everything; never saved. */
  override?: string;
  /** Ask when nothing else gives a kmID (default true). */
  prompt?: boolean;
  /** Title of the prompt (default "Which map?"). */
  title?: string;
}

/**
 * The one kmID precedence: override → the document's own map (a platform or
 * snapshot document is that map; otherwise its file binding) → the
 * rainbird.knowledgeMapId setting for the document's folder → a prompt, whose
 * answer is remembered as the folder or workspace default (rememberKmId).
 * A GUID always comes back in lower case (normaliseKmId), so anything keyed
 * by the result sees one spelling per map.
 */
export async function resolveKmIdFor(
  context: vscode.ExtensionContext,
  opts: ResolveKmIdOptions = {}
): Promise<string | undefined> {
  const override = opts.override?.trim();
  if (override) return normaliseKmId(override);
  if (opts.uri) {
    const own = embeddedKmId(opts.uri) ?? fileKmId(context, opts.uri);
    if (own) return normaliseKmId(own);
  }
  const configured = vscode.workspace.getConfiguration("rainbird", opts.uri).get<string>("knowledgeMapId")?.trim();
  if (configured) return extractKmId(configured) ?? configured;
  if (opts.prompt === false) return undefined;
  const typed = await promptKmId(context, { title: opts.title ?? "Which map?" });
  if (typed) await rememberKmId(opts.uri, typed);
  return typed;
}

/** The kmID for the active editor's file: resolveKmIdFor with the active document, prompting when needed. */
export function resolveKmId(context: vscode.ExtensionContext): Promise<string | undefined> {
  return resolveKmIdFor(context, { uri: vscode.window.activeTextEditor?.document.uri });
}

/** Command "Rainbird: Bind Open File to a Knowledge Map ID…": say which platform map a file is a copy of. */
export async function bindKmId(context: vscode.ExtensionContext, uri?: vscode.Uri): Promise<void> {
  const target = uri ?? activeRblangUri();
  if (!target) {
    vscode.window.showInformationMessage("Open (or click into) the RBLang (.rbl) file you want to bind to a Knowledge Map ID first.");
    return;
  }
  const embedded = embeddedKmId(target);
  if (embedded) {
    vscode.window.showInformationMessage(
      `This read-only document is map ${embedded} itself. Run “Rainbird: Open Map by Knowledge Map ID…” to get an editable file bound to it.`
    );
    return;
  }
  if (target.scheme === "untitled") {
    // The binding is keyed by the document URI, which changes when the file is first saved.
    vscode.window.showInformationMessage("Save the file with a .rbl name first (File > Save As…), then bind it.");
    return;
  }
  const name = fileName(target);
  const kmId = await promptKmId(context, { title: `Bind ${name} to a Knowledge Map ID`, current: fileKmId(context, target) });
  if (!kmId) return;
  await bindFileKmId(context, target, kmId);
  void recordKnownMap(context, {
    kmId,
    source: "manual",
    fallbackName: name.replace(/\.(rbl|rblang)$/i, ""),
    ...(target.scheme === "file" ? { file: target.fsPath } : {}),
  });
  vscode.window.setStatusBarMessage(`Bound ${name} to ${kmId}: Run Query, the diffs and the assistant now use this map for it.`, 6000);
}

// ── Reading maps from the platform ──

/** Text fetched moments ago per platform URI, so opening its document right after does not download it twice. */
const recentText = new Map<string, { text: string; at: number }>();
const RECENT_MS = 15_000;

/** Fires for platform documents that must re-read their text (a tab still open from an earlier pull). */
const platformChanges = new vscode.EventEmitter<vscode.Uri>();

/**
 * GET a map's RBLang (draft or version). Throws ApiError with the status on
 * HTTP failures (401 rejected key, 403 no access, 404 unknown map or version).
 * The text is kept for a few seconds for the matching platform document, and
 * an already open tab of it is refreshed.
 */
export async function fetchPlatformText(client: RainbirdClient, kmId: string, ref: SourceRef): Promise<string> {
  const file = await client.getFile(kmId, ref.kind === "version" ? ref.version : undefined);
  rememberPlatformText(platformUri(kmId, ref), file.rblang);
  return file.rblang;
}

/** Offer downloaded text to the platform document at `uri`: the next open reads it, and an open tab refreshes. */
function rememberPlatformText(uri: vscode.Uri, text: string): void {
  const now = Date.now();
  for (const [key, entry] of recentText) if (now - entry.at >= RECENT_MS) recentText.delete(key);
  recentText.set(uri.toString(), { text, at: now });
  if (vscode.workspace.textDocuments.some((d) => d.uri.toString() === uri.toString())) platformChanges.fire(uri);
}

/** Open and show a read-only platform document (rainbird-platform:/{kmID}/…). */
export async function showPlatformDocument(uri: vscode.Uri, options?: vscode.TextDocumentShowOptions): Promise<vscode.TextEditor> {
  return vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri), options);
}

/**
 * Explain a failed map download by its status. 401 offers Connect and then
 * runs `retry`; a 404 for a saved version that does not exist names the version.
 */
async function reportMapError(
  error: unknown,
  kmId: string,
  ref: SourceRef,
  fallback: string,
  retry?: () => Promise<void>
): Promise<void> {
  const env = apiUrl();
  if (error instanceof ApiError) {
    if (error.status === 404 && ref.kind === "version" && /version/i.test(error.body)) {
      vscode.window.showErrorMessage(`Map ${kmId} has no version ${ref.version}. Its saved versions are listed on the map's Versions page in Studio.`);
      return;
    }
    if (error.status === 404) {
      vscode.window.showErrorMessage(unknownMapMessage(kmId, env));
      return;
    }
    if (error.status === 401) {
      const action = await vscode.window.showErrorMessage(
        `The API key for ${env} was rejected. Run “Rainbird: Connect” to enter a new one.`,
        "Connect"
      );
      if (action === "Connect" && (await vscode.commands.executeCommand("rainbird.connect")) && retry) await retry();
      return;
    }
    if (error.status === 403) {
      vscode.window.showErrorMessage(`This key cannot access ${kmId} (different account or missing permission).`);
      return;
    }
  }
  vscode.window.showErrorMessage(`${fallback}: ${(error as Error).message}`);
}

/** Where Save As starts: the active file's workspace folder, the first folder, the active file's directory, else home. */
function defaultSaveFolder(): vscode.Uri {
  const active = vscode.window.activeTextEditor?.document.uri;
  const folder = (active && vscode.workspace.getWorkspaceFolder(active)) ?? vscode.workspace.workspaceFolders?.[0];
  if (folder) return folder.uri;
  if (active?.scheme === "file") return vscode.Uri.joinPath(active, "..");
  return vscode.Uri.file(os.homedir());
}

export interface SaveRblangOptions {
  kmId: string;
  /** The RBLang exactly as the platform returned it. */
  rblang: string;
  /** What was pulled: names the default file, and only a draft becomes the map's snapshot. */
  ref: "draft" | number;
}

/**
 * Save platform RBLang as an editable .rbl (Save As dialog, default
 * map-<kmid8>-draft.rbl or -v<N>.rbl in the workspace folder), bind the new
 * file to the map and record it in Maps as "pulled". A draft is also written
 * as the map's snapshot, so gutter bars and "Diff Against Last Pulled or
 * Pushed Snapshot" show what changed since the pull. A version is not, because
 * snapshots are keyed by kmID and a version would pose as the draft; its file
 * is bound with the version (fileKmVersion), so it gets no change bars rather
 * than bars against the draft. Does not open the file. Resolves the saved
 * URI, or undefined when cancelled.
 */
export async function saveRblangAs(context: vscode.ExtensionContext, opts: SaveRblangOptions): Promise<vscode.Uri | undefined> {
  const target = await vscode.window.showSaveDialog({
    title:
      opts.ref === "draft"
        ? `Save the draft of ${opts.kmId} as an editable .rbl`
        : `Save version ${opts.ref} of ${opts.kmId} as an editable .rbl`,
    saveLabel: "Save map",
    filters: { RBLang: ["rbl"] },
    defaultUri: vscode.Uri.joinPath(defaultSaveFolder(), defaultFileName(opts.kmId, opts.ref)),
  });
  if (!target) return undefined;
  await vscode.workspace.fs.writeFile(target, Buffer.from(opts.rblang, "utf8"));
  await bindFileKmId(context, target, opts.kmId, { version: opts.ref === "draft" ? null : opts.ref });
  // Awaited so the snapshot (the quick-diff base) is on disk before the file opens.
  await recordKnownMap(context, {
    kmId: opts.kmId,
    source: "pulled",
    fallbackName: fileName(target).replace(/\.(rbl|rblang)$/i, ""),
    ...(target.scheme === "file" ? { file: target.fsPath } : {}),
    ...(opts.ref === "draft" ? { rblang: opts.rblang } : {}),
  });
  return target;
}

/**
 * Command "Rainbird: Open Map by Knowledge Map ID…": connect if needed, ask
 * for the ID (or take `kmId`), download the draft, save it where the user
 * chooses, and open it bound to the map and listed in Maps.
 */
export async function openMapByKmId(context: vscode.ExtensionContext, kmId?: string): Promise<void> {
  const client = await getClient(context);
  if (!client) return;
  const given = kmId?.trim();
  const id = given ? extractKmId(given) ?? given : await promptKmId(context, { title: "Open Map by Knowledge Map ID" });
  if (!id) return;

  let rblang: string;
  try {
    rblang = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Rainbird: downloading the draft of ${id}…` },
      () => fetchPlatformText(client, id, { kind: "draft" })
    );
  } catch (error) {
    await reportMapError(error, id, { kind: "draft" }, "Could not open the map", () => openMapByKmId(context, id));
    return;
  }

  let target: vscode.Uri | undefined;
  try {
    target = await saveRblangAs(context, { kmId: id, rblang, ref: "draft" });
  } catch (error) {
    vscode.window.showErrorMessage(`Could not save the map: ${(error as Error).message}`);
    return;
  }
  if (!target) {
    // Escape in the Save dialog still shows the map, so the command is not a dead end.
    // The download is offered again: the dialog may have outlasted the cache.
    const draft = platformUri(id, { kind: "draft" });
    rememberPlatformText(draft, rblang);
    try {
      await showPlatformDocument(draft, { preview: false });
    } catch (error) {
      await reportMapError(error, id, { kind: "draft" }, "Could not open the map");
      return;
    }
    vscode.window.showInformationMessage(
      `Opened the platform draft of ${id} read-only. Run “Rainbird: Open Map by Knowledge Map ID…” again and choose a location to get an editable copy.`
    );
    return;
  }

  await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(target), { preview: false });
  void vscode.window
    .showInformationMessage(
      `Opened ${fileName(target)} (draft of ${id}). The play button queries this map; Push creates a new map rather than updating it.`,
      "Run query",
      "Copy kmID"
    )
    .then(async (action) => {
      if (action === "Run query") {
        await vscode.commands.executeCommand("rainbird.openQueryPanelWithKm", id);
      } else if (action === "Copy kmID") {
        await vscode.env.clipboard.writeText(id);
        vscode.window.setStatusBarMessage(`Copied ${id}`, 3000);
      }
    });
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
  noteRblangEditor(vscode.window.activeTextEditor);
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(noteRblangEditor),
    platformChanges,
    vscode.workspace.registerTextDocumentContentProvider(PLATFORM_SCHEME, {
      onDidChange: platformChanges.event,
      async provideTextDocumentContent(uri) {
        const parsed = parsePlatformUri(uri);
        if (!parsed) throw new Error(`Not a Rainbird platform URI: ${uri.toString()}`);
        const recent = recentText.get(uri.toString());
        recentText.delete(uri.toString());
        if (recent && Date.now() - recent.at < RECENT_MS) return recent.text;
        const client = await getClientSilent(context);
        if (!client) throw new Error("Not connected — run “Rainbird: Connect” first.");
        const file = await client.getFile(parsed.kmId, parsed.ref.kind === "version" ? parsed.ref.version : undefined);
        return file.rblang;
      },
    }),
    vscode.commands.registerCommand("rainbird.pullMap", () => pullMap(context)),
    vscode.commands.registerCommand("rainbird.reloadFromPlatform", (uri?: unknown) =>
      reloadFromPlatform(context, uri instanceof vscode.Uri ? uri : undefined)
    ),
    vscode.commands.registerCommand("rainbird.diffAgainstDraft", () => diffAgainstDraft(context))
  );
}

/**
 * Command "Rainbird: Reload Map from Studio": replace a bound file's text with
 * what its map's platform draft holds now (Studio edits the draft). A file with
 * no local changes since its last pull or push is replaced at once; otherwise
 * the user is warned first and can look at the differences. The replacement is
 * one undoable edit, the file is saved, and the draft becomes the map's new
 * snapshot, so gutter bars start again from it. Platform tabs simply refresh.
 */
async function reloadFromPlatform(context: vscode.ExtensionContext, uri?: vscode.Uri): Promise<void> {
  const target = uri ?? activeRblangUri();
  if (!target) {
    vscode.window.showInformationMessage("Open the .rbl file you want to reload from Studio first.");
    return;
  }
  const client = await getClient(context);
  if (!client) return;

  // A read-only platform tab: fetch again and let the tab refresh.
  const platform = parsePlatformUri(target);
  if (target.scheme === PLATFORM_SCHEME && platform) {
    try {
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Rainbird: reloading ${platform.kmId}…` },
        () => fetchPlatformText(client, platform.kmId, platform.ref)
      );
    } catch (error) {
      await reportMapError(error, platform.kmId, platform.ref, "Could not reload the map");
    }
    return;
  }
  if (target.scheme === SNAPSHOT_SCHEME) {
    vscode.window.showInformationMessage("This tab is the snapshot of what was last pulled or pushed. Reload the .rbl file bound to the map instead.");
    return;
  }

  const doc = await vscode.workspace.openTextDocument(target);
  const name = fileName(doc.uri);
  const kmId = fileKmId(context, doc.uri);
  if (!kmId) {
    const action = await vscode.window.showInformationMessage(
      `${name} is not bound to a Knowledge Map ID, so there is no Studio map to reload it from.`,
      "Bind to a Knowledge Map ID…"
    );
    if (action) await vscode.commands.executeCommand("rainbird.bindKmId", doc.uri);
    return;
  }
  const version = fileKmVersion(context, doc.uri);
  if (version !== undefined) {
    vscode.window.showInformationMessage(
      `${name} is a copy of saved version ${version} of ${kmId}, and saved versions never change. To get the latest Studio edits, open the draft with “Rainbird: Open Map by Knowledge Map ID…”.`
    );
    return;
  }

  let rblang: string;
  try {
    rblang = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Rainbird: downloading the draft of ${kmId}…` },
      () => fetchPlatformText(client, kmId, { kind: "draft" })
    );
  } catch (error) {
    await reportMapError(error, kmId, { kind: "draft" }, "Could not reload the map", () => reloadFromPlatform(context, doc.uri));
    return;
  }

  const record = () =>
    recordKnownMap(context, { kmId, source: "pulled", rblang, ...(doc.uri.scheme === "file" ? { file: doc.uri.fsPath } : {}) });
  const local = doc.getText();
  if (local === rblang) {
    await record();
    vscode.window.showInformationMessage(`${name} already matches the Studio draft of ${kmId}.`);
    return;
  }

  // Local work is anything that differs from the last pulled or pushed snapshot, or unsaved edits.
  let snapshot: string | undefined;
  try {
    snapshot = Buffer.from(await vscode.workspace.fs.readFile(snapshotUri(context, kmId))).toString("utf8");
  } catch {
    snapshot = undefined;
  }
  if (doc.isDirty || snapshot === undefined || snapshot !== local) {
    const since = snapshot === undefined ? "" : " since it was last pulled or pushed";
    const choice = await vscode.window.showWarningMessage(
      `${name} has changes${since} that are not in the Studio draft of ${kmId}. Reloading replaces the whole file with the draft. You can undo it in the editor.`,
      { modal: true },
      "Reload and replace",
      "Show differences"
    );
    if (choice === "Show differences") {
      await vscode.window.showTextDocument(doc, { preview: false });
      await vscode.commands.executeCommand("rainbird.diffAgainstDraft");
      return;
    }
    if (choice !== "Reload and replace") return;
  }

  const edit = new vscode.WorkspaceEdit();
  edit.replace(doc.uri, new vscode.Range(doc.positionAt(0), doc.positionAt(local.length)), rblang);
  if (!(await vscode.workspace.applyEdit(edit))) {
    vscode.window.showErrorMessage(`Could not update ${name}.`);
    return;
  }
  await doc.save();
  await record();
  vscode.window.showInformationMessage(`Reloaded ${name} from the Studio draft of ${kmId}.`);
}

/** Open a map's RBLang from the platform (draft or a version) as a read-only document, with Save As. */
async function pullMap(context: vscode.ExtensionContext): Promise<void> {
  const client = await getClient(context);
  if (!client) return;
  let kmId: string | undefined;
  let ref: SourceRef = { kind: "draft" };
  try {
    // Inside the try: resolving can prompt, and picking "live" starts a session; failures get the messages below.
    kmId = await resolveKmId(context);
    if (!kmId) return;
    const id = kmId;
    const pick = await pickPlatformRef(client, id, `Pull which state of map ${id}?`, "draft");
    if (!pick) return;
    const pulled = pick.ref;
    ref = pulled;
    const rblang = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Rainbird: downloading the ${pick.label} of ${id}…` },
      () => fetchPlatformText(client, id, pulled)
    );
    await showPlatformDocument(platformUri(id, pulled), { preview: false });
    const action = await vscode.window.showInformationMessage(
      `Read-only RBLang of the platform ${pick.label} for ${id}. Save a local copy to edit it.`,
      "Save as .rbl…"
    );
    if (action) {
      // Save what was downloaded rather than the document text, which a refreshing tab may not have yet.
      const target = await saveRblangAs(context, { kmId: id, rblang, ref: pulled.kind === "draft" ? "draft" : pulled.version });
      if (target) {
        await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(target), { preview: false });
        vscode.window.setStatusBarMessage(
          pulled.kind === "draft"
            ? `Saved ${fileName(target)}, bound to ${id}.`
            : `Saved ${fileName(target)}, bound to ${id}. No change bars for this copy of version ${pulled.version}: the map's snapshot records its draft.`,
          8000
        );
      }
    }
  } catch (error) {
    if (kmId) await reportMapError(error, kmId, ref, "Could not pull the map");
    else vscode.window.showErrorMessage(`Could not pull the map: ${(error as Error).message}`);
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
    const rblang = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: "Rainbird: fetching the platform draft…" },
      () => fetchPlatformText(client, kmId, { kind: "draft" })
    );
    const local = editor.document.getText();
    const name = editor.document.uri.path.split("/").pop() ?? "local";
    if (rblang.trim() === local.trim()) {
      vscode.window.showInformationMessage(`${name} matches the platform draft of ${kmId} exactly.`);
      return;
    }
    const baseLabel = `platform draft (${kmId})`;
    const report = diffReportDetailed(buildModel(rblang), buildModel(local), baseLabel, name);
    report.markdown = report.markdown.replace(
      /^# Semantic diff — .*$/m,
      `# Local file vs platform draft — ${name} vs ${kmId}\n\n_Changes are read from the platform draft to your local file: ＋ means your file has it and the draft does not._`
    );
    await showSideBySideDiff(
      { label: baseLabel, text: rblang, uri: platformUri(kmId, { kind: "draft" }) },
      { label: name, text: local, uri: editor.document.uri },
      report
    );
  } catch (error) {
    await reportMapError(error, kmId, { kind: "draft" }, "Could not fetch the platform draft");
  }
}
