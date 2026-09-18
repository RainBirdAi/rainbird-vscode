/**
 * Formatting providers for RBLang: *Format Document*, *Format Selection* and
 * `editor.formatOnSave` all route through these. The work is done by the
 * editor-agnostic re-indenter in format.ts; this module only converts its
 * per-line results into VS Code text edits.
 */
import * as vscode from "vscode";
import { formatLines, LineEdit } from "./format";

function toTextEdits(doc: vscode.TextDocument, edits: LineEdit[]): vscode.TextEdit[] {
  return edits.map((edit) => {
    const line = doc.lineAt(edit.line);
    return vscode.TextEdit.replace(line.range, edit.text);
  });
}

export function registerFormatting(context: vscode.ExtensionContext): void {
  const selector: vscode.DocumentSelector = { language: "rblang" };

  context.subscriptions.push(
    vscode.languages.registerDocumentFormattingEditProvider(selector, {
      provideDocumentFormattingEdits(doc, options) {
        return toTextEdits(doc, formatLines(doc.getText(), options));
      },
    }),
    vscode.languages.registerDocumentRangeFormattingEditProvider(selector, {
      provideDocumentRangeFormattingEdits(doc, range, options) {
        // Indentation depends on everything above the selection, so the whole
        // document is analysed and only the selected lines are changed.
        const edits = formatLines(doc.getText(), options).filter((e) => e.line >= range.start.line && e.line <= range.end.line);
        return toTextEdits(doc, edits);
      },
    })
  );
}
