/**
 * The per-turn <context> header the extension prepends to each user message:
 * what file is open, how big it is, cursor/selection, diagnostics, platform
 * state, edit mode and whether the full file is inlined. Volatile by nature,
 * so it lives in the user message (after the cache breakpoint), never in the
 * system prompt. Pure; the vscode glue gathers the inputs.
 */
import { createHash } from "node:crypto";
import { numberLines, countLines, summariseIssues } from "./mapOverview";
import type { LintIssue } from "./lint";

/** Files up to this many characters are inlined (once per distinct content). */
export const INLINE_LIMIT = 8000;

export interface ContextInfo {
  /** Undefined when no RBLang editor is open. */
  fileName?: string;
  text?: string;
  cursorLine?: number;
  selection?: { startLine: number; endLine: number; text: string };
  issues?: LintIssue[];
  apiUrl?: string;
  kmId?: string;
  kmIdSource?: string;
  applyMode: "immediately" | "preview";
  /** Hash of the file content the model last saw (inlined, read or written). */
  lastSeenHash?: string;
  firstTurn: boolean;
  /** Preview mode: a proposal is pending and read/edit tools operate on it. */
  proposalPending?: boolean;
}

export function hashText(text: string): string {
  return createHash("sha1").update(text).digest("hex").slice(0, 16);
}

export interface ContextHeader {
  text: string;
  inlined: boolean;
  hash?: string;
}

const kb = (n: number): string => (n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} KB`);

export function buildContextHeader(info: ContextInfo): ContextHeader {
  const lines: string[] = [];
  const hash = info.text !== undefined ? hashText(info.text) : undefined;
  let inlined = false;

  if (info.fileName === undefined || info.text === undefined) {
    lines.push("file: none open (use create_map to start one, or ask the user to open a .rbl file)");
  } else {
    lines.push(`file: ${info.fileName} · ${countLines(info.text)} lines · ${kb(info.text.length)} · rblang`);
    const status = info.firstTurn
      ? "first turn"
      : info.lastSeenHash === hash
        ? "unchanged since your previous turn"
        : "changed since your previous turn — re-read before editing";
    lines.push(`status: ${status}`);
    if (info.selection) {
      lines.push(`cursor: L${info.cursorLine ?? info.selection.startLine} · selection: L${info.selection.startLine}–L${info.selection.endLine} (included below)`);
    } else if (info.cursorLine) {
      lines.push(`cursor: L${info.cursorLine}`);
    }
    if (info.issues) lines.push(`diagnostics: ${summariseIssues(info.issues)}`);
    inlined = info.text.length <= INLINE_LIMIT && (info.firstTurn || info.lastSeenHash !== hash);
  }

  const platform = info.apiUrl ? `connected to ${info.apiUrl}` : "not connected (Rainbird: Connect)";
  const km = info.kmId ? `kmID ${info.kmId}${info.kmIdSource ? ` (${info.kmIdSource})` : ""}` : "kmID not set";
  lines.push(`platform: ${platform} · ${km}`);
  lines.push(`edits: ${info.applyMode === "preview" ? `proposed for review${info.proposalPending ? " — a proposal is pending; tools read and extend it" : ""}` : "applied immediately, undoable"}`);
  if (info.text !== undefined) lines.push(`full file: ${inlined ? "included below" : "not included (use get_map_overview / read_map)"}`);

  let text = `<context>\n${lines.join("\n")}\n</context>`;
  if (inlined && info.text !== undefined) {
    const fileLines = info.text.split("\n");
    if (fileLines.at(-1) === "") fileLines.pop();
    text += `\n<active-file lines="${fileLines.length}">\n${numberLines(fileLines)}\n</active-file>`;
  }
  if (info.selection) {
    text += `\n<selection lines="${info.selection.startLine}-${info.selection.endLine}">\n${info.selection.text}\n</selection>`;
  }
  return { text, inlined, hash };
}

/** Note shown under the user's bubble in the chat. */
export function contextNote(info: ContextInfo, header: ContextHeader): string | undefined {
  if (!info.fileName) return undefined;
  const parts = [info.fileName];
  if (info.selection) parts.push(`selection L${info.selection.startLine}–${info.selection.endLine}`);
  if (header.inlined) parts.push("file attached");
  return `📎 ${parts.join(" · ")}`;
}
