/**
 * Tools the AI assistant can call: lint a map with the extension's own
 * diagnostics, run a live query against the platform (restarting the session
 * each call, replaying supplied facts/answers), and push a map — the last one
 * gated behind an explicit user confirmation because it creates a real map.
 */
import * as vscode from "vscode";
import { ToolSpec } from "./anthropic";
import { collectIssues } from "./diagnostics";
import { getClientSilent } from "./queryRunner";
import { Answer, ApiError, CreateMapResult, Fact } from "./api";
import { recordKnownMap } from "./mapsTree";
import { showPlatformErrors } from "./platformDiagnostics";

export function buildTools(context: vscode.ExtensionContext): ToolSpec[] {
  return [
    {
      name: "lint_map",
      description:
        "Validate RBLang with the extension's linter (same rules as the editor squiggles). Returns a list of issues with line numbers, or confirms the map is clean. Always lint maps you generate before presenting them.",
      input_schema: {
        type: "object",
        properties: { rblang: { type: "string", description: "Complete RBLang source to validate" } },
        required: ["rblang"],
        additionalProperties: false,
      },
      async run(input) {
        const issues = collectIssues(String(input.rblang ?? ""));
        if (issues.length === 0) return "No issues — the map passes the linter.";
        return JSON.stringify(
          issues.map((i) => ({ line: i.line + 1, severity: i.severity, message: i.message })),
          null,
          2
        );
      },
    },
    {
      name: "run_query",
      description:
        "Run a live query against a Rainbird knowledge map (draft by default; pass `version` to pin a published version). Each call starts a FRESH session, injects `facts`, asks for the goal, then feeds `answers` in order to the questions the engine asks — grouped questions arrive together and take one answer each. If the engine still has unanswered questions, they are returned — call again with answers appended (or ask the user). Returns results with certainty when the query completes.",
      input_schema: {
        type: "object",
        properties: {
          kmId: { type: "string", description: "Knowledge map ID. Omit to use the workspace's configured map." },
          relationship: { type: "string", description: "Goal relationship to query" },
          subject: { type: "string", description: "Optional goal subject" },
          object: { type: "string", description: "Optional goal object (with subject: ask how certain that exact fact is)" },
          version: { type: "number", description: "Published version number to run against instead of the draft" },
          facts: {
            type: "array",
            description: "Facts to inject before querying",
            items: {
              type: "object",
              properties: {
                subject: { type: "string" },
                relationship: { type: "string" },
                object: { type: ["string", "number", "boolean"] },
                certainty: { type: "number" },
              },
              required: ["subject", "relationship", "object"],
              additionalProperties: false,
            },
          },
          answers: {
            type: "array",
            description:
              "Answers fed one per engine question, in order. Echo relationship/subject from the question; set object (and certainty), or unanswered:true to skip.",
            items: {
              type: "object",
              properties: {
                relationship: { type: "string" },
                subject: { type: "string" },
                object: { type: ["string", "number", "boolean"] },
                answer: { type: "string", enum: ["yes", "no"] },
                certainty: { type: "number" },
                unanswered: { type: "boolean" },
              },
              additionalProperties: false,
            },
          },
        },
        required: ["relationship"],
        additionalProperties: false,
      },
      async run(input) {
        const client = await getClientSilent(context);
        if (!client) return "Not connected to Rainbird — tell the user to run “Rainbird: Connect” first.";
        const kmId =
          (input.kmId as string) || vscode.workspace.getConfiguration("rainbird").get<string>("knowledgeMapId");
        if (!kmId) return "No knowledge map ID — pass kmId or tell the user to set rainbird.knowledgeMapId (or push the map first).";

        recordKnownMap(context, { kmId, source: "queried" });
        const version = typeof input.version === "number" ? input.version : undefined;
        const sessionId = await client.start(kmId, version ? { version } : { useDraft: true });
        const facts = (input.facts as Fact[] | undefined) ?? [];
        if (facts.length) await client.inject(sessionId, facts);

        let response = await client.query(sessionId, {
          relationship: String(input.relationship),
          ...(input.subject ? { subject: String(input.subject) } : {}),
          ...(input.object ? { object: String(input.object) } : {}),
        });
        // Grouped questions (question + extraQuestions) must be answered together
        // in one /response call — consume one answer per question in the group.
        const answers = [...((input.answers as Answer[] | undefined) ?? [])];
        while (response.kind === "question") {
          const groupSize = 1 + (response.extraQuestions?.length ?? 0);
          if (answers.length < groupSize) break;
          response = await client.respond(sessionId, answers.splice(0, groupSize));
        }
        if (response.kind === "question") {
          const questions = [response.question, ...(response.extraQuestions ?? [])];
          return JSON.stringify(
            {
              status: "question",
              questions,
              note:
                questions.length > 1
                  ? `These ${questions.length} questions are a group: supply one answer per question, in this order, appended to answers.`
                  : "Append one answer for this question to answers and call again.",
            },
            null,
            2
          );
        }
        return JSON.stringify({ status: "result", results: response.result }, null, 2);
      },
    },
    {
      name: "push_map",
      description:
        "Upload RBLang to the platform as a NEW map (create-only — a fresh kmID every time; the user cleans up old scratch maps in Studio). Requires the user to approve. Name/description must be plain text: letters, numbers and spaces only. Returns the new kmID, which run_query can use immediately.",
      input_schema: {
        type: "object",
        properties: {
          rblang: { type: "string" },
          name: { type: "string", description: "Plain-text map name (letters, numbers, spaces)" },
          description: { type: "string", description: "Plain-text description" },
        },
        required: ["rblang", "name", "description"],
        additionalProperties: false,
      },
      async confirm(input) {
        const apiUrl = vscode.workspace.getConfiguration("rainbird").get<string>("apiUrl");
        const choice = await vscode.window.showWarningMessage(
          `The assistant wants to push "${input.name}" to ${apiUrl} (creates a new map).`,
          { modal: true },
          "Push"
        );
        return choice === "Push";
      },
      async run(input) {
        const client = await getClientSilent(context);
        if (!client) return "Not connected to Rainbird — tell the user to run “Rainbird: Connect” first.";
        let created: CreateMapResult;
        try {
          created = await client.createMap(String(input.rblang), String(input.name), String(input.description));
        } catch (error) {
          const validation = error instanceof ApiError ? error.errMessages() : undefined;
          if (!validation?.length) throw error;
          // If the pushed text is an open document, put the platform's findings on it too.
          const doc = vscode.workspace.textDocuments.find((d) => d.languageId === "rblang" && d.getText() === String(input.rblang));
          if (doc) showPlatformErrors(doc, validation, `Assistant push of "${input.name}" rejected by Rainbird`);
          return `The platform rejected the map with ${validation.length} validation error${validation.length === 1 ? "" : "s"}:\n${validation
            .map((m) => `- ${m}`)
            .join("\n")}\nFix the RBLang and push again.`;
        }
        const { kmId, raw, validation } = created;
        if (!kmId) return `Uploaded, but no kmID found in the response: ${JSON.stringify(raw).slice(0, 400)}`;
        recordKnownMap(context, { kmId, name: String(input.name), source: "pushed", rblang: String(input.rblang) });
        if (validation.length) {
          const doc = vscode.workspace.textDocuments.find((d) => d.languageId === "rblang" && d.getText() === String(input.rblang));
          if (doc) showPlatformErrors(doc, validation, `Assistant push of "${input.name}" (kmID ${kmId}) accepted with validation errors`);
          return `Created map "${input.name}" with kmID ${kmId}, but the platform reported a validation error (it reports one per push):\n${validation
            .map((m) => `- ${m}`)
            .join("\n")}\nThe draft was stored as-is; fix the RBLang before relying on it.`;
        }
        return `Created map "${input.name}" with kmID ${kmId}.`;
      },
    },
  ];
}
