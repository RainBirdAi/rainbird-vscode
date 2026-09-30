/**
 * Anthropic-powered assistant, VS Code side: key management (SecretStorage),
 * settings (model, effort, edit mode), the two cached system blocks
 * (behaviour + knowledge reference) and thin adapters that run the pure agent
 * loop in agentLoop.ts against the real SDK client.
 */
import * as vscode from "vscode";
import Anthropic from "@anthropic-ai/sdk";
import { BEHAVIOUR_PROMPT } from "./knowledge/behaviour";
import { buildKnowledgeReference } from "./knowledge";
import { validateToolInput } from "./toolSchemas";
import {
  AgentCallbacks,
  AgentResult,
  Effort,
  EFFORT_LEVELS,
  StreamFactory,
  ToolSpec,
  runAgentTurn,
  runPlainTurn,
} from "./agentLoop";

export type { ToolSpec, AgentCallbacks, AgentResult, ToolEvent, UsageTotals, Effort } from "./agentLoop";
export { describeApiError } from "./agentLoop";

const SECRET_KEY = "rainbird.anthropicApiKey";
const DEFAULT_MODEL = "claude-opus-5";

export async function setAnthropicKey(context: vscode.ExtensionContext): Promise<string | undefined> {
  const key = await vscode.window.showInputBox({
    prompt: "Anthropic API key (console.anthropic.com → API keys). Stored in VSCode SecretStorage.",
    password: true,
    ignoreFocusOut: true,
  });
  if (key) await context.secrets.store(SECRET_KEY, key);
  return key || undefined;
}

export async function hasAnthropicKey(context: vscode.ExtensionContext): Promise<boolean> {
  return Boolean(await context.secrets.get(SECRET_KEY));
}

export async function getAnthropicClient(context: vscode.ExtensionContext): Promise<Anthropic | undefined> {
  let key = await context.secrets.get(SECRET_KEY);
  if (!key) key = await setAnthropicKey(context);
  if (!key) return undefined;
  return new Anthropic({ apiKey: key });
}

const config = () => vscode.workspace.getConfiguration("rainbird");

export function getModel(): string {
  return config().get<string>("ai.model") || DEFAULT_MODEL;
}

export function getEffort(): Effort {
  const value = config().get<string>("ai.effort") ?? "high";
  return (EFFORT_LEVELS as string[]).includes(value) ? (value as Effort) : "high";
}

export type ApplyMode = "immediately" | "preview";

/** Open the before ↔ after diff automatically after a turn that changed the file (direct-apply mode). */
export function getShowDiffAfterEdits(): boolean {
  return config().get<boolean>("ai.showDiffAfterEdits") ?? true;
}

export function getApplyMode(): ApplyMode {
  return config().get<string>("ai.applyEdits") === "preview" ? "preview" : "immediately";
}

/**
 * The system prompt as two blocks: behaviour (small, may change with the tool
 * set) and the knowledge reference (large, stable, cached for an hour). One
 * cache breakpoint on the last block caches the tools and both blocks.
 */
export function buildSystemBlocks(): Anthropic.Beta.BetaTextBlockParam[] {
  return [
    { type: "text", text: BEHAVIOUR_PROMPT },
    { type: "text", text: buildKnowledgeReference(), cache_control: { type: "ephemeral", ttl: "1h" } },
  ];
}

const streamFactory =
  (client: Anthropic): StreamFactory =>
  (params, signal) =>
    client.beta.messages.stream(params, { signal });

/**
 * Stream one tool-free assistant turn and resolve with its text. `system`
 * replaces the authoring prompt (e.g. the evidence narrator); `effort`
 * defaults to the user's setting.
 */
export async function streamChat(
  client: Anthropic,
  history: Anthropic.Beta.BetaMessageParam[],
  onText: (delta: string) => void,
  signal?: AbortSignal,
  opts: { system?: string; effort?: Effort } = {}
): Promise<string> {
  const system: Anthropic.Beta.BetaTextBlockParam[] = opts.system
    ? [{ type: "text", text: opts.system, cache_control: { type: "ephemeral" } }]
    : buildSystemBlocks();
  return runPlainTurn(streamFactory(client), history, { model: getModel(), effort: opts.effort ?? getEffort(), system }, onText, signal);
}

/** Run one agentic turn against the real client with the user's settings. */
export function streamAgent(
  client: Anthropic,
  history: Anthropic.Beta.BetaMessageParam[],
  tools: ToolSpec[],
  callbacks: AgentCallbacks,
  signal?: AbortSignal
): Promise<AgentResult> {
  return runAgentTurn(
    streamFactory(client),
    history,
    tools,
    callbacks,
    { model: getModel(), effort: getEffort(), system: buildSystemBlocks(), validateInput: validateToolInput },
    signal
  );
}
