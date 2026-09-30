/**
 * How the assistant's edits reach the user's document. Two implementations
 * behind one seam: ImmediateApplier writes each edit_map call into the buffer
 * as one undoable step and snapshots the text per turn (for Show diff / Undo);
 * PreviewApplier accumulates a proposal and only touches the file when the
 * user accepts it from the chat. Both apply a single minimal-range edit so the
 * cursor, folds and undo history stay sane.
 */
import * as vscode from "vscode";
import { computeMinimalEdit } from "./mapEdits";

export type ApplyMode = "immediately" | "preview";

export interface TurnOutcome {
  turnId: string;
  before: string;
  after: string;
  changed: boolean;
  /** Preview mode: the turn produced a proposal that awaits Accept / Reject. */
  pendingProposal: boolean;
}

export interface EditApplier {
  readonly mode: ApplyMode;
  readonly document: vscode.TextDocument;
  /** The text tools read and edit this turn: the document, or the pending proposal. */
  currentText(): string;
  /** Persist a complete new text produced by the edit engine. */
  apply(newText: string, label: string): Promise<void>;
  beginTurn(turnId: string): void;
  endTurn(): Promise<TurnOutcome>;
  /** Restore the text from before the turn. Resolves false when the user cancelled. */
  undoTurn(turnId: string): Promise<boolean>;
  /** Open the before ↔ after diff for a turn. `preserveFocus` keeps the chat focused (used when opening automatically). */
  showDiff(turnId: string, options?: { preserveFocus?: boolean }): Promise<void>;
  hasPendingProposal(): boolean;
  acceptProposal(): Promise<boolean>;
  rejectProposal(): void;
}

// ---------------------------------------------------------------------------
// Virtual documents for diffs: rainbird-turn:<key> (pre-turn snapshots) and
// rainbird-proposal:<key> (pending proposals).

export const TURN_SCHEME = "rainbird-turn";
export const PROPOSAL_SCHEME = "rainbird-proposal";

class TextStore implements vscode.TextDocumentContentProvider {
  private readonly texts = new Map<string, string>();
  private readonly emitter = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.emitter.event;

  constructor(private readonly scheme: string) {}

  uri(key: string, label: string): vscode.Uri {
    return vscode.Uri.from({ scheme: this.scheme, path: `/${label}`, query: key });
  }

  set(key: string, label: string, text: string): vscode.Uri {
    this.texts.set(key, text);
    const uri = this.uri(key, label);
    this.emitter.fire(uri);
    return uri;
  }

  delete(key: string): void {
    this.texts.delete(key);
  }

  provideTextDocumentContent(uri: vscode.Uri): string {
    return this.texts.get(uri.query) ?? "";
  }
}

const turnStore = new TextStore(TURN_SCHEME);
const proposalStore = new TextStore(PROPOSAL_SCHEME);

export function registerEditApplierProviders(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(TURN_SCHEME, turnStore),
    vscode.workspace.registerTextDocumentContentProvider(PROPOSAL_SCHEME, proposalStore)
  );
}

const baseName = (doc: vscode.TextDocument): string => doc.uri.path.split("/").pop() || "untitled.rbl";

/** Replace the document's text with `newText` through one minimal-range WorkspaceEdit (one undo step). */
export async function writeDocument(doc: vscode.TextDocument, newText: string): Promise<boolean> {
  const current = doc.getText();
  if (current === newText) return true;
  const { start, end, newText: replacement } = computeMinimalEdit(current, newText);
  const edit = new vscode.WorkspaceEdit();
  edit.replace(doc.uri, new vscode.Range(doc.positionAt(start), doc.positionAt(end)), replacement);
  return vscode.workspace.applyEdit(edit);
}

async function confirmOverwrite(doc: vscode.TextDocument, what: string): Promise<boolean> {
  const choice = await vscode.window.showWarningMessage(
    `${baseName(doc)} has changed since the assistant ${what}. Overwrite the current text anyway?`,
    { modal: true },
    "Overwrite"
  );
  return choice === "Overwrite";
}

// ---------------------------------------------------------------------------

abstract class BaseApplier implements EditApplier {
  abstract readonly mode: ApplyMode;
  protected readonly snapshots = new Map<string, { before: string; after: string }>();
  protected turnId?: string;
  protected turnBefore?: string;

  constructor(readonly document: vscode.TextDocument) {}

  abstract currentText(): string;
  abstract apply(newText: string, label: string): Promise<void>;
  abstract hasPendingProposal(): boolean;
  abstract acceptProposal(): Promise<boolean>;
  abstract rejectProposal(): void;

  beginTurn(turnId: string): void {
    this.turnId = turnId;
    this.turnBefore = this.currentText();
  }

  async endTurn(): Promise<TurnOutcome> {
    const turnId = this.turnId ?? "turn";
    const before = this.turnBefore ?? this.currentText();
    const after = this.currentText();
    const changed = before !== after;
    if (changed) this.snapshots.set(turnId, { before, after });
    this.turnId = undefined;
    this.turnBefore = undefined;
    return { turnId, before, after, changed, pendingProposal: false };
  }

  async undoTurn(turnId: string): Promise<boolean> {
    const snap = this.snapshots.get(turnId);
    if (!snap) return false;
    if (this.document.getText() !== snap.after && !(await confirmOverwrite(this.document, "made these changes"))) return false;
    const ok = await writeDocument(this.document, snap.before);
    if (ok) this.snapshots.delete(turnId);
    return ok;
  }

  async showDiff(turnId: string, options: { preserveFocus?: boolean } = {}): Promise<void> {
    const snap = this.snapshots.get(turnId);
    if (!snap) {
      if (!options.preserveFocus) vscode.window.showInformationMessage("No changes recorded for that turn.");
      return;
    }
    const uri = turnStore.set(`${this.document.uri.toString()}#${turnId}`, `${baseName(this.document)} (before)`, snap.before);
    await vscode.commands.executeCommand("vscode.diff", uri, this.document.uri, `${baseName(this.document)}: before this turn ↔ now`, {
      preview: true,
      preserveFocus: options.preserveFocus ?? false,
    } as vscode.TextDocumentShowOptions);
  }
}

/** Edits land in the buffer as they happen. */
export class ImmediateApplier extends BaseApplier {
  readonly mode: ApplyMode = "immediately";

  currentText(): string {
    return this.document.getText();
  }

  async apply(newText: string): Promise<void> {
    const ok = await writeDocument(this.document, newText);
    if (!ok) throw new Error("VS Code rejected the edit (is the file read-only?).");
  }

  hasPendingProposal(): boolean {
    return false;
  }
  async acceptProposal(): Promise<boolean> {
    return false;
  }
  rejectProposal(): void {}
}

/** Edits accumulate in a proposal; the file changes only on Accept. */
export class PreviewApplier extends BaseApplier {
  readonly mode: ApplyMode = "preview";
  private proposal?: string;
  /** Document text when the proposal was started — the staleness baseline. */
  private original?: string;

  private get key(): string {
    return `${this.document.uri.toString()}#proposal`;
  }

  currentText(): string {
    return this.proposal ?? this.document.getText();
  }

  async apply(newText: string): Promise<void> {
    if (this.proposal === undefined) this.original = this.document.getText();
    this.proposal = newText;
    proposalStore.set(this.key, `${baseName(this.document)} (proposed)`, newText);
  }

  async endTurn(): Promise<TurnOutcome> {
    const outcome = await super.endTurn();
    const pending = this.hasPendingProposal();
    if (pending) {
      const uri = proposalStore.set(this.key, `${baseName(this.document)} (proposed)`, this.proposal!);
      await vscode.commands.executeCommand("vscode.diff", this.document.uri, uri, `${baseName(this.document)}: current ↔ proposed by the assistant`, {
        preview: true,
        preserveFocus: true,
      } as vscode.TextDocumentShowOptions);
    }
    return { ...outcome, pendingProposal: pending };
  }

  hasPendingProposal(): boolean {
    return this.proposal !== undefined && this.proposal !== (this.original ?? this.document.getText());
  }

  async acceptProposal(): Promise<boolean> {
    if (this.proposal === undefined) return false;
    if (this.original !== undefined && this.document.getText() !== this.original && !(await confirmOverwrite(this.document, "proposed these changes"))) return false;
    const before = this.document.getText();
    const ok = await writeDocument(this.document, this.proposal);
    if (ok) {
      this.snapshots.set(`accepted-${Date.now()}`, { before, after: this.proposal });
      this.clear();
    }
    return ok;
  }

  rejectProposal(): void {
    this.clear();
  }

  async undoTurn(turnId: string): Promise<boolean> {
    // In preview mode a turn's "changes" are the proposal; undoing means discarding it.
    if (this.hasPendingProposal()) {
      this.clear();
      return true;
    }
    return super.undoTurn(turnId);
  }

  private clear(): void {
    this.proposal = undefined;
    this.original = undefined;
    proposalStore.delete(this.key);
  }
}

export function createApplier(mode: ApplyMode, document: vscode.TextDocument): EditApplier {
  return mode === "preview" ? new PreviewApplier(document) : new ImmediateApplier(document);
}
