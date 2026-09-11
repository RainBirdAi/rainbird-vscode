/**
 * Regression tests from real sessions: the query panel can save a finished
 * session (goal + injected facts + answers given + results) as a .rbtest.json
 * file, and the Test Explorer replays those files against the platform —
 * every escalated incident or manual check becomes a permanent regression
 * test. `replay` is the shared engine the promotion diff reuses.
 */
import * as vscode from "vscode";
import { Answer, Fact, Question, RainbirdClient, ResultItem, StartTarget, describeTarget, startOptions } from "./api";
import { getClientSilent } from "./queryRunner";

/** Everything needed to re-run a decision: which map, what to ask, what was told and answered. */
export interface Scenario {
  kmId: string;
  goal: { relationship: string; subject?: string; object?: string };
  /** One batch per /response call — a batch holds every answer of a question group. */
  answers: Answer[][];
  facts?: Fact[];
}

export interface SessionRecord extends Scenario {
  results?: ResultItem[];
  target?: StartTarget;
}

export interface TestFile extends Scenario {
  name: string;
  expected: { subject: string; relationship: string; object: string | number | boolean; certainty: number }[];
  savedAt: string;
  /** Version to run against; legacy files without it run against the draft. */
  target?: StartTarget;
}

export interface ReplayOutcome {
  sessionId: string;
  results?: ResultItem[];
  /** Set when the engine asked something the scenario has no answer for — the question flow changed. */
  pendingQuestion?: Question;
}

const CERTAINTY_TOLERANCE = 2;

/** Start a session on `target`, inject, query, and feed the recorded answer batches until a result or an unrecorded question. */
export async function replay(client: RainbirdClient, scenario: Scenario, target: StartTarget): Promise<ReplayOutcome> {
  const sessionId = await client.start(scenario.kmId, startOptions(target));
  if (scenario.facts?.length) await client.inject(sessionId, scenario.facts);
  let response = await client.query(sessionId, {
    relationship: scenario.goal.relationship,
    ...(scenario.goal.subject ? { subject: scenario.goal.subject } : {}),
    ...(scenario.goal.object ? { object: scenario.goal.object } : {}),
  });
  const batches = [...scenario.answers];
  while (response.kind === "question") {
    const batch = batches.shift();
    if (!batch) return { sessionId, pendingQuestion: response.question };
    // The recorded batch must answer what was actually asked. If this version
    // asks about a different relationship, the flow has diverged — feeding it a
    // stale answer would be accepted as a fact and silently corrupt the run.
    const asked = [response.question, ...(response.extraQuestions ?? [])];
    const given = new Set(batch.map((a) => a.relationship));
    const unanswered = asked.find((q) => !given.has(q.relationship));
    if (unanswered) return { sessionId, pendingQuestion: unanswered };
    response = await client.respond(sessionId, batch);
  }
  return { sessionId, results: response.result };
}

export async function loadTestFile(uri: vscode.Uri): Promise<TestFile> {
  const raw = await vscode.workspace.fs.readFile(uri);
  return JSON.parse(Buffer.from(raw).toString("utf8")) as TestFile;
}

export async function saveSessionAsTest(record: SessionRecord): Promise<void> {
  if (!record.results?.length) {
    vscode.window.showWarningMessage("Nothing to save — the session has no results yet.");
    return;
  }
  const name = await vscode.window.showInputBox({
    prompt: "Test name",
    value: `${record.goal.relationship}${record.goal.subject ? ` of ${record.goal.subject}` : ""}`,
  });
  if (!name) return;

  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) {
    vscode.window.showWarningMessage("Open a folder to save tests into (.rainbird-tests/).");
    return;
  }
  const dir = vscode.Uri.joinPath(folder.uri, ".rainbird-tests");
  await vscode.workspace.fs.createDirectory(dir);
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "test";
  const file = vscode.Uri.joinPath(dir, `${slug}.rbtest.json`);

  const test: TestFile = {
    name,
    kmId: record.kmId,
    goal: record.goal,
    ...(record.target ? { target: record.target } : {}),
    ...(record.facts?.length ? { facts: record.facts } : {}),
    answers: record.answers,
    expected: record.results.map((r) => ({
      subject: r.subject,
      relationship: r.relationship,
      object: r.object,
      certainty: r.certainty,
    })),
    savedAt: new Date().toISOString(),
  };
  await vscode.workspace.fs.writeFile(file, Buffer.from(JSON.stringify(test, null, 2), "utf8"));

  const open = await vscode.window.showInformationMessage(
    `Saved test "${name}" — run it from the Testing view after every edit.`,
    "Open Testing view"
  );
  if (open) await vscode.commands.executeCommand("workbench.view.testing.focus");
}

export function registerTests(context: vscode.ExtensionContext): void {
  const controller = vscode.tests.createTestController("rainbirdTests", "Rainbird");
  context.subscriptions.push(controller);

  const addItem = async (uri: vscode.Uri) => {
    try {
      const parsed = await loadTestFile(uri);
      const item = controller.createTestItem(uri.toString(), parsed.name || uri.path.split("/").pop()!, uri);
      item.description = `${parsed.goal.relationship} · ${describeTarget(parsed.target)}`;
      controller.items.add(item);
    } catch {
      controller.items.delete(uri.toString());
    }
  };

  const discover = async () => {
    const files = await vscode.workspace.findFiles("**/*.rbtest.json", "**/node_modules/**");
    for (const file of files) await addItem(file);
  };
  void discover();

  const watcher = vscode.workspace.createFileSystemWatcher("**/*.rbtest.json");
  context.subscriptions.push(
    watcher,
    watcher.onDidCreate(addItem),
    watcher.onDidChange(addItem),
    watcher.onDidDelete((uri) => controller.items.delete(uri.toString()))
  );

  controller.createRunProfile("Run", vscode.TestRunProfileKind.Run, async (request, token) => {
    const run = controller.createTestRun(request);
    const queue: vscode.TestItem[] = [];
    if (request.include) request.include.forEach((i) => queue.push(i));
    else controller.items.forEach((i) => queue.push(i));

    const client = await getClientSilent(context);
    for (const item of queue) {
      if (token.isCancellationRequested) break;
      if (!client) {
        run.errored(item, new vscode.TestMessage("Not connected — run “Rainbird: Connect” first."));
        continue;
      }
      run.started(item);
      const started = Date.now();
      try {
        const test = await loadTestFile(item.uri!);
        const outcome = await replay(client, test, test.target ?? { kind: "draft" });
        if (outcome.pendingQuestion) {
          throw new Error(
            `Engine asked an unrecorded question: "${outcome.pendingQuestion.prompt}" — the map's question flow changed.`
          );
        }

        const actual = outcome.results ?? [];
        const failures: string[] = [];
        for (const expected of test.expected) {
          const match = actual.find(
            (a) =>
              a.subject === expected.subject &&
              a.relationship === expected.relationship &&
              String(a.object) === String(expected.object)
          );
          if (!match) {
            failures.push(`Missing: ${expected.subject} ${expected.relationship} ${expected.object}`);
          } else if (Math.abs(match.certainty - expected.certainty) > CERTAINTY_TOLERANCE) {
            failures.push(
              `Certainty drift: ${expected.subject} ${expected.relationship} ${expected.object} — expected ${expected.certainty}%, got ${match.certainty}%`
            );
          }
        }
        if (actual.length !== test.expected.length) {
          failures.push(`Result count: expected ${test.expected.length}, got ${actual.length}`);
        }

        if (failures.length) {
          run.failed(item, new vscode.TestMessage(failures.join("\n")), Date.now() - started);
        } else {
          run.passed(item, Date.now() - started);
        }
      } catch (error) {
        run.errored(item, new vscode.TestMessage((error as Error).message), Date.now() - started);
      }
    }
    run.end();
  });
}
