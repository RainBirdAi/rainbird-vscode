/**
 * Map Explorer: a sidebar tree of the active RBLang document's concepts,
 * relationships, instances and rules. Clicking an item reveals its source.
 */
import * as vscode from "vscode";
import { buildIndex } from "./mapIndex";

type Item = CategoryItem | EntryItem;

interface CategoryItem {
  kind: "category";
  label: string;
  icon: string;
  entries: EntryItem[];
}

interface EntryItem {
  kind: "entry";
  label: string;
  description?: string;
  icon: string;
  offset: number;
}

export class MapTreeProvider implements vscode.TreeDataProvider<Item> {
  public static readonly viewId = "rainbird.mapExplorer";

  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.emitter.event;

  private doc?: vscode.TextDocument;
  private debounce?: NodeJS.Timeout;

  constructor(context: vscode.ExtensionContext) {
    context.subscriptions.push(
      vscode.window.onDidChangeActiveTextEditor((editor) => {
        if (editor?.document.languageId === "rblang") {
          this.doc = editor.document;
          this.emitter.fire();
        }
      }),
      vscode.workspace.onDidChangeTextDocument((e) => {
        if (e.document === this.doc) {
          clearTimeout(this.debounce);
          this.debounce = setTimeout(() => this.emitter.fire(), 500);
        }
      })
    );
    const active = vscode.window.activeTextEditor;
    if (active?.document.languageId === "rblang") this.doc = active.document;
  }

  getTreeItem(item: Item): vscode.TreeItem {
    if (item.kind === "category") {
      const tree = new vscode.TreeItem(
        `${item.label} (${item.entries.length})`,
        item.entries.length
          ? vscode.TreeItemCollapsibleState.Expanded
          : vscode.TreeItemCollapsibleState.None
      );
      tree.iconPath = new vscode.ThemeIcon(item.icon);
      return tree;
    }
    const tree = new vscode.TreeItem(item.label, vscode.TreeItemCollapsibleState.None);
    tree.description = item.description;
    tree.iconPath = new vscode.ThemeIcon(item.icon);
    tree.command = {
      command: "rainbird.revealOffset",
      title: "Reveal",
      arguments: [this.doc?.uri, item.offset],
    };
    return tree;
  }

  getChildren(item?: Item): Item[] {
    if (item) return item.kind === "category" ? item.entries : [];
    if (!this.doc) return [];

    const text = this.doc.getText();
    const index = buildIndex(text);

    const concepts: EntryItem[] = [...index.concepts.entries()].map(([name, c]) => ({
      kind: "entry",
      label: name,
      description: c.type,
      icon: "symbol-class",
      offset: c.offset,
    }));
    const rels: EntryItem[] = [...index.relationships.entries()].map(([name, r]) => ({
      kind: "entry",
      label: name,
      description: `${r.subject} → ${r.object}${r.plural ? " (plural)" : ""}`,
      icon: "arrow-right",
      offset: r.offset,
    }));
    const instances: EntryItem[] = [...index.instances.entries()].map(([name, i]) => ({
      kind: "entry",
      label: name,
      description: i.type,
      icon: "symbol-field",
      offset: i.offset,
    }));

    const rules: EntryItem[] = [];
    for (let i = 0; i < index.tags.length; i++) {
      const tag = index.tags[i];
      if (tag.closing || tag.name !== "relinst" || tag.selfClosing) continue;
      let hasCondition = false;
      for (let j = i + 1; j < index.tags.length; j++) {
        const inner = index.tags[j];
        if (inner.name === "relinst" && inner.closing) break;
        if (inner.name === "condition" && !inner.closing) {
          hasCondition = true;
          break;
        }
      }
      if (hasCondition) {
        rules.push({
          kind: "entry",
          label: tag.attrs.name || tag.attrs.type || "rule",
          description: tag.attrs.name ? tag.attrs.type : tag.attrs.cf ? `cf ${tag.attrs.cf}` : undefined,
          icon: "law",
          offset: tag.start,
        });
      }
    }

    return [
      { kind: "category", label: "Concepts", icon: "symbol-class", entries: concepts },
      { kind: "category", label: "Relationships", icon: "arrow-right", entries: rels },
      { kind: "category", label: "Rules", icon: "law", entries: rules },
      { kind: "category", label: "Instances", icon: "symbol-field", entries: instances },
    ];
  }
}

export async function revealOffset(uri?: vscode.Uri, offset?: number): Promise<void> {
  if (!uri) return;
  const doc = await vscode.workspace.openTextDocument(uri);
  const editor = await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.One });
  const position = doc.positionAt(offset ?? 0);
  editor.selection = new vscode.Selection(position, position);
  editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenter);
}
