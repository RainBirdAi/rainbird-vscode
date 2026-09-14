/**
 * Recognise RBLang stored under a foreign extension (usually `.xml`, as the
 * platform and Studio hand it out) and retype the document as `rblang`.
 *
 * A declarative `firstLine` match cannot do this: VS Code only consults it
 * when no language has claimed the extension, and the built-in XML language
 * claims `.xml`. It also only looks at line one, while an RBLang file starts
 * with the `<?xml …?>` declaration and puts `<rbl:kb>` on line two. So the
 * check runs programmatically on every open. `setTextDocumentLanguage`
 * closes and reopens the document under the new id, which makes the existing
 * `onDidOpenTextDocument` listeners (diagnostics, map explorer, …) fire again
 * and treat it as RBLang with no further changes.
 *
 * The text check itself lives in detect.ts, free of VS Code imports, so the
 * unit tests can run under plain node.
 */
import * as vscode from "vscode";
import { looksLikeRblang } from "./detect";

/** Only documents VS Code typed by default are retyped, never one the user set by hand. */
const SOURCE_LANGUAGES = new Set(["xml", "plaintext"]);

/** Retype `doc` as RBLang when it is a foreign-typed document that holds an RBLang map. */
export async function detectRblang(doc: vscode.TextDocument): Promise<void> {
  if (!SOURCE_LANGUAGES.has(doc.languageId)) return;
  if (!looksLikeRblang(doc.getText(new vscode.Range(0, 0, 64, 0)))) return;
  try {
    await vscode.languages.setTextDocumentLanguage(doc, "rblang");
  } catch {
    // The document may have been closed between the check and the switch.
  }
}

export function registerLanguageDetection(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.workspace.onDidOpenTextDocument((doc) => void detectRblang(doc)),
    // RBLang pasted from the platform into a new untitled document should get
    // linting at once. Saved files are only checked on open, so a `.txt` or
    // `.xml` the user is editing never flips underneath them.
    vscode.workspace.onDidChangeTextDocument((e) => {
      if (e.document.isUntitled) void detectRblang(e.document);
    })
  );
  // Documents already open when the extension activates (onLanguage:xml fires
  // after the first XML document is open, so it is in this list).
  vscode.workspace.textDocuments.forEach((doc) => void detectRblang(doc));
}
