/**
 * Platform Maps view.
 *
 * The public API has no list-maps endpoint today (GET /maps → 404 "Cannot
 * GET", verified) — that's platform ask #8 in the proposal. So this view is
 * an honest local registry: every kmID the extension pushes, queries or is
 * told about is remembered per environment. On refresh it still probes
 * GET /maps, so the view upgrades itself to a live listing the day the
 * endpoint ships (or on enterprise hosts where it may already exist).
 */
import * as vscode from "vscode";
import { getClientSilent } from "./queryRunner";

export interface KnownMap {
  kmId: string;
  name?: string;
  source: "pushed" | "queried" | "manual" | "platform";
  /** Workspace file the map was pushed from, when known. */
  file?: string;
  addedAt: string;
}

function registryKey(): string {
  const apiUrl = vscode.workspace.getConfiguration("rainbird").get<string>("apiUrl") ?? "https://api.rainbird.ai";
  return `rainbird.knownMaps.${apiUrl}`;
}

const changeEmitter = new vscode.EventEmitter<void>();

/** Read-only view of pushed-map snapshots (editing one would silently diverge from the platform). */
export const SNAPSHOT_SCHEME = "rainbird-snapshot";

function environmentDir(): string {
  const apiUrl = vscode.workspace.getConfiguration("rainbird").get<string>("apiUrl") ?? "https://api.rainbird.ai";
  return encodeURIComponent(apiUrl);
}

/** Where the exact RBLang pushed to the platform is snapshotted, per environment + kmID. */
export function snapshotUri(context: vscode.ExtensionContext, kmId: string): vscode.Uri {
  return vscode.Uri.joinPath(context.globalStorageUri, "map-snapshots", environmentDir(), `${kmId}.rbl`);
}

export function recordKnownMap(
  context: vscode.ExtensionContext,
  entry: Omit<KnownMap, "addedAt"> & { rblang?: string }
): void {
  const { rblang, ...rest } = entry;
  const key = registryKey();
  const maps = context.globalState.get<KnownMap[]>(key, []);
  const existing = maps.find((m) => m.kmId === rest.kmId);
  if (existing) {
    existing.name = rest.name ?? existing.name;
    existing.file = rest.file ?? existing.file;
    if (rest.source === "pushed") existing.source = "pushed";
  } else {
    maps.unshift({ ...rest, addedAt: new Date().toISOString() });
  }
  void context.globalState.update(key, maps.slice(0, 100));

  // The platform has no export API, so the moment of push is the only chance
  // to keep this map's source retrievable — snapshot it.
  if (rblang) {
    const dir = vscode.Uri.joinPath(context.globalStorageUri, "map-snapshots", environmentDir());
    void vscode.workspace.fs
      .createDirectory(dir)
      .then(() => vscode.workspace.fs.writeFile(snapshotUri(context, rest.kmId), Buffer.from(rblang, "utf8")))
      .then(undefined, (error) => console.warn("Rainbird: could not write map snapshot:", error));
  }
  changeEmitter.fire();
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
    item.tooltip = `${map.kmId}\nsource: ${map.source}${map.file ? `\nfile: ${map.file}` : ""}`;
    item.contextValue = map.file ? "rainbirdMapWithFile" : "rainbirdMap";
    item.iconPath = new vscode.ThemeIcon(
      map.source === "pushed" ? "cloud-upload" : map.source === "platform" ? "cloud" : "circuit-board"
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

    const nodes: Node[] = [];
    if (this.liveMaps) {
      nodes.push({ kind: "info", label: `Live listing (${this.liveMaps.length} maps on platform)` });
      nodes.push(...this.liveMaps.map((m) => ({ kind: "map" as const, map: { kmId: m.id, name: m.name, source: "platform" as const, addedAt: "" } })));
    } else {
      nodes.push({
        kind: "info",
        label: "Tracked locally — the platform has no list-maps API",
        detail:
          "GET /maps returns 404 on this environment. Maps you push or query from VSCode appear here automatically; add others with +. (Platform ask #8 in PROPOSAL.md would make this a live listing.)",
      });
    }
    const known = this.context.globalState.get<KnownMap[]>(registryKey(), []);
    nodes.push(...known.map((map) => ({ kind: "map" as const, map })));
    return nodes;
  }

  async addManual(): Promise<void> {
    const kmId = await vscode.window.showInputBox({ prompt: "Knowledge Map ID (from the Publish page in Studio)" });
    if (!kmId) return;
    const name = await vscode.window.showInputBox({ prompt: "Display name (optional)" });
    recordKnownMap(this.context, { kmId: kmId.trim(), name: name || undefined, source: "manual" });
  }

  remove(node?: Node): void {
    if (!node || node.kind !== "map") return;
    const key = registryKey();
    const maps = this.context.globalState.get<KnownMap[]>(key, []).filter((m) => m.kmId !== node.map.kmId);
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
   * Click action: open the map's RBLang. The platform has no export API, so
   * the best available source wins: the workspace file it was pushed from →
   * the snapshot taken at push time → an honest explanation.
   */
  async openRblang(node?: Node): Promise<void> {
    if (!node || node.kind !== "map") return;
    const map = node.map;

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
      const readonly = vscode.Uri.from({ scheme: SNAPSHOT_SCHEME, path: `/${map.kmId}.rbl` });
      const doc = await vscode.workspace.openTextDocument(readonly);
      await vscode.window.showTextDocument(doc);
      vscode.window.setStatusBarMessage(
        `Read-only snapshot of the RBLang pushed as "${map.name ?? map.kmId}". To change it, edit a copy and push again (create-only).`,
        8000
      );
      return;
    } catch {
      // No snapshot either.
    }

    const action = await vscode.window.showInformationMessage(
      `No RBLang source is available for "${map.name ?? map.kmId}" — the platform has no export API (proposal ask #8). ` +
        `Export a .rbird from Studio and extract it, or query the map live.`,
      "Extract .rbird…",
      "Run query"
    );
    if (action === "Extract .rbird…") await vscode.commands.executeCommand("rainbird.extractRbird");
    if (action === "Run query") await vscode.commands.executeCommand("rainbird.openQueryPanelWithKm", map.kmId);
  }

  async query(node?: Node): Promise<void> {
    if (!node || node.kind !== "map") return;
    await vscode.commands.executeCommand("rainbird.openQueryPanelWithKm", node.map.kmId);
  }
}
