/**
 * One chat's state: the conversation history (append-only), the document the
 * assistant works on and the EditApplier for it, what the model last saw, and
 * the orchestration of a turn — build the context header, run the agent loop,
 * settle the turn's edits and report back to the webview through a sink.
 */
import * as vscode from "vscode";
import type Anthropic from "@anthropic-ai/sdk";
import { getAnthropicClient, getModel, getEffort, getApplyMode, getShowDiffAfterEdits, streamAgent, describeApiError, hasAnthropicKey } from "./anthropic";
import type { ToolEvent, UsageTotals } from "./anthropic";
import { buildTools } from "./assistantTools";
import { buildContextHeader, contextNote, hashText, ContextInfo } from "./assistantContext";
import { collectIssues, LintIssue } from "./lint";
import { lintSnippet, modelChanges } from "./mapEdits";
import { createApplier, EditApplier, ApplyMode, TurnOutcome } from "./editApplier";
import { getClientSilent } from "./queryRunner";

export interface CodeBlockLint {
  issues: { line: number; severity: LintIssue["severity"]; message: string }[];
  /** Whether the block is a whole document (Replace file makes sense) or a fragment. */
  complete: boolean;
}

export interface ChangesCard {
  summary: string[];
  canUndo: boolean;
  canShowDiff: boolean;
  fileName: string;
}

export type OutboundMessage =
  | { type: "state"; hasKey: boolean; model: string; effort: string; applyMode: ApplyMode; target?: { name: string } }
  | { type: "user"; text: string; contextNote?: string }
  | { type: "start"; turnId: string; model: string }
  | { type: "thinking"; text: string }
  | { type: "delta"; text: string }
  | { type: "tool"; event: ToolEvent }
  | {
      type: "done";
      turnId: string;
      text: string;
      lints: CodeBlockLint[];
      usage?: UsageTotals;
      changes?: ChangesCard;
      proposal?: boolean;
      truncated?: boolean;
      roundCapHit?: boolean;
    }
  | { type: "error"; message: string; action?: "setKey" | "settings" }
  | { type: "reset" }
  | { type: "hint"; text: string };

export type Sink = (message: OutboundMessage) => void;

/** Roughly when a chat gets long enough that a fresh one will work better (chars / 3.5 ≈ tokens). */
const LONG_CHAT_CHARS = 900_000;

let turnCounter = 0;

export class AssistantSession {
  history: Anthropic.Beta.BetaMessageParam[] = [];
  lastSeenHash?: string;
  /** Text of the target at the start of the current turn (for semantic_diff against="turn-start"). */
  turnBefore?: string;
  private targetUri?: vscode.Uri;
  private applierInstance?: EditApplier;
  private applyMode: ApplyMode;
  private currentTurnId?: string;
  private abort?: AbortController;
  private readonly pendingCreated: string[] = [];

  constructor(readonly context: vscode.ExtensionContext) {
    this.applyMode = getApplyMode();
  }

  // ---------------------------------------------------------------- target

  /** The document the tools operate on: the adopted target while it is open, else the active or visible RBLang editor. */
  target(): vscode.TextDocument | undefined {
    if (this.targetUri) {
      const open = vscode.workspace.textDocuments.find((d) => d.uri.toString() === this.targetUri!.toString());
      if (open) return open;
      this.targetUri = undefined;
      this.applierInstance = undefined;
    }
    const active = vscode.window.activeTextEditor;
    if (active?.document.languageId === "rblang") return active.document;
    return vscode.window.visibleTextEditors.find((e) => e.document.languageId === "rblang")?.document;
  }

  /** Pin the target for the rest of the chat (after create_map, or when a turn starts). */
  adoptTarget(doc: vscode.TextDocument): void {
    if (this.targetUri?.toString() === doc.uri.toString()) return;
    this.targetUri = doc.uri;
    this.applierInstance = createApplier(this.applyMode, doc);
    if (this.currentTurnId) {
      this.applierInstance.beginTurn(this.currentTurnId);
      this.pendingCreated.push(`created ${this.fileName() ?? "a new map"}`);
    }
  }

  applier(): EditApplier | undefined {
    const doc = this.target();
    if (!doc) return undefined;
    if (!this.applierInstance || this.applierInstance.document.uri.toString() !== doc.uri.toString()) {
      this.targetUri = doc.uri;
      this.applierInstance = createApplier(this.applyMode, doc);
    }
    return this.applierInstance;
  }

  currentText(): string | undefined {
    return this.applier()?.currentText();
  }

  fileName(): string | undefined {
    const doc = this.target();
    if (!doc) return undefined;
    return doc.isUntitled ? "untitled.rbl" : doc.uri.path.split("/").pop();
  }

  kmInfo(): { kmId?: string; source?: string } {
    const doc = this.target();
    const pushed = doc ? this.context.workspaceState.get<string>(`rainbird.pushedKm.${doc.uri.toString()}`) : undefined;
    if (pushed) return { kmId: pushed, source: "this file's map (opened, pulled, pushed or bound by Knowledge Map ID)" };
    const setting = vscode.workspace.getConfiguration("rainbird", doc?.uri).get<string>("knowledgeMapId");
    if (setting) return { kmId: setting, source: "workspace setting" };
    return {};
  }

  // ---------------------------------------------------------------- lifecycle

  async state(): Promise<OutboundMessage> {
    const name = this.fileName();
    return {
      type: "state",
      hasKey: await hasAnthropicKey(this.context),
      model: getModel(),
      effort: getEffort(),
      applyMode: this.applyMode,
      ...(name ? { target: { name } } : {}),
    };
  }

  reset(): void {
    this.abort?.abort();
    this.history = [];
    this.lastSeenHash = undefined;
    this.turnBefore = undefined;
    this.applierInstance?.rejectProposal();
    this.applierInstance = undefined;
    this.targetUri = undefined;
    this.applyMode = getApplyMode();
  }

  stop(): void {
    this.abort?.abort();
  }

  get busy(): boolean {
    return this.currentTurnId !== undefined;
  }

  // ---------------------------------------------------------------- a turn

  async runTurn(text: string, sink: Sink): Promise<void> {
    if (this.busy) {
      sink({ type: "hint", text: "Still working on the previous message — press Stop first." });
      return;
    }
    const client = await getAnthropicClient(this.context);
    if (!client) {
      sink({ type: "error", message: "No Anthropic API key set. Click the key icon to add one.", action: "setKey" });
      return;
    }
    if (this.history.length === 0) this.applyMode = getApplyMode();

    const info = await this.contextInfo();
    const header = buildContextHeader(info);
    const turnId = `t${++turnCounter}`;
    const checkpoint = this.history.length;
    this.history.push({ role: "user", content: `${header.text}\n\n${text}` });
    sink({ type: "user", text, contextNote: contextNote(info, header) });
    sink({ type: "start", turnId, model: getModel() });

    const applier = this.applier();
    if (applier) this.adoptTarget(applier.document);
    this.currentTurnId = turnId;
    applier?.beginTurn(turnId);
    this.turnBefore = applier?.currentText();
    this.pendingCreated.length = 0;
    this.abort = new AbortController();

    try {
      const result = await streamAgent(
        client,
        this.history,
        buildTools(this),
        {
          onText: (delta) => sink({ type: "delta", text: delta }),
          onThinking: (delta) => sink({ type: "thinking", text: delta }),
          onTool: (event) => sink({ type: "tool", event }),
        },
        this.abort.signal
      );
      const outcome = await this.settle();
      if (outcome?.changed && !outcome.pendingProposal && getShowDiffAfterEdits()) {
        await this.applierInstance?.showDiff(turnId, { preserveFocus: true });
      }
      sink({
        type: "done",
        turnId,
        text: result.text,
        lints: this.lintCodeBlocks(result.text),
        usage: result.usage,
        changes: this.describeChanges(outcome),
        proposal: outcome?.pendingProposal,
        truncated: result.truncated,
        roundCapHit: result.roundCapHit,
      });
      if (JSON.stringify(this.history).length > LONG_CHAT_CHARS) {
        sink({ type: "hint", text: "This chat is getting long. Starting a new chat will make the assistant faster and more accurate." });
      }
    } catch (error) {
      // The turn failed: drop its incomplete history, keep whatever edits already landed.
      this.history.length = checkpoint;
      await this.settle().then((outcome) => {
        const changes = this.describeChanges(outcome);
        if (changes) sink({ type: "done", turnId, text: "", lints: [], changes, proposal: outcome?.pendingProposal });
      });
      const described = describeApiError(error);
      sink({ type: "error", message: described.message, action: described.action });
    } finally {
      this.currentTurnId = undefined;
      this.abort = undefined;
    }
  }

  private async settle(): Promise<TurnOutcome | undefined> {
    const applier = this.applierInstance;
    const outcome = applier ? await applier.endTurn() : undefined;
    const text = this.currentText();
    this.lastSeenHash = text !== undefined ? hashText(text) : undefined;
    return outcome;
  }

  private describeChanges(outcome: TurnOutcome | undefined): ChangesCard | undefined {
    if (!outcome || !this.applierInstance) return undefined;
    const summary = [...this.pendingCreated];
    if (outcome.changed) summary.push(...modelChanges(outcome.before, outcome.after));
    if (outcome.changed && summary.length === this.pendingCreated.length) summary.push("text or attribute-level edits (no model-level change)");
    if (!summary.length) return undefined;
    return {
      summary,
      canUndo: outcome.changed,
      canShowDiff: outcome.changed && !outcome.pendingProposal,
      fileName: this.fileName() ?? "map",
    };
  }

  private async contextInfo(): Promise<ContextInfo> {
    const doc = this.target();
    const editor = doc ? vscode.window.visibleTextEditors.find((e) => e.document.uri.toString() === doc.uri.toString()) : undefined;
    const connected = await getClientSilent(this.context);
    const apiUrl = connected ? vscode.workspace.getConfiguration("rainbird").get<string>("apiUrl") : undefined;
    const km = this.kmInfo();
    const info: ContextInfo = {
      applyMode: this.applyMode,
      firstTurn: this.history.length === 0,
      lastSeenHash: this.lastSeenHash,
      apiUrl,
      kmId: km.kmId,
      kmIdSource: km.source,
      proposalPending: this.applierInstance?.hasPendingProposal(),
    };
    if (doc) {
      const text = this.currentText() ?? doc.getText();
      info.fileName = this.fileName();
      info.text = text;
      info.issues = collectIssues(text);
      if (editor) {
        info.cursorLine = editor.selection.active.line + 1;
        if (!editor.selection.isEmpty) {
          info.selection = {
            startLine: editor.selection.start.line + 1,
            endLine: editor.selection.end.line + 1,
            text: doc.getText(editor.selection),
          };
        }
      }
    }
    return info;
  }

  /** Lint every fenced rblang/xml block in the reply: whole documents fully, fragments in the map's context. */
  private lintCodeBlocks(text: string): CodeBlockLint[] {
    const out: CodeBlockLint[] = [];
    const re = /```(?:rblang|xml)?[ \t]*\n([\s\S]*?)```/g;
    const host = this.currentText();
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const code = m[1];
      const complete = /^\s*(<\?xml|<rbl:kb)/.test(code);
      const issues = (complete ? collectIssues(code) : lintSnippet(code, host)).map((i) => ({ line: i.line, severity: i.severity, message: i.message }));
      out.push({ issues, complete });
    }
    return out;
  }

  // ---------------------------------------------------------------- user actions on change cards

  async undoTurn(turnId: string): Promise<boolean> {
    return (await this.applierInstance?.undoTurn(turnId)) ?? false;
  }

  async showDiff(turnId: string): Promise<void> {
    await this.applierInstance?.showDiff(turnId);
  }

  async acceptProposal(): Promise<boolean> {
    const ok = (await this.applierInstance?.acceptProposal()) ?? false;
    if (ok) {
      const text = this.currentText();
      this.lastSeenHash = text !== undefined ? hashText(text) : undefined;
    }
    return ok;
  }

  rejectProposal(): void {
    this.applierInstance?.rejectProposal();
    const text = this.currentText();
    this.lastSeenHash = text !== undefined ? hashText(text) : undefined;
  }
}
