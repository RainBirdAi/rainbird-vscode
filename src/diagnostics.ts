/**
 * VS Code adapter for the RBLang linter.
 *
 * The editor-agnostic core lives in lint.ts (so the AI assistant can lint
 * generated RBLang and the unit tests can run under plain node); this module
 * wires it to a DiagnosticCollection and caches the latest issues per
 * document so the code-action provider can serve fixes without re-linting.
 */
import * as vscode from "vscode";
import { collectIssues, LintIssue } from "./lint";

export { collectIssues } from "./lint";
export type { LintIssue, LintFix } from "./lint";

/** Latest issues per document, so the code-action provider can serve fixes without re-linting. */
const latestIssues = new Map<string, LintIssue[]>();

export function getCachedIssues(uriKey: string): LintIssue[] | undefined {
  return latestIssues.get(uriKey);
}

export function registerDiagnostics(context: vscode.ExtensionContext): void {
  const collection = vscode.languages.createDiagnosticCollection("rblang");
  context.subscriptions.push(collection);

  const refresh = (doc: vscode.TextDocument) => {
    if (doc.languageId !== "rblang") return;
    collection.set(doc.uri, validate(doc));
  };

  context.subscriptions.push(
    vscode.workspace.onDidOpenTextDocument(refresh),
    vscode.workspace.onDidChangeTextDocument((e) => refresh(e.document)),
    vscode.workspace.onDidCloseTextDocument((doc) => {
      collection.delete(doc.uri);
      latestIssues.delete(doc.uri.toString());
    })
  );
  vscode.workspace.textDocuments.forEach(refresh);
}

export function validate(doc: vscode.TextDocument): vscode.Diagnostic[] {
  const severities = {
    error: vscode.DiagnosticSeverity.Error,
    warning: vscode.DiagnosticSeverity.Warning,
    info: vscode.DiagnosticSeverity.Information,
  } as const;
  const issues = collectIssues(doc.getText());
  latestIssues.set(doc.uri.toString(), issues);
  return issues.map((issue) => {
    const range = new vscode.Range(doc.positionAt(issue.start), doc.positionAt(issue.end));
    const d = new vscode.Diagnostic(range, issue.message, severities[issue.severity]);
    d.source = "rblang";
    return d;
  });
}
