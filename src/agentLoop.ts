/**
 * The assistant's agentic loop, independent of VS Code: shape one request
 * (adaptive thinking, effort, cached system blocks, tools with eager input
 * streaming, server-side tool-result clearing), stream it, validate and run
 * the tool calls the model makes, feed the results back, repeat. A
 * StreamFactory abstracts the SDK call so the loop is unit-tested with a fake.
 *
 * History is append-only: assistant turns are stored with their full content
 * (including thinking blocks, which the API requires back unchanged) and tool
 * results go in one user message per round.
 */
import Anthropic from "@anthropic-ai/sdk";

/** The request body accepted by client.beta.messages.stream. */
export type StreamParams = Parameters<Anthropic["beta"]["messages"]["stream"]>[0];


export type Effort = "low" | "medium" | "high" | "xhigh" | "max";
export const EFFORT_LEVELS: Effort[] = ["low", "medium", "high", "xhigh", "max"];

/** A tool the assistant can call. `confirm` (if set) gates execution behind user approval. */
export interface ToolSpec {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
  /** Let the API enforce the schema (flat schemas only). */
  strict?: boolean;
  run(input: Record<string, unknown>): Promise<string>;
  confirm?(input: Record<string, unknown>): Promise<boolean>;
  /** Short status line for the UI, e.g. "Editing map: 3 operations". */
  label?(input: Record<string, unknown>): string;
}

export interface ToolEvent {
  id: string;
  name: string;
  status: "pending" | "running" | "done" | "error";
  label: string;
  /** First line of the result (done) or the error message (error). */
  detail?: string;
}

export interface UsageTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  rounds: number;
}

export interface AgentCallbacks {
  onText(delta: string): void;
  onThinking?(delta: string): void;
  onTool?(event: ToolEvent): void;
  onUsage?(usage: UsageTotals): void;
}

export interface AgentOptions {
  model: string;
  effort: Effort;
  system: Anthropic.Beta.BetaTextBlockParam[];
  /** Rounds of model calls per turn before the loop asks the model to wrap up. Default 25. */
  maxRounds?: number;
  /** Default 64000. */
  maxTokens?: number;
  /** Returns a problem description when a tool input is invalid. */
  validateInput?(name: string, input: unknown): string | undefined;
  /** Server-side clearing of old tool results (beta). Default true. */
  contextManagement?: boolean;
}

export interface AgentResult {
  text: string;
  /** The model hit max_tokens; its last message is incomplete. */
  truncated: boolean;
  /** The round cap was reached and the model was asked to wrap up. */
  roundCapHit: boolean;
  usage: UsageTotals;
}

/** The subset of the SDK's message stream the loop relies on. */
export interface StreamLike {
  on(event: "text", listener: (delta: string) => void): unknown;
  on(event: "thinking", listener: (delta: string) => void): unknown;
  on(event: "streamEvent", listener: (event: Anthropic.Beta.BetaRawMessageStreamEvent) => void): unknown;
  finalMessage(): Promise<Anthropic.Beta.BetaMessage>;
}

export type StreamFactory = (params: StreamParams, signal?: AbortSignal) => StreamLike;

export const BETAS = ["server-side-fallback-2026-07-01"];
const CONTEXT_MANAGEMENT_BETA = "context-management-2025-06-27";

export function toolDefinitions(tools: ToolSpec[]): Anthropic.Beta.BetaTool[] {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.input_schema as Anthropic.Beta.BetaTool["input_schema"],
    eager_input_streaming: true,
    ...(t.strict ? { strict: true } : {}),
  }));
}

/** The request body shared by every round of a turn. */
export function buildRequest(
  history: Anthropic.Beta.BetaMessageParam[],
  tools: ToolSpec[],
  options: AgentOptions,
  extra: Partial<StreamParams> = {}
): StreamParams {
  const contextManagement = options.contextManagement ?? true;
  return {
    model: options.model,
    max_tokens: options.maxTokens ?? 64000,
    betas: contextManagement ? [...BETAS, CONTEXT_MANAGEMENT_BETA] : [...BETAS],
    fallbacks: "default",
    thinking: { type: "adaptive", display: "summarized" },
    output_config: { effort: options.effort },
    system: options.system,
    ...(tools.length ? { tools: toolDefinitions(tools) } : {}),
    ...(contextManagement && tools.length
      ? {
          context_management: {
            edits: [
              {
                type: "clear_tool_uses_20250919",
                trigger: { type: "input_tokens", value: 80000 },
                keep: { type: "tool_uses", value: 8 },
              },
            ],
          },
        }
      : {}),
    messages: history,
    ...extra,
  };
}

const emptyUsage = (): UsageTotals => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, rounds: 0 });

function addUsage(total: UsageTotals, usage: Anthropic.Beta.BetaUsage | undefined): void {
  total.rounds++;
  if (!usage) return;
  total.input += usage.input_tokens ?? 0;
  total.output += usage.output_tokens ?? 0;
  total.cacheRead += usage.cache_read_input_tokens ?? 0;
  total.cacheWrite += usage.cache_creation_input_tokens ?? 0;
}

function textOf(message: Anthropic.Beta.BetaMessage): string {
  return message.content
    .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");
}

function summarise(text: string, max = 140): string {
  const first = text.split("\n").find((l) => l.trim()) ?? "";
  return first.length > max ? first.slice(0, max - 1) + "…" : first;
}

export function defaultLabel(name: string, input: Record<string, unknown>): string {
  const detail = Object.entries(input)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}=${typeof v === "string" ? (v.length > 40 ? v.slice(0, 40) + "…" : v) : JSON.stringify(v)?.slice(0, 40)}`)
    .join(", ");
  return detail ? `${name}(${detail})` : name;
}

/** Run one request and stream its text/thinking to the callbacks. */
async function runRound(
  stream: StreamFactory,
  params: StreamParams,
  callbacks: AgentCallbacks,
  tools: ToolSpec[],
  signal: AbortSignal | undefined,
  onText: (delta: string) => void
): Promise<Anthropic.Beta.BetaMessage> {
  const s = stream(params, signal);
  s.on("text", onText);
  if (callbacks.onThinking) s.on("thinking", (delta) => callbacks.onThinking?.(delta));
  if (callbacks.onTool) {
    s.on("streamEvent", (event) => {
      if (event.type === "content_block_start" && event.content_block.type === "tool_use") {
        const name = event.content_block.name;
        const tool = tools.find((t) => t.name === name);
        callbacks.onTool?.({ id: event.content_block.id, name, status: "pending", label: tool ? name : `unknown tool ${name}` });
      }
    });
  }
  const final = await s.finalMessage();
  if (final.stop_reason === "refusal") {
    throw new Error(final.stop_details?.explanation ?? "The model declined this request.");
  }
  return final;
}

/**
 * Agentic loop: stream a turn, execute any tool calls, feed results back,
 * repeat until the model stops. Mutates `history` in place so the conversation
 * can continue naturally. Rejects on abort, refusal or API errors — the caller
 * decides how much of the appended history to keep.
 */
export async function runAgentTurn(
  stream: StreamFactory,
  history: Anthropic.Beta.BetaMessageParam[],
  tools: ToolSpec[],
  callbacks: AgentCallbacks,
  options: AgentOptions,
  signal?: AbortSignal
): Promise<AgentResult> {
  const maxRounds = options.maxRounds ?? 25;
  const usage = emptyUsage();
  let visibleText = "";
  const onText = (delta: string) => {
    visibleText += delta;
    callbacks.onText(delta);
  };

  for (let round = 0; round < maxRounds; round++) {
    const final = await runRound(stream, buildRequest(history, tools, options), callbacks, tools, signal, onText);
    addUsage(usage, final.usage);
    callbacks.onUsage?.(usage);
    history.push({ role: "assistant", content: final.content });

    if (final.stop_reason === "max_tokens") return { text: visibleText, truncated: true, roundCapHit: false, usage };
    if (final.stop_reason !== "tool_use") return { text: visibleText, truncated: false, roundCapHit: false, usage };

    const toolUses = final.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use");
    const lastRound = round === maxRounds - 1;
    const results: Anthropic.Beta.BetaToolResultBlockParam[] = [];

    for (const use of toolUses) {
      if (lastRound) {
        results.push({
          type: "tool_result",
          tool_use_id: use.id,
          content: "Tool budget for this turn is exhausted. Summarise what you did and what remains for the user.",
          is_error: true,
        });
        callbacks.onTool?.({ id: use.id, name: use.name, status: "error", label: use.name, detail: "tool budget exhausted" });
        continue;
      }
      results.push(await executeTool(use, tools, options, callbacks));
    }
    history.push({ role: "user", content: results });

    if (lastRound) {
      // One final, tool-free request so the turn ends with a summary instead of a dangling tool call.
      const closing = await runRound(
        stream,
        buildRequest(history, tools, options, { tool_choice: { type: "none" } }),
        callbacks,
        tools,
        signal,
        onText
      );
      addUsage(usage, closing.usage);
      callbacks.onUsage?.(usage);
      history.push({ role: "assistant", content: closing.content });
      return { text: visibleText, truncated: closing.stop_reason === "max_tokens", roundCapHit: true, usage };
    }
  }
  return { text: visibleText, truncated: false, roundCapHit: true, usage };
}

async function executeTool(
  use: Anthropic.Beta.BetaToolUseBlock,
  tools: ToolSpec[],
  options: AgentOptions,
  callbacks: AgentCallbacks
): Promise<Anthropic.Beta.BetaToolResultBlockParam> {
  const tool = tools.find((t) => t.name === use.name);
  const input = (use.input ?? {}) as Record<string, unknown>;
  const fail = (label: string, content: string): Anthropic.Beta.BetaToolResultBlockParam => {
    callbacks.onTool?.({ id: use.id, name: use.name, status: "error", label, detail: summarise(content) });
    return { type: "tool_result", tool_use_id: use.id, content, is_error: true };
  };

  if (!tool) return fail(use.name, `Unknown tool: ${use.name}`);
  const problem = options.validateInput?.(use.name, input);
  if (problem) return fail(use.name, `INVALID_INPUT: ${problem}. Check the tool's schema and call it again.`);

  const label = tool.label ? tool.label(input) : defaultLabel(use.name, input);
  if (tool.confirm && !(await tool.confirm(input))) return fail(label, "The user declined this action.");

  callbacks.onTool?.({ id: use.id, name: use.name, status: "running", label });
  try {
    const content = await tool.run(input);
    callbacks.onTool?.({ id: use.id, name: use.name, status: "done", label, detail: summarise(content) });
    return { type: "tool_result", tool_use_id: use.id, content };
  } catch (error) {
    return fail(label, `Tool failed: ${(error as Error).message}`);
  }
}

/** Stream one tool-free assistant message (used by the query panel's evidence explanation). */
export async function runPlainTurn(
  stream: StreamFactory,
  history: Anthropic.Beta.BetaMessageParam[],
  options: AgentOptions,
  onText: (delta: string) => void,
  signal?: AbortSignal
): Promise<string> {
  const final = await runRound(stream, buildRequest(history, [], { ...options, contextManagement: false }), { onText }, [], signal, onText);
  return textOf(final);
}

/** A user-facing description of an API failure and, where one exists, the action that fixes it. */
export function describeApiError(error: unknown): { message: string; action?: "setKey" | "settings" } {
  if (error instanceof Anthropic.APIUserAbortError || (error as Error)?.name === "AbortError") return { message: "Stopped." };
  if (error instanceof Anthropic.AuthenticationError) {
    return { message: "Anthropic rejected the API key. Set a valid key to continue.", action: "setKey" };
  }
  if (error instanceof Anthropic.PermissionDeniedError) {
    return { message: `Anthropic refused the request (permission denied): ${error.message}`, action: "settings" };
  }
  if (error instanceof Anthropic.RateLimitError) {
    const retry = error.headers?.get?.("retry-after");
    return { message: `Rate limited by Anthropic${retry ? ` — try again in ${retry}s` : "; try again shortly"}.` };
  }
  if (error instanceof Anthropic.NotFoundError) {
    return { message: `Model not found: ${error.message}. Check the rainbird.ai.model setting.`, action: "settings" };
  }
  if (error instanceof Anthropic.BadRequestError) {
    const hint = /model|thinking|effort|beta/i.test(error.message) ? " Check the rainbird.ai.model and rainbird.ai.effort settings." : "";
    return { message: `Anthropic rejected the request: ${error.message}${hint}`, action: hint ? "settings" : undefined };
  }
  if (error instanceof Anthropic.APIConnectionError) {
    return { message: "Could not reach the Anthropic API. Check your network connection and try again." };
  }
  if (error instanceof Anthropic.APIError) return { message: `Anthropic API error ${error.status ?? ""}: ${error.message}`.trim() };
  return { message: (error as Error)?.message ?? String(error) };
}
