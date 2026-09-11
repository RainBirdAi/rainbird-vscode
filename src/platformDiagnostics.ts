/**
 * Platform validation errors as editor diagnostics.
 *
 * When a push is rejected, the platform's messages are placed on the elements
 * they are about (platformErrors.ts) and published under their own source,
 * "Rainbird platform", so they sit next to the local lint in the Problems
 * panel but are visibly not ours. They stay until the next push of that
 * document, or until it is closed; the full list is also written to the
 * Rainbird output channel, which never truncates.
 */
import * as vscode from "vscode";
import { locatePlatformErrors } from "./platformErrors";

export const PLATFORM_SOURCE = "Rainbird platform";

let collection: vscode.DiagnosticCollection | undefined;
let channel: vscode.OutputChannel | undefined;

export function registerPlatformDiagnostics(context: vscode.ExtensionContext): void {
  collection = vscode.languages.createDiagnosticCollection("rainbird-platform");
  channel = vscode.window.createOutputChannel("Rainbird");
  context.subscriptions.push(
    collection,
    channel,
    vscode.workspace.onDidCloseTextDocument((doc) => collection?.delete(doc.uri))
  );
}

export function clearPlatformErrors(uri: vscode.Uri): void {
  collection?.delete(uri);
}

/**
 * Show the platform's messages for `doc`: diagnostics at the located elements
 * plus the verbatim list in the output channel. Returns the diagnostics set.
 */
export function showPlatformErrors(doc: vscode.TextDocument, messages: string[], title: string): vscode.Diagnostic[] {
  const located = locatePlatformErrors(doc.getText(), messages);
  const diagnostics = located.map((e) => {
    const d = new vscode.Diagnostic(
      new vscode.Range(doc.positionAt(e.start), doc.positionAt(e.end)),
      e.message,
      vscode.DiagnosticSeverity.Error
    );
    d.source = PLATFORM_SOURCE;
    return d;
  });
  collection?.set(doc.uri, diagnostics);

  if (channel) {
    channel.appendLine(`[${new Date().toLocaleTimeString()}] ${title}`);
    channel.appendLine(`  ${doc.uri.fsPath || doc.uri.toString()}`);
    for (const e of located) channel.appendLine(`  line ${e.line + 1}: ${e.message}`);
    channel.appendLine("");
  }
  return diagnostics;
}

export function showPlatformOutput(): void {
  channel?.show(true);
}
