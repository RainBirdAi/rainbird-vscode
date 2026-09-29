/**
 * Symbol-level language features for RBLang: go-to-definition, find-references,
 * F2 rename and live linked editing for concepts / relationships / instances
 * (single-file scope in the prototype), plus a CodeLens on every relationship:
 * run it as a query, see its rule/fact counts.
 *
 * Symbol resolution itself lives in symbols.ts (vscode-free, unit tested);
 * this file only adapts offsets to editor ranges.
 *
 * Linked editing mirrors keystrokes in a declaration's name="…" into every
 * mention as you type. It is offered from the declaration only: typing in a
 * reference (rel subject="Person") is usually meant to point it at another
 * symbol, not to rename this one. VS Code has editor.linkedEditing off by
 * default; package.json turns it on for the rblang language.
 */
import * as vscode from "vscode";
import { buildIndex, relinstCounts } from "./mapIndex";
import { declarationOf, LINKED_NAME_PATTERN, linkedSpans, renameEdits, Span, spansAt, symbolAt } from "./symbols";

function toRange(doc: vscode.TextDocument, span: Span): vscode.Range {
  return new vscode.Range(doc.positionAt(span.start), doc.positionAt(span.end));
}

export function registerLanguageFeatures(context: vscode.ExtensionContext): void {
  const selector: vscode.DocumentSelector = { language: "rblang" };

  context.subscriptions.push(
    vscode.languages.registerDefinitionProvider(selector, {
      provideDefinition(doc, position) {
        const { index, hit } = symbolAt(doc.getText(), doc.offsetAt(position));
        if (!hit) return undefined;
        const offset = declarationOf(index, hit);
        if (offset === undefined) return undefined;
        return new vscode.Location(doc.uri, doc.positionAt(offset));
      },
    }),

    vscode.languages.registerReferenceProvider(selector, {
      provideReferences(doc, position) {
        const found = spansAt(doc.getText(), doc.offsetAt(position));
        if (!found) return undefined;
        return found.spans.map((span) => new vscode.Location(doc.uri, toRange(doc, span)));
      },
    }),

    vscode.languages.registerRenameProvider(selector, {
      prepareRename(doc, position) {
        const { hit } = symbolAt(doc.getText(), doc.offsetAt(position));
        if (!hit) throw new Error("You can rename concepts, relationships and instances (place the cursor on the name).");
        return toRange(doc, hit.span);
      },
      provideRenameEdits(doc, position, newName) {
        const edits = renameEdits(doc.getText(), doc.offsetAt(position), newName);
        if (!edits) return undefined;
        const edit = new vscode.WorkspaceEdit();
        for (const e of edits) edit.replace(doc.uri, toRange(doc, e), e.newText);
        return edit;
      },
    }),

    vscode.languages.registerLinkedEditingRangeProvider(selector, {
      provideLinkedEditingRanges(doc, position) {
        const linked = linkedSpans(doc.getText(), doc.offsetAt(position));
        if (!linked) return undefined;
        return new vscode.LinkedEditingRanges(
          linked.spans.map((span) => toRange(doc, span)),
          LINKED_NAME_PATTERN
        );
      },
    }),

    vscode.languages.registerCodeLensProvider(selector, new RelCodeLensProvider(context))
  );
}

class RelCodeLensProvider implements vscode.CodeLensProvider {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this.emitter.event;
  private debounce?: NodeJS.Timeout;

  constructor(context: vscode.ExtensionContext) {
    context.subscriptions.push(
      vscode.workspace.onDidChangeTextDocument((e) => {
        if (e.document.languageId !== "rblang") return;
        clearTimeout(this.debounce);
        this.debounce = setTimeout(() => this.emitter.fire(), 500);
      })
    );
  }

  provideCodeLenses(doc: vscode.TextDocument): vscode.CodeLens[] {
    const index = buildIndex(doc.getText());
    const counts = relinstCounts(index);
    const lenses: vscode.CodeLens[] = [];
    for (const [name, rel] of index.relationships) {
      const range = new vscode.Range(doc.positionAt(rel.offset), doc.positionAt(rel.offset));
      lenses.push(
        new vscode.CodeLens(range, {
          title: "$(play) Run query",
          command: "rainbird.openQueryPanelWithGoal",
          arguments: [name],
        })
      );
      const count = counts.get(name);
      if (count && (count.rules || count.facts)) {
        const parts = [];
        if (count.rules) parts.push(`${count.rules} rule${count.rules > 1 ? "s" : ""}`);
        if (count.facts) parts.push(`${count.facts} fact${count.facts > 1 ? "s" : ""}`);
        lenses.push(
          new vscode.CodeLens(range, {
            title: parts.join(" · "),
            command: "rainbird.openGraphView",
          })
        );
      }
    }
    return lenses;
  }
}
