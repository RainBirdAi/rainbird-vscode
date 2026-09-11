/**
 * Anthropic-powered RBLang authoring: key management (SecretStorage) and a
 * streaming chat helper whose system prompt is generated from the same schema
 * table that drives diagnostics and completions — one source of truth for
 * what valid RBLang looks like.
 */
import * as vscode from "vscode";
import Anthropic from "@anthropic-ai/sdk";
import { SCHEMA, EXPRESSION_FUNCTIONS, RBLANG_NAMESPACE } from "./schema";

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

export async function getAnthropicClient(context: vscode.ExtensionContext): Promise<Anthropic | undefined> {
  let key = await context.secrets.get(SECRET_KEY);
  if (!key) key = await setAnthropicKey(context);
  if (!key) return undefined;
  return new Anthropic({ apiKey: key });
}

export function getModel(): string {
  return vscode.workspace.getConfiguration("rainbird").get<string>("ai.model") || DEFAULT_MODEL;
}

/**
 * Stream one assistant turn. Calls onText for each text delta and resolves
 * with the full text. Server-side refusal fallback is enabled so a policy
 * decline transparently re-runs on a fallback model.
 */
export async function streamChat(
  client: Anthropic,
  history: Anthropic.MessageParam[],
  onText: (delta: string) => void,
  signal?: AbortSignal
): Promise<string> {
  const stream = client.beta.messages.stream(
    {
      model: getModel(),
      max_tokens: 32000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      system: [{ type: "text", text: buildSystemPrompt(), cache_control: { type: "ephemeral" } }],
      messages: history as Anthropic.Beta.BetaMessageParam[],
    },
    { signal }
  );
  stream.on("text", onText);
  const final = await stream.finalMessage();
  if (final.stop_reason === "refusal") {
    throw new Error(final.stop_details?.explanation ?? "The model declined this request.");
  }
  return final.content
    .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");
}

/** A tool the assistant can call. `confirm` (if set) gates execution behind user approval. */
export interface ToolSpec {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
  run(input: Record<string, unknown>): Promise<string>;
  confirm?(input: Record<string, unknown>): Promise<boolean>;
}

export interface AgentCallbacks {
  onText(delta: string): void;
  /** Fired when a tool starts running (for status lines in the chat). */
  onTool(name: string, detail: string): void;
}

/**
 * Agentic loop: stream a turn, execute any tool calls, feed results back,
 * repeat until the model stops. Mutates `history` in place (assistant turns
 * with full content blocks + tool_result user turns) so the conversation can
 * continue naturally.
 */
export async function streamAgent(
  client: Anthropic,
  history: Anthropic.Beta.BetaMessageParam[],
  tools: ToolSpec[],
  callbacks: AgentCallbacks,
  signal?: AbortSignal
): Promise<string> {
  const toolDefs: Anthropic.Beta.BetaTool[] = tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.input_schema as Anthropic.Beta.BetaTool["input_schema"],
  }));
  let visibleText = "";

  for (let turn = 0; turn < 12; turn++) {
    const stream = client.beta.messages.stream(
      {
        model: getModel(),
        max_tokens: 32000,
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
        system: [{ type: "text", text: buildSystemPrompt() + TOOL_GUIDANCE, cache_control: { type: "ephemeral" } }],
        tools: toolDefs,
        messages: history,
      },
      { signal }
    );
    stream.on("text", (delta) => {
      visibleText += delta;
      callbacks.onText(delta);
    });
    const final = await stream.finalMessage();
    if (final.stop_reason === "refusal") {
      throw new Error(final.stop_details?.explanation ?? "The model declined this request.");
    }
    history.push({ role: "assistant", content: final.content });

    if (final.stop_reason !== "tool_use") return visibleText;

    const toolUses = final.content.filter(
      (b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use"
    );
    const results: Anthropic.Beta.BetaToolResultBlockParam[] = [];
    for (const use of toolUses) {
      const tool = tools.find((t) => t.name === use.name);
      const input = use.input as Record<string, unknown>;
      let content: string;
      let isError = false;
      if (!tool) {
        content = `Unknown tool: ${use.name}`;
        isError = true;
      } else if (tool.confirm && !(await tool.confirm(input))) {
        content = "The user declined this action.";
        isError = true;
      } else {
        callbacks.onTool(use.name, summariseInput(input));
        try {
          content = await tool.run(input);
        } catch (error) {
          content = `Tool failed: ${(error as Error).message}`;
          isError = true;
        }
      }
      results.push({ type: "tool_result", tool_use_id: use.id, content, is_error: isError });
    }
    history.push({ role: "user", content: results });
  }
  return visibleText;
}

const TOOL_GUIDANCE = `

## Tools

You have tools to lint RBLang, run live queries against the platform, and push maps. Use them proactively: lint every map you generate before presenting it; when the user asks whether logic works, push and query it rather than speculating. run_query returns either results or the engine's next question — supply facts/answers and call again, or ask the user. Report tool outcomes concisely.`;

function summariseInput(input: Record<string, unknown>): string {
  return Object.entries(input)
    .map(([k, v]) => `${k}=${typeof v === "string" ? (v.length > 40 ? v.slice(0, 40) + "…" : v) : JSON.stringify(v)?.slice(0, 40)}`)
    .join(", ");
}

/**
 * The RBLang authoring reference, generated from the extension's own schema
 * table so the assistant can never drift from what the linter accepts.
 */
export function buildSystemPrompt(): string {
  const elements = Object.entries(SCHEMA)
    .map(([name, spec]) => {
      const parts = [`<${name}> — ${spec.doc}`];
      if (spec.required.length) parts.push(`  required: ${spec.required.join(", ")}`);
      if (spec.optional.length) parts.push(`  optional: ${spec.optional.join(", ")}`);
      if (spec.enums) {
        for (const [attr, values] of Object.entries(spec.enums)) {
          parts.push(`  ${attr} ∈ {${values.join(" | ")}}`);
        }
      }
      if (spec.children.length) parts.push(`  children: ${spec.children.join(", ")}`);
      return parts.join("\n");
    })
    .join("\n\n");

  const functions = EXPRESSION_FUNCTIONS.map((f) => `- ${f.signature} — ${f.doc}`).join("\n");

  return `You are the Rainbird authoring assistant inside VSCode. You help users write RBLang — the XML dialect for Rainbird knowledge maps (concepts, relationships, facts and inference rules that power Rainbird's decision-intelligence engine).

## Behaviour

- When the user asks you to create or modify a knowledge map, respond with complete, valid RBLang in a fenced code block tagged \`\`\`rblang. Keep any prose brief and put it outside the code block.
- When asked to explain existing RBLang, explain the reasoning the map encodes (which rules fire when, how certainty flows), not XML trivia.
- When asked to fix problems, return the corrected RBLang and one line per fix explaining what changed.
- The user's active file (when relevant) is included in their message between <active-file> tags. Treat it as the current state of their map.
- Generated maps must start with <?xml version="1.0" encoding="utf-8"?> and use root <rbl:kb xmlns:rbl="${RBLANG_NAMESPACE}">.

## RBLang rules that matter most

- Declare every concept before referencing it in a rel; declare every rel before referencing it in relinst/condition.
- Relationship subjects must be string-typed concepts. Only string concepts can have instances (concinst).
- A relinst with no <condition> children is a fact; with conditions it is a rule. cf (0-100) caps the rule's certainty.
- Rule headers (relinst subject/object) may only use literal instance names, %S or %O — never custom %VARIABLES. Custom variables are bound inside conditions and must appear at least twice across the rule to connect.
- A condition is either a relationship pattern (rel/subject/object) or an expression (expression/value) — never both. Weights distribute certainty; behaviour="mandatory" makes a condition required.
- Expressions evaluate strictly left-to-right (no operator precedence). String literals use single quotes. There is no null test — use countRelationshipInstances(...) is equal to 0.
- Question wording: firstForm asks yes/no when subject+object are known; secondFormObject asks for the object given %S; secondFormSubject asks for the subject given %O. askable controls which forms the engine may ask.
- alt text on rules powers human-readable evidence: {{%S}}, {{%O}} and {{%VAR}} interpolate bindings, {{%VAR.rel}} follows a relationship.

## Element reference

${elements}

## Expression functions (engine v4.118)

${functions}

## Example (the canonical Hello World)

\`\`\`rblang
<?xml version="1.0" encoding="utf-8"?>
<rbl:kb xmlns:rbl="${RBLANG_NAMESPACE}">
  <concept name="Person" type="string"/>
  <concept name="Country" type="string"/>
  <concept name="Language" type="string"/>

  <rel name="speaks" subject="Person" object="Language" plural="true" askable="all">
    <firstForm>Does %S speak %O?</firstForm>
    <secondFormObject>Which languages does %S speak?</secondFormObject>
    <secondFormSubject>Who speaks %O?</secondFormSubject>
  </rel>
  <rel name="lives in" subject="Person" object="Country" askable="all">
    <secondFormObject>Which country does %S live in?</secondFormObject>
  </rel>
  <rel name="national language" subject="Country" object="Language" askable="none"/>

  <concinst name="English" type="Language"/>
  <concinst name="England" type="Country"/>
  <relinst type="national language" subject="England" object="English" cf="100"/>

  <relinst type="speaks" cf="75" name="Speaks national language of home country"
           alt="{{%S}} lives in {{%COUNTRY}}, whose national language is {{%O}}">
    <condition rel="lives in" subject="%S" object="%COUNTRY" weight="100" behaviour="mandatory"/>
    <condition rel="national language" subject="%COUNTRY" object="%O" weight="100" behaviour="mandatory"/>
  </relinst>
</rbl:kb>
\`\`\``;
}
