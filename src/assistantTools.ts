/**
 * The assistant's tools. Read tools (overview, ranges, diagnostics) and the
 * edit tool operate on the session's target document through its EditApplier;
 * platform tools run live queries, push maps (confirm-gated: it creates a real
 * map), compare versions, replay regression tests and fetch evidence. Tool
 * bodies delegate to the pure modules so the logic stays unit-testable.
 */
import * as vscode from "vscode";
import type { ToolSpec } from "./anthropic";
import { TOOL_SCHEMAS, STRICT_TOOLS, toApiSchema } from "./toolSchemas";
import type { AssistantSession } from "./assistantSession";
import { collectIssues } from "./lint";
import { buildIndex } from "./mapIndex";
import { buildOverview, readRange, formatDiagnostics, lineAt, summariseIssues } from "./mapOverview";
import { applyOperations, describeEdit, lintSnippet, resolveSelector, Operation, Selector, EditError } from "./mapEdits";
import { getClientSilent, getEvidenceKey } from "./queryRunner";
import { Answer, ApiError, CreateMapResult, describeTarget, Fact, RainbirdClient } from "./api";
import { recordKnownMap, snapshotUri } from "./mapsTree";
import { showPlatformErrors } from "./platformDiagnostics";
import { gitHeadSide } from "./semanticDiff";
import { buildModel, diffReportDetailed } from "./semanticModel";
import { loadTestFile, replay, TestFile } from "./tests";
import type { EngineResponse } from "./api";
import { readDateOrder } from "./answers";
import { answerQuestions, pendingQuestionMessage, queryToolReply, QuestionSession, readAutoSkipMode } from "./questionSkip";
import { describeEvidence } from "./evidenceRender";
import type { ExpandedEvidence } from "./evidenceModel";

const NO_MAP = "No RBLang file is open. Ask the user to open a .rbl file, or use create_map to start one.";
const NOT_CONNECTED = "Not connected to Rainbird — ask the user to run “Rainbird: Connect” (environment + API key) first.";

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;

function tool(name: string, description: string, run: ToolSpec["run"], extra: Partial<ToolSpec> = {}): ToolSpec {
  return {
    name,
    description,
    input_schema: toApiSchema(TOOL_SCHEMAS[name]),
    strict: STRICT_TOOLS.has(name),
    run,
    ...extra,
  };
}

export function buildTools(session: AssistantSession): ToolSpec[] {
  const context = session.context;
  const apiUrl = () => vscode.workspace.getConfiguration("rainbird").get<string>("apiUrl");

  const requireText = (): { text: string; fileName: string } => {
    const text = session.currentText();
    if (text === undefined) throw new Error(NO_MAP);
    return { text, fileName: session.fileName() ?? "map" };
  };

  const resolveKm = (explicit?: string) => explicit || session.kmInfo().kmId;

  return [
    tool(
      "get_map_overview",
      "Structured summary of the open RBLang map: concepts (type, instances), relationships (subject → object, askable, plural, fact and rule counts), facts, rules (name, cf, conditions, line range), imports, diagnostics counts and platform state. Cheap — call it before answering questions about a map that was not inlined, and before editing.",
      async () => {
        const { text, fileName } = requireText();
        const client = await getClientSilent(context);
        const km = session.kmInfo();
        return buildOverview(text, { fileName, kmId: km.kmId, kmIdSource: km.source, apiUrl: client ? apiUrl() : undefined });
      },
      { label: () => "Reading map overview" }
    ),

    tool(
      "read_map",
      "Read the open map as numbered lines: a line range (start_line/end_line, up to 300 lines per call) or one element by selector (a named rule, a relationship, a concept, a fact by rel+subject+object). Use it to see exact text before replace_element or replace_text.",
      async (input) => {
        const { text } = requireText();
        if (input.element) {
          const el = resolveSelector(text, buildIndex(text), input.element as Selector);
          const from = Math.max(1, lineAt(text, el.start) - 1);
          const to = lineAt(text, el.end) + 1;
          return readRange(text, from, to);
        }
        return readRange(text, (input.start_line as number | undefined) ?? 1, input.end_line as number | undefined);
      },
      {
        label: (input) =>
          input.element ? `Reading ${(input.element as Selector).kind ?? "element"} ${(input.element as Selector).name ?? (input.element as Selector).rel ?? ""}`.trim() : `Reading lines ${input.start_line ?? 1}–${input.end_line ?? "end"}`,
      }
    ),

    tool(
      "get_diagnostics",
      "Current linter findings for the open map (the same ones shown as squiggles), grouped by severity with line numbers and available quick-fix titles.",
      async (input) => {
        const { text } = requireText();
        return formatDiagnostics(collectIssues(text), (input.severity as "error" | "warning" | "all" | undefined) ?? "all");
      },
      { label: () => "Checking diagnostics" }
    ),

    tool(
      "edit_map",
      [
        "Change the open map with a batch of operations applied in order and atomically (if any fails, nothing is applied). Operations:",
        "insert_element {kind, xml, after?} — adds one or more complete elements of that kind (concept | rel | concinst | fact | rule); placed in the correct section (concepts → relationships → instances → facts → rules, grouped with related elements) and re-indented to the file's style, or right after the `after` selector.",
        "replace_element {selector, xml} — replaces a whole element (top-level, or a nested condition/question form selected by line).",
        "delete_element {selector} — removes an element and its line(s).",
        "set_attribute {selector, attr, value} — changes, adds or (value=null) removes one attribute; validated against the schema.",
        "replace_text {old_text, new_text} — exact text replacement; old_text must occur exactly once. Use only when element operations cannot express the change.",
        "Selectors: {kind, name} for concepts/rels/instances/rules; {kind:'fact', rel, subject, object} for facts; {line} for anything on a line (including conditions). Returns what changed, the diagnostics delta (new / fixed), model-level changes and the changed region. Fix any errors you introduce with a follow-up call.",
      ].join(" "),
      async (input) => {
        const { text, fileName } = requireText();
        const applier = session.applier()!;
        const ops = input.operations as Operation[];
        let outcome;
        try {
          outcome = applyOperations(text, ops);
        } catch (error) {
          if (error instanceof EditError) throw new Error(error.message);
          throw error;
        }
        await applier.apply(outcome.text, `edit_map (${plural(ops.length, "operation")})`);
        return describeEdit(fileName, text, outcome, collectIssues(text), collectIssues(outcome.text));
      },
      { label: (input) => `Editing map: ${plural(((input.operations as unknown[]) ?? []).length, "operation")}` }
    ),

    tool(
      "create_map",
      "Create a new RBLang document from a complete map and make it the assistant's target. With file_name (e.g. eligibility.rbl) the file is created in the workspace folder; without it an untitled document opens. Fails if a non-empty map is already open — edit that one, or pass file_name to create a second file.",
      async (input) => {
        const xml = String(input.xml ?? "");
        const existing = session.target();
        const fileName = input.file_name ? String(input.file_name).replace(/\.(rblang|xml)?$/, "").replace(/\.rbl$/, "") + ".rbl" : undefined;
        if (existing && existing.getText().trim() && !fileName) {
          throw new Error(`${session.fileName()} is already open and not empty. Use edit_map to change it, or pass file_name to create a separate file.`);
        }
        let doc: vscode.TextDocument;
        const folder = vscode.workspace.workspaceFolders?.[0];
        if (fileName && folder) {
          const uri = vscode.Uri.joinPath(folder.uri, fileName);
          try {
            await vscode.workspace.fs.stat(uri);
            throw new Error(`${fileName} already exists in the workspace. Choose another file_name or edit the existing file.`);
          } catch (error) {
            if ((error as Error).message.includes("already exists")) throw error;
          }
          const edit = new vscode.WorkspaceEdit();
          edit.createFile(uri, { ignoreIfExists: false });
          edit.insert(uri, new vscode.Position(0, 0), xml.endsWith("\n") ? xml : xml + "\n");
          if (!(await vscode.workspace.applyEdit(edit))) throw new Error("VS Code could not create the file.");
          doc = await vscode.workspace.openTextDocument(uri);
          await doc.save();
        } else if (existing && !existing.getText().trim()) {
          doc = existing;
          const edit = new vscode.WorkspaceEdit();
          edit.insert(doc.uri, new vscode.Position(0, 0), xml);
          await vscode.workspace.applyEdit(edit);
        } else {
          doc = await vscode.workspace.openTextDocument({ language: "rblang", content: xml });
        }
        await vscode.window.showTextDocument(doc, { preview: false, preserveFocus: true });
        session.adoptTarget(doc);
        const issues = collectIssues(doc.getText());
        const errors = issues.filter((i) => i.severity === "error");
        return `Created ${session.fileName()} (${doc.lineCount} lines). Lint: ${summariseIssues(issues)}.${errors.length ? `\n${formatDiagnostics(issues, "error")}` : ""}${doc.isUntitled ? "\nThe document is untitled — the user should save it (Cmd/Ctrl+S) to keep it." : ""}`;
      },
      { label: (input) => `Creating map${input.file_name ? ` ${input.file_name}` : ""}` }
    ),

    tool(
      "lint_rblang",
      "Check RBLang before proposing it. mode 'map' lints a complete document; mode 'snippet' lints one or more elements in the context of the open map (so relationships and concepts declared there resolve) and reports only findings inside the snippet, with snippet-relative line numbers.",
      async (input) => {
        const rblang = String(input.rblang ?? "");
        const issues = input.mode === "snippet" ? lintSnippet(rblang, session.currentText()) : collectIssues(rblang);
        if (!issues.length) return "No issues — passes the linter.";
        return formatDiagnostics(issues);
      },
      { label: (input) => `Linting ${input.mode === "snippet" ? "snippet" : "map"}` }
    ),

    tool(
      "run_query",
      [
        "Run a live query against a Rainbird knowledge map on the platform (the draft by default; `version` pins a published version). Without sessionId each call starts a fresh session, injects `facts`, queries `relationship` with a subject, an object or both and answers the engine's questions with `answers`, matched to each question by relationship (and subject/object) — a question group is sent in one response, a plural question takes one entry per value.",
        "Answers are checked before sending: dates as YYYY-MM-DD (an ambiguous date such as 01/10/1981 is refused), numbers as numbers, truth questions true/false; problems come back under `rejected` without reaching the engine.",
        "If questions remain they are returned with the sessionId and, per question, `expected` (the value format), de-duplicated `options`, `alreadyKnown` (facts the engine already holds) and `canSkip` with a `skipHint` — call again with that sessionId and answers for the whole group, or ask the user.",
        "`unanswered: true` is accepted only when a question has allowUnknown or known answers; with known answers it means \"no more\" and keeps them. Plural questions are asked even when facts were injected: the tool answers \"no more\" itself when the injected facts cover the question (setting rainbird.query.autoSkipPluralQuestions) unless you supplied an answer for it, and lists those in `autoSkipped`.",
        "Returns results with certainty and fact IDs (usable with get_evidence). Needs a kmID: the map this file is bound to (opened, pulled, pushed or bound by Knowledge Map ID), the rainbird.knowledgeMapId setting, or `kmId`.",
      ].join(" "),
      async (input) => {
        const client = await getClientSilent(context);
        if (!client) return NOT_CONNECTED;
        const kmId = resolveKm(input.kmId as string | undefined);
        if (!kmId) return "No knowledge map ID — pass kmId, push the map first (push_map), or ask the user to run “Rainbird: Open Map by Knowledge Map ID…” or “Rainbird: Bind Open File to a Knowledge Map ID…”.";
        const queue = [...((input.answers as Answer[] | undefined) ?? [])];
        const settings = vscode.workspace.getConfiguration("rainbird");
        const autoSkipMode = readAutoSkipMode(settings.get("query.autoSkipPluralQuestions"));
        const dateOrder = readDateOrder(settings.get("query.dateOrder"));
        let sessionId = input.sessionId as string | undefined;
        let session: QuestionSession;
        let response: EngineResponse;
        if (sessionId) {
          if (!queue.length) return "sessionId given but no answers — append answers for the pending question(s).";
          const known = querySessions.get(sessionId);
          if (known && !known.pending.length) return "This session has no pending question — its query has finished. Start a new query (omit sessionId).";
          if (known) {
            session = known;
            response = { kind: "question", question: known.pending[0], extraQuestions: known.pending.slice(1) };
          } else {
            // A session this tool did not start (or one from before a reload): there are
            // no pending questions to check the answers against, so they go as given.
            response = await client.respond(sessionId, queue.splice(0, queue.length));
            session = rememberQuerySession(sessionId, []);
          }
        } else {
          // Verified live: /query with neither answers 400 "Please provide a string or numeric subject." (and object).
          if (!input.subject && !input.object) return "Give a subject, an object or both: the engine rejects a query with neither.";
          const version = typeof input.version === "number" ? input.version : undefined;
          sessionId = await client.start(kmId, version ? { version } : { useDraft: true });
          // Listed under Maps only once the engine accepted the ID (an unknown one fails at /start).
          recordKnownMap(context, { kmId, source: "queried" });
          const facts = (input.facts as Fact[] | undefined) ?? [];
          if (facts.length) await client.inject(sessionId, facts);
          session = rememberQuerySession(sessionId, facts);
          response = await client.query(sessionId, {
            relationship: String(input.relationship),
            ...(input.subject ? { subject: String(input.subject) } : {}),
            ...(input.object ? { object: String(input.object) } : {}),
          });
        }
        const outcome = await answerQuestions(client, sessionId, response, queue, session, { mode: autoSkipMode, dateOrder });
        return queryToolReply(outcome, { sessionId, kmId });
      },
      { label: (input) => `Running query: ${input.relationship}${input.sessionId ? " (continuing)" : ""}` }
    ),

    tool(
      "push_map",
      "Upload RBLang to the platform as a NEW map (create-only — a fresh kmID every time; the user cleans up old scratch maps in Studio). Omit `rblang` to push the open map as it stands. Requires the user's approval. Name/description must be plain text: letters, numbers and spaces. Returns the new kmID, which run_query uses automatically for this file from then on.",
      async (input) => {
        const client = await getClientSilent(context);
        if (!client) return NOT_CONNECTED;
        const doc = session.target();
        const rblang = input.rblang ? String(input.rblang) : doc?.getText();
        if (!rblang) throw new Error(NO_MAP);
        const name = String(input.name);
        let created: CreateMapResult;
        try {
          created = await client.createMap(rblang, name, String(input.description));
        } catch (error) {
          const validation = error instanceof ApiError ? error.errMessages() : undefined;
          if (!validation?.length) throw error;
          if (doc && doc.getText() === rblang) showPlatformErrors(doc, validation, `Assistant push of "${name}" rejected by Rainbird`);
          return `The platform rejected the map with ${plural(validation.length, "validation error")}:\n${validation.map((m) => `- ${m}`).join("\n")}\nFix the RBLang and push again.`;
        }
        const { kmId, raw, validation } = created;
        if (!kmId) return `Uploaded, but no kmID found in the response: ${JSON.stringify(raw).slice(0, 400)}`;
        recordKnownMap(context, { kmId, name, source: "pushed", rblang, ...(doc?.uri.scheme === "file" ? { file: doc.uri.fsPath } : {}) });
        if (doc && doc.getText() === rblang) await context.workspaceState.update(`rainbird.pushedKm.${doc.uri.toString()}`, kmId);
        if (validation.length) {
          if (doc && doc.getText() === rblang) showPlatformErrors(doc, validation, `Assistant push of "${name}" (kmID ${kmId}) accepted with validation errors`);
          return `Created map "${name}" with kmID ${kmId}, but the platform reported a validation error (it reports one per push):\n${validation.map((m) => `- ${m}`).join("\n")}\nThe draft was stored as-is; fix the RBLang before relying on it.`;
        }
        return `Created map "${name}" with kmID ${kmId}. run_query will use it for this file.`;
      },
      {
        async confirm(input) {
          const choice = await vscode.window.showWarningMessage(
            `The assistant wants to push "${input.name}" to ${apiUrl()} (creates a new map).`,
            { modal: true },
            "Push"
          );
          return choice === "Push";
        },
        label: (input) => `Pushing map "${input.name}"`,
      }
    ),

    tool(
      "semantic_diff",
      "Model-level differences (concepts, relationships, instances, facts, rules — not XML line noise) between the open map and a base: 'turn-start' (as it was when this turn began), 'git-head' (last commit), 'pushed-snapshot' (the last pulled or pushed snapshot of the platform map this file is bound to) or 'text' (an RBLang document you pass).",
      async (input) => {
        const { text, fileName } = requireText();
        const doc = session.target()!;
        let base: { label: string; text: string } | undefined;
        switch (input.against) {
          case "turn-start":
            base = session.turnBefore !== undefined ? { label: "start of this turn", text: session.turnBefore } : undefined;
            if (!base) return "No turn-start snapshot yet.";
            break;
          case "git-head": {
            const side = await gitHeadSide(doc);
            if (!side) return "This file has no git HEAD version (not in a repository, or not committed yet).";
            base = { label: "git HEAD", text: side.text };
            break;
          }
          case "pushed-snapshot": {
            const kmId = context.workspaceState.get<string>(`rainbird.pushedKm.${doc.uri.toString()}`);
            if (!kmId) {
              return "This file is not bound to a platform map (it was not opened by Knowledge Map ID, pulled, pushed or bound in this workspace), so there is no last pulled or pushed snapshot.";
            }
            // Same rule as quick diff (platform.ts fileKmVersion): a copy of a saved version has no snapshot of its own.
            const pulled = context.workspaceState.get<{ kmId?: string; version?: number }>(`rainbird.pulledVersion.${doc.uri.toString()}`);
            if (typeof pulled?.version === "number" && pulled.kmId?.toLowerCase() === kmId.toLowerCase()) {
              return `This file is a copy of version ${pulled.version} of ${kmId}. The last pulled or pushed snapshot records the draft, so it is not this file's starting point; compare against 'text' (e.g. RBLang the user pastes) instead.`;
            }
            let raw: Uint8Array;
            try {
              raw = await vscode.workspace.fs.readFile(snapshotUri(context, kmId));
            } catch {
              return `There is no last pulled or pushed snapshot of ${kmId} yet: one is recorded when its draft is pulled into a file or the map is pushed from VS Code.`;
            }
            base = { label: `last pulled or pushed snapshot (kmID ${kmId})`, text: Buffer.from(raw).toString("utf8") };
            break;
          }
          case "text":
            if (!input.text) return "against=text requires `text`.";
            base = { label: "given text", text: String(input.text) };
            break;
          default:
            return `Unknown base "${input.against}".`;
        }
        const report = diffReportDetailed(buildModel(base.text), buildModel(text), base.label, fileName);
        return report.changes === 0 ? `No model-level changes between ${base.label} and ${fileName}.` : report.markdown;
      },
      { label: (input) => `Comparing with ${input.against}` }
    ),

    tool(
      "run_tests",
      "Replay the workspace's recorded regression tests (.rbtest.json files saved from the query panel) against the platform and report pass/fail per test, with certainty drift and missing results. Optional glob `pattern` narrows the set.",
      async (input) => {
        const client = await getClientSilent(context);
        if (!client) return NOT_CONNECTED;
        const files = await vscode.workspace.findFiles(String(input.pattern ?? "**/*.rbtest.json"), "**/node_modules/**", 50);
        if (!files.length) return "No .rbtest.json files found in the workspace. Tests are saved from the query panel after a run.";
        const lines: string[] = [];
        let passed = 0;
        for (const uri of files) {
          const test = await loadTestFile(uri);
          const failures = await runTest(client, test);
          if (!failures.length) passed++;
          lines.push(`${failures.length ? "FAIL" : "PASS"} ${test.name} (${uri.path.split("/").pop()}, ${describeTarget(test.target)})${failures.length ? `\n${failures.map((f) => `    - ${f}`).join("\n")}` : ""}`);
        }
        return `${passed}/${files.length} passed.\n${lines.join("\n")}`;
      },
      { label: () => "Running regression tests" }
    ),

    tool(
      "get_evidence",
      "The evidence tree for a fact inferred in a query session, as an indented outline: the fact with its certainty and source (rule, answer, injected, datasource, knowledge map), then the rule's conditions in the order the engine reports them, each with the fact that satisfied it, its impact against the maximum possible impact and its weight, plus evidence text. List-function conditions include the function result and every contributing fact; unmet optional and zero-salience conditions are marked; the outline ends with the inputs used by the result. Use the sessionId and a factID from a run_query result.",
      async (input) => {
        const client = await getClientSilent(context);
        if (!client) return NOT_CONNECTED;
        try {
          const tree = await client.fullEvidence(String(input.factId), String(input.sessionId), await getEvidenceKey(context));
          return renderEvidence(tree);
        } catch (error) {
          if (error instanceof ApiError && (error.status === 401 || error.status === 403)) {
            throw new Error(
              "Evidence is locked for this map. Ask the user to enable Evidence Tree Link in Studio (Publish → API Management → Access Control) or to run “Rainbird: Set Evidence Key”, then try again."
            );
          }
          throw error;
        }
      },
      { label: () => "Fetching evidence" }
    ),
  ];
}

/** Sessions run_query started, by sessionId, oldest first (process lifetime), so a later call can continue one. */
const querySessions = new Map<string, QuestionSession>();

function rememberQuerySession(sessionId: string, facts: Fact[]): QuestionSession {
  const session: QuestionSession = { facts, noAutoSkip: new Set(), pending: [] };
  querySessions.set(sessionId, session);
  // Sessions are continued within one conversation; keep only the most recent ones.
  while (querySessions.size > 50) querySessions.delete(querySessions.keys().next().value as string);
  return session;
}

async function runTest(client: RainbirdClient, test: TestFile): Promise<string[]> {
  const outcome = await replay(client, test, test.target ?? { kind: "draft" });
  if (outcome.pendingQuestion) return [pendingQuestionMessage(outcome.pendingQuestion)];
  const actual = outcome.results ?? [];
  const failures: string[] = [];
  for (const expected of test.expected) {
    const match = actual.find((a) => a.subject === expected.subject && a.relationship === expected.relationship && String(a.object) === String(expected.object));
    if (!match) failures.push(`Missing: ${expected.subject} ${expected.relationship} ${expected.object}`);
    else if (Math.abs(match.certainty - expected.certainty) > 2) failures.push(`Certainty drift: ${expected.subject} ${expected.relationship} ${expected.object} — expected ${expected.certainty}%, got ${match.certainty}%`);
  }
  if (actual.length !== test.expected.length) failures.push(`Result count: expected ${test.expected.length}, got ${actual.length}`);
  return failures;
}

/** The evidence tree as the outline the model reads (shared with other callers via describeEvidence). */
function renderEvidence(tree: ExpandedEvidence): string {
  return describeEvidence(tree, { maxChars: 30000 });
}
