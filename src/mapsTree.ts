/**
 * Platform Maps view.
 *
 * The public API has no list-maps endpoint today (GET /maps → 404 "Cannot
 * GET", verified; asked of the platform team). So this view is an honest
 * local registry: every kmID the extension opens, pulls, pushes, queries or
 * is told about is remembered per environment, most recent first. On refresh
 * it still probes GET /maps, so the view upgrades itself to a live listing
 * the day the endpoint ships (or on enterprise hosts where it may already
 * exist). With nothing to show it returns no rows, so VS Code renders the
 * view's welcome text (package.json viewsWelcome), which explains the gap.
 */
import * as vscode from "vscode";
import { getClientSilent } from "./queryRunner";
import { fetchPlatformText, platformUri, promptKmId, showPlatformDocument } from "./platform";
import { normaliseKmId, sameKmId } from "./kmId";

export interface KnownMap {
  kmId: string;
  name?: string;
  source: "pushed" | "pulled" | "queried" | "manual" | "platform";
  /** Workspace file bound to the map (pushed from, pulled into or bound by hand), when known. */
  file?: string;
  addedAt: string;
}

/** How each source reads in tooltips and pickers. */
export const KNOWN_MAP_SOURCE_LABELS: Record<KnownMap["source"], string> = {
  pushed: "pushed from VS Code",
  pulled: "pulled into a file",
  queried: "queried",
  manual: "added by Knowledge Map ID",
  platform: "listed by the platform",
};

function registryKey(): string {
  const apiUrl = vscode.workspace.getConfiguration("rainbird").get<string>("apiUrl") ?? "https://api.rainbird.ai";
  return `rainbird.knownMaps.${apiUrl}`;
}

const changeEmitter = new vscode.EventEmitter<void>();

/** Read-only view of map snapshots (editing one would silently diverge from the platform). */
export const SNAPSHOT_SCHEME = "rainbird-snapshot";

/** Fires when a snapshot is rewritten, so open snapshot documents (quick-diff bases) re-read it. */
const snapshotChanges = new vscode.EventEmitter<vscode.Uri>();

/** The read-only document for a map's snapshot; its path carries the kmID (lower case for a GUID). */
export function snapshotDocumentUri(kmId: string): vscode.Uri {
  return vscode.Uri.from({ scheme: SNAPSHOT_SCHEME, path: `/${normaliseKmId(kmId)}.rbl` });
}

function environmentDir(): string {
  const apiUrl = vscode.workspace.getConfiguration("rainbird").get<string>("apiUrl") ?? "https://api.rainbird.ai";
  return encodeURIComponent(apiUrl);
}

/**
 * Where the exact RBLang last pushed, or last pulled as a draft into a file, is
 * snapshotted, per environment + kmID. Keyed by kmID alone, which is why
 * saved versions are never snapshotted. One file name per map whatever the
 * caller's spelling of the ID (case-sensitive file systems would split it).
 */
export function snapshotUri(context: vscode.ExtensionContext, kmId: string): vscode.Uri {
  return vscode.Uri.joinPath(context.globalStorageUri, "map-snapshots", environmentDir(), `${normaliseKmId(kmId)}.rbl`);
}

/** The maps known on the current environment, most recently used first (the Maps view's registry). */
export function knownMaps(context: vscode.ExtensionContext): KnownMap[] {
  return context.globalState.get<KnownMap[]>(registryKey(), []);
}

/**
 * Remember a map in the registry (moving it to the top) and, when `rblang` is
 * given, snapshot it as what the platform holds. `fallbackName` (a file name)
 * only fills a missing name, so a name given at push or Add Map time survives
 * a later pull or bind. kmIDs match case-insensitively: an existing entry
 * keeps its spelling, a new one is stored in lower case. Resolves once the
 * snapshot is on disk (never rejects), so a caller can open the bound file
 * with its quick-diff base in place.
 */
export function recordKnownMap(
  context: vscode.ExtensionContext,
  entry: Omit<KnownMap, "addedAt"> & { rblang?: string; fallbackName?: string }
): Promise<void> {
  const { rblang, fallbackName, ...rest } = entry;
  rest.kmId = normaliseKmId(rest.kmId);
  const key = registryKey();
  const maps = context.globalState.get<KnownMap[]>(key, []);
  const index = maps.findIndex((m) => sameKmId(m.kmId, rest.kmId));
  if (index >= 0) {
    const [existing] = maps.splice(index, 1);
    existing.name = rest.name ?? existing.name ?? fallbackName;
    existing.file = rest.file ?? existing.file;
    // Pushed wins (the map was created from this machine); pulled beats queried/manual.
    if (rest.source === "pushed") existing.source = "pushed";
    else if (rest.source === "pulled" && existing.source !== "pushed") existing.source = "pulled";
    maps.unshift(existing);
  } else {
    const name = rest.name ?? fallbackName;
    maps.unshift({ ...rest, ...(name ? { name } : {}), addedAt: new Date().toISOString() });
  }
  void context.globalState.update(key, maps.slice(0, 100));
  changeEmitter.fire();

  // Snapshot exactly what was pushed or pulled: it is the offline record of
  // what the platform holds and the base for quick-diff gutter bars.
  if (!rblang) return Promise.resolve();
  const dir = vscode.Uri.joinPath(context.globalStorageUri, "map-snapshots", environmentDir());
  return Promise.resolve(vscode.workspace.fs.createDirectory(dir))
    .then(() => vscode.workspace.fs.writeFile(snapshotUri(context, rest.kmId), Buffer.from(rblang, "utf8")))
    .then(
      () => snapshotChanges.fire(snapshotDocumentUri(rest.kmId)),
      (error) => console.warn("Rainbird: could not write map snapshot:", error)
    );
}

type Node =
  | { kind: "info"; label: string; detail?: string }
  | { kind: "map"; map: KnownMap };

export class PlatformMapsProvider implements vscode.TreeDataProvider<Node> {
  public static readonly viewId = "rainbird.platformMaps";

  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.emitter.event;
  private liveMaps?: { id: string; name?: string }[];
  private probed = false;

  constructor(private readonly context: vscode.ExtensionContext) {
    context.subscriptions.push(
      changeEmitter.event(() => this.emitter.fire()),
      // Snapshots open read-only through this scheme; the path carries the kmID.
      vscode.workspace.registerTextDocumentContentProvider(SNAPSHOT_SCHEME, {
        onDidChange: snapshotChanges.event,
        provideTextDocumentContent: async (uri) => {
          const kmId = uri.path.replace(/^\//, "").replace(/\.rbl$/, "");
          const raw = await vscode.workspace.fs.readFile(snapshotUri(context, kmId));
          return Buffer.from(raw).toString("utf8");
        },
      })
    );
  }

  refresh(): void {
    this.probed = false;
    this.emitter.fire();
  }

  getTreeItem(node: Node): vscode.TreeItem {
    if (node.kind === "info") {
      const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.None);
      item.iconPath = new vscode.ThemeIcon("info");
      item.tooltip = node.detail;
      return item;
    }
    const map = node.map;
    const item = new vscode.TreeItem(map.name ?? map.kmId, vscode.TreeItemCollapsibleState.None);
    item.description = map.name ? map.kmId : map.source;
    item.tooltip = `${map.kmId}\n${KNOWN_MAP_SOURCE_LABELS[map.source] ?? map.source}${map.file ? `\nfile: ${map.file}` : ""}`;
    item.contextValue = map.file ? "rainbirdMapWithFile" : "rainbirdMap";
    item.iconPath = new vscode.ThemeIcon(
      map.source === "pushed"
        ? "cloud-upload"
        : map.source === "pulled"
          ? "cloud-download"
          : map.source === "platform"
            ? "cloud"
            : "circuit-board"
    );
    item.command = {
      command: "rainbird.mapsOpen",
      title: "Open RBLang",
      arguments: [node],
    };
    return item;
  }

  async getChildren(node?: Node): Promise<Node[]> {
    if (node) return [];

    if (!this.probed) {
      this.probed = true;
      this.liveMaps = undefined;
      const client = await getClientSilent(this.context);
      if (client) {
        try {
          const probe = await client.listMaps();
          if (probe.available) this.liveMaps = probe.maps;
        } catch {
          // Listing is best-effort; fall through to the local registry.
        }
      }
    }

    const known = knownMaps(this.context);
    // Nothing to list: no rows, so VS Code shows the welcome text instead.
    if (!this.liveMaps && !known.length) return [];

    const nodes: Node[] = [];
    if (this.liveMaps) {
      nodes.push({ kind: "info", label: `Live listing (${this.liveMaps.length} maps on platform)` });
      nodes.push(...this.liveMaps.map((m) => ({ kind: "map" as const, map: { kmId: m.id, name: m.name, source: "platform" as const, addedAt: "" } })));
    } else {
      nodes.push({
        kind: "info",
        label: "Maps you have opened, pushed or queried from VS Code",
        detail:
          "Rainbird's API has no endpoint that lists an account's maps, so this view cannot browse Studio. Start from a Knowledge Map ID " +
          "(on the map's Publish page in Studio): Open Map by Knowledge Map ID… (cloud icon above) or Add Map by kmID (+). " +
          "If the platform adds a list endpoint, this view will use it.",
      });
    }
    nodes.push(...known.map((map) => ({ kind: "map" as const, map })));
    return nodes;
  }

  async addManual(): Promise<void> {
    // The maps already listed are not offered: this command is for a new one.
    const kmId = await promptKmId(this.context, { title: "Add Map by kmID", includeKnown: false });
    if (!kmId) return;
    // Escape here only skips the optional name, as before.
    const name = await vscode.window.showInputBox({ title: "Add Map by kmID", prompt: "Display name (optional)", ignoreFocusOut: true });
    void recordKnownMap(this.context, { kmId, name: name?.trim() || undefined, source: "manual" });
    vscode.window.setStatusBarMessage(`Added ${kmId} to Maps — click it to read the platform draft, or use the play icon to query it.`, 6000);
  }

  remove(node?: Node): void {
    if (!node || node.kind !== "map") return;
    const key = registryKey();
    const maps = this.context.globalState.get<KnownMap[]>(key, []).filter((m) => !sameKmId(m.kmId, node.map.kmId));
    void this.context.globalState.update(key, maps);
    void vscode.workspace.fs.delete(snapshotUri(this.context, node.map.kmId)).then(undefined, () => {
      /* no snapshot to clean up */
    });
    this.emitter.fire();
  }

  async copyKmId(node?: Node): Promise<void> {
    if (!node || node.kind !== "map") return;
    await vscode.env.clipboard.writeText(node.map.kmId);
    vscode.window.setStatusBarMessage(`Copied ${node.map.kmId}`, 3000);
  }

  async openFile(node?: Node): Promise<void> {
    if (!node || node.kind !== "map" || !node.map.file) return;
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(node.map.file));
    await vscode.window.showTextDocument(doc);
  }

  /**
   * Click action: open the map's RBLang. Best available source wins: the
   * platform draft (GET /analysis/file) → the workspace file bound to it →
   * the snapshot of the last pull or push → an honest explanation.
   */
  async openRblang(node?: Node): Promise<void> {
    if (!node || node.kind !== "map") return;
    const map = node.map;

    // Best source first: the platform draft itself (GET /analysis/file), read-only.
    const client = await getClientSilent(this.context);
    if (client) {
      try {
        // Fetched here so an unreadable map falls through; the document reuses this download.
        await fetchPlatformText(client, map.kmId, { kind: "draft" });
        await showPlatformDocument(platformUri(map.kmId, { kind: "draft" }));
        vscode.window.setStatusBarMessage(
          `Read-only RBLang of the platform draft for "${map.name ?? map.kmId}" — “Rainbird: Open Map by Knowledge Map ID…” saves an editable copy bound to it.`,
          8000
        );
        return;
      } catch {
        // Not readable with this key (or offline) — fall back to the local file / snapshot.
      }
    }

    if (map.file) {
      try {
        const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(map.file));
        await vscode.window.showTextDocument(doc);
        return;
      } catch {
        // File moved/deleted — fall through to the snapshot.
      }
    }

    try {
      await vscode.workspace.fs.stat(snapshotUri(this.context, map.kmId));
      // Open through the read-only scheme — an editable snapshot would let the
      // one record of what's on the platform silently diverge from it.
      const doc = await vscode.workspace.openTextDocument(snapshotDocumentUri(map.kmId));
      await vscode.window.showTextDocument(doc);
      vscode.window.setStatusBarMessage(
        `Read-only snapshot of "${map.name ?? map.kmId}" as last pulled or pushed from VS Code. To change the map, edit a copy and push it (push creates a new map).`,
        8000
      );
      return;
    } catch {
      // No snapshot either.
    }

    const action = await vscode.window.showInformationMessage(
      `No RBLang source is available for "${map.name ?? map.kmId}": the platform did not return it for this key (connect first, or check the kmID), ` +
        `and there is no local file or snapshot. Export a .rbird from Studio and extract it, or query the map live.`,
      "Extract .rbird…",
      "Run query"
    );
    if (action === "Extract .rbird…") await vscode.commands.executeCommand("rainbird.extractRbird");
    if (action === "Run query") await vscode.commands.executeCommand("rainbird.openQueryPanelWithKm", map.kmId);
  }

  /**
   * Inline "Reload from Studio": bring the map's local file up to date with the
   * draft in Studio (Rainbird: Reload Map from Studio). A map with no local file,
   * or whose file was moved or deleted, offers to download the draft instead.
   */
  async reload(node?: Node): Promise<void> {
    if (!node || node.kind !== "map") return;
    const map = node.map;
    const file = map.file ? vscode.Uri.file(map.file) : undefined;
    if (file) {
      try {
        await vscode.workspace.fs.stat(file);
        await vscode.commands.executeCommand("rainbird.reloadFromPlatform", file);
        return;
      } catch {
        // Moved or deleted: offer a fresh download below.
      }
    }
    const action = await vscode.window.showInformationMessage(
      `"${map.name ?? map.kmId}" has no local file${file ? " any more (it was moved or deleted)" : ""}. Download its draft from Studio into a new file?`,
      "Download…"
    );
    if (action) await vscode.commands.executeCommand("rainbird.openMapByKmId", map.kmId);
  }

  async query(node?: Node): Promise<void> {
    if (!node || node.kind !== "map") return;
    await vscode.commands.executeCommand("rainbird.openQueryPanelWithKm", node.map.kmId);
  }
}
