/**
 * The agent loop under a fake stream: request shape, parallel tool results in
 * one user message, input validation, max_tokens handling, the round cap and
 * usage accumulation — none of which should need a network or VS Code.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import type Anthropic from "@anthropic-ai/sdk";
import { runAgentTurn, buildRequest, StreamFactory, StreamLike, ToolSpec, ToolEvent, StreamParams } from "../agentLoop";
import { validateToolInput } from "../toolSchemas";

type Message = Anthropic.Beta.BetaMessage;

function message(content: Message["content"], stop: Message["stop_reason"], usage: Partial<Message["usage"]> = {}): Message {
  return {
    id: "msg",
    type: "message",
    role: "assistant",
    model: "fake",
    content,
    stop_reason: stop,
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, ...usage } as Message["usage"],
  } as unknown as Message;
}

const text = (t: string): Anthropic.Beta.BetaTextBlock => ({ type: "text", text: t, citations: null });
const toolUse = (id: string, name: string, input: unknown): Anthropic.Beta.BetaToolUseBlock => ({ type: "tool_use", id, name, input } as Anthropic.Beta.BetaToolUseBlock);

/** A stream factory that replays scripted messages and records every request body. */
function fakeStream(script: Message[]): { factory: StreamFactory; requests: StreamParams[] } {
  const requests: StreamParams[] = [];
  const factory: StreamFactory = (params) => {
    requests.push(params);
    const final = script.shift();
    if (!final) throw new Error("fake stream ran out of scripted messages");
    const stream: StreamLike = {
      on(event: string, listener: (...args: never[]) => void) {
        if (event === "text") for (const b of final.content) if (b.type === "text") (listener as (d: string) => void)(b.text);
        return stream;
      },
      finalMessage: async () => final,
    } as StreamLike;
    return stream;
  };
  return { factory, requests };
}

const options = { model: "fake-model", effort: "high" as const, system: [{ type: "text" as const, text: "sys" }], validateInput: validateToolInput };

const echoTool = (calls: unknown[]): ToolSpec => ({
  name: "get_diagnostics",
  description: "d",
  input_schema: { type: "object", properties: {}, additionalProperties: false },
  async run(input) {
    calls.push(input);
    return `diag for ${JSON.stringify(input)}`;
  },
});

describe("agent loop", () => {
  test("request shape: adaptive thinking, effort, betas, tools with eager streaming, cache on the last system block", () => {
    const req = buildRequest([], [echoTool([])], {
      ...options,
      system: [
        { type: "text", text: "a" },
        { type: "text", text: "b", cache_control: { type: "ephemeral", ttl: "1h" } },
      ],
    });
    assert.equal(req.model, "fake-model");
    assert.deepEqual(req.thinking, { type: "adaptive", display: "summarized" });
    assert.deepEqual(req.output_config, { effort: "high" });
    assert.ok(req.betas?.includes("server-side-fallback-2026-07-01"));
    assert.equal(req.fallbacks, "default");
    const tools = req.tools as Anthropic.Beta.BetaTool[];
    assert.equal(tools[0].eager_input_streaming, true);
    assert.equal(tools[0].strict, undefined);
    const system = req.system as Anthropic.Beta.BetaTextBlockParam[];
    assert.equal(system[0].cache_control, undefined);
    assert.deepEqual(system[1].cache_control, { type: "ephemeral", ttl: "1h" });
    assert.ok(req.context_management);
  });

  test("parallel tool calls produce one user message holding every result, in order", async () => {
    const calls: unknown[] = [];
    const { factory, requests } = fakeStream([
      message([toolUse("t1", "get_diagnostics", {}), toolUse("t2", "get_diagnostics", { severity: "error" })], "tool_use"),
      message([text("done")], "end_turn", { cache_read_input_tokens: 100 }),
    ]);
    const history: Anthropic.Beta.BetaMessageParam[] = [{ role: "user", content: "hi" }];
    const events: ToolEvent[] = [];
    const result = await runAgentTurn(factory, history, [echoTool(calls)], { onText: () => {}, onTool: (e) => events.push(e) }, options);

    assert.equal(result.text, "done");
    assert.equal(calls.length, 2);
    assert.equal(history.length, 4, "user, assistant(tool_use), user(results), assistant(text)");
    const results = history[2].content as Anthropic.Beta.BetaToolResultBlockParam[];
    assert.equal(history[2].role, "user");
    assert.deepEqual(results.map((r) => r.tool_use_id), ["t1", "t2"]);
    assert.ok(results.every((r) => !r.is_error));
    assert.equal(requests.length, 2);
    assert.deepEqual(result.usage, { input: 20, output: 10, cacheRead: 100, cacheWrite: 0, rounds: 2 });
    assert.deepEqual(events.map((e) => e.status), ["running", "done", "running", "done"]);
  });

  test("invalid tool input becomes an error result and the tool does not run", async () => {
    const calls: unknown[] = [];
    const { factory } = fakeStream([
      message([toolUse("t1", "get_diagnostics", { severity: "loud" })], "tool_use"),
      message([text("ok")], "end_turn"),
    ]);
    const history: Anthropic.Beta.BetaMessageParam[] = [{ role: "user", content: "hi" }];
    await runAgentTurn(factory, history, [echoTool(calls)], { onText: () => {} }, options);
    const results = history[2].content as Anthropic.Beta.BetaToolResultBlockParam[];
    assert.equal(calls.length, 0);
    assert.equal(results[0].is_error, true);
    assert.match(String(results[0].content), /INVALID_INPUT.*severity/);
  });

  test("unknown tools and thrown tool errors are reported as error results, not exceptions", async () => {
    const boom: ToolSpec = { ...echoTool([]), name: "get_map_overview", run: async () => { throw new Error("kaboom"); } };
    const { factory } = fakeStream([
      message([toolUse("t1", "nope", {}), toolUse("t2", "get_map_overview", {})], "tool_use"),
      message([text("ok")], "end_turn"),
    ]);
    const history: Anthropic.Beta.BetaMessageParam[] = [{ role: "user", content: "hi" }];
    await runAgentTurn(factory, history, [boom], { onText: () => {} }, options);
    const results = history[2].content as Anthropic.Beta.BetaToolResultBlockParam[];
    assert.match(String(results[0].content), /Unknown tool: nope/);
    assert.match(String(results[1].content), /Tool failed: kaboom/);
    assert.ok(results.every((r) => r.is_error));
  });

  test("a declined confirmation is an error result", async () => {
    const calls: unknown[] = [];
    const gated: ToolSpec = { ...echoTool(calls), confirm: async () => false };
    const { factory } = fakeStream([message([toolUse("t1", "get_diagnostics", {})], "tool_use"), message([text("ok")], "end_turn")]);
    const history: Anthropic.Beta.BetaMessageParam[] = [{ role: "user", content: "hi" }];
    await runAgentTurn(factory, history, [gated], { onText: () => {} }, options);
    const results = history[2].content as Anthropic.Beta.BetaToolResultBlockParam[];
    assert.equal(calls.length, 0);
    assert.match(String(results[0].content), /declined/);
  });

  test("max_tokens stops the turn without running tools and flags truncation", async () => {
    const calls: unknown[] = [];
    const { factory, requests } = fakeStream([message([text("partial"), toolUse("t1", "get_diagnostics", {})], "max_tokens")]);
    const history: Anthropic.Beta.BetaMessageParam[] = [{ role: "user", content: "hi" }];
    const result = await runAgentTurn(factory, history, [echoTool(calls)], { onText: () => {} }, options);
    assert.equal(result.truncated, true);
    assert.equal(calls.length, 0);
    assert.equal(requests.length, 1);
    assert.equal(history.length, 2);
  });

  test("the round cap answers pending tools with errors and asks for a tool-free wrap-up", async () => {
    const calls: unknown[] = [];
    const script = [
      message([toolUse("a", "get_diagnostics", {})], "tool_use"),
      message([toolUse("b", "get_diagnostics", {})], "tool_use"),
      message([text("summary")], "end_turn"),
    ];
    const { factory, requests } = fakeStream(script);
    const history: Anthropic.Beta.BetaMessageParam[] = [{ role: "user", content: "hi" }];
    const result = await runAgentTurn(factory, history, [echoTool(calls)], { onText: () => {} }, { ...options, maxRounds: 2 });
    assert.equal(result.roundCapHit, true);
    assert.equal(result.text, "summary");
    assert.equal(calls.length, 1, "only the first round's tool ran");
    const last = requests.at(-1)!;
    assert.deepEqual(last.tool_choice, { type: "none" });
    const capped = history[4].content as Anthropic.Beta.BetaToolResultBlockParam[];
    assert.equal(capped[0].is_error, true);
    assert.match(String(capped[0].content), /budget/);
  });

  test("refusals surface as errors", async () => {
    const refusal = { ...message([], "refusal"), stop_details: { type: "refusal", category: "x", explanation: "no thanks" } } as unknown as Message;
    const { factory } = fakeStream([refusal]);
    await assert.rejects(runAgentTurn(factory, [{ role: "user", content: "hi" }], [], { onText: () => {} }, options), /no thanks/);
  });
});
