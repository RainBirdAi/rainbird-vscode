/**
 * Interactive query runner: pick a goal relationship from the open map,
 * drive the engine's question loop through QuickPick/InputBox, and land on a
 * result with certainty — with a jump-off into the evidence tree.
 *
 * This is the Regal "evaluate this rule" affordance translated to Rainbird's
 * interactive Match → Infer → Ask model.
 */
import * as vscode from "vscode";
import { Answer, EngineResponse, Question, RainbirdClient, ResultItem } from "./api";
import { buildIndex } from "./mapIndex";
import { showEvidenceTree } from "./evidenceView";

export async function connect(context: vscode.ExtensionContext): Promise<RainbirdClient | undefined> {
  const config = vscode.workspace.getConfiguration("rainbird");
  let apiUrl = config.get<string>("apiUrl") ?? "https://api.rainbird.ai";

  const pickedEnv = await vscode.window.showQuickPick(
    [
      { label: "Community", description: "https://api.rainbird.ai", url: "https://api.rainbird.ai" },
      { label: "Enterprise", description: "https://enterprise-api.rainbird.ai", url: "https://enterprise-api.rainbird.ai" },
      { label: "Custom / private environment…", url: "" },
    ],
    { title: "Rainbird environment", placeHolder: `Current: ${apiUrl}` }
  );
  if (!pickedEnv) return undefined;
  apiUrl = pickedEnv.url || (await vscode.window.showInputBox({ prompt: "API base URL", value: apiUrl })) || apiUrl;
  await config.update("apiUrl", apiUrl, vscode.ConfigurationTarget.Global);

  const apiKey = await vscode.window.showInputBox({
    prompt: "Rainbird API key (from your Account or the map's Publish page)",
    password: true,
    ignoreFocusOut: true,
  });
  if (!apiKey) return undefined;
  await context.secrets.store(secretKey(apiUrl), apiKey);
  vscode.window.setStatusBarMessage(`Rainbird: connected to ${apiUrl}`, 5000);
  return new RainbirdClient(apiUrl, apiKey);
}

export async function getClient(context: vscode.ExtensionContext): Promise<RainbirdClient | undefined> {
  const apiUrl = vscode.workspace.getConfiguration("rainbird").get<string>("apiUrl") ?? "https://api.rainbird.ai";
  const apiKey = await context.secrets.get(secretKey(apiUrl));
  if (!apiKey) return connect(context);
  return new RainbirdClient(apiUrl, apiKey);
}

/** Like getClient but never prompts — for background consumers (trees, tests). */
export async function getClientSilent(context: vscode.ExtensionContext): Promise<RainbirdClient | undefined> {
  const apiUrl = vscode.workspace.getConfiguration("rainbird").get<string>("apiUrl") ?? "https://api.rainbird.ai";
  const apiKey = await context.secrets.get(secretKey(apiUrl));
  return apiKey ? new RainbirdClient(apiUrl, apiKey) : undefined;
}

function secretKey(apiUrl: string): string {
  return `rainbird.apiKey.${apiUrl}`;
}

/** Evidence is secured by default behind a separate x-evidence-key (Studio → Publish → API Management). */
export async function getEvidenceKey(context: vscode.ExtensionContext): Promise<string | undefined> {
  const apiUrl = vscode.workspace.getConfiguration("rainbird").get<string>("apiUrl") ?? "https://api.rainbird.ai";
  return context.secrets.get(`rainbird.evidenceKey.${apiUrl}`);
}

export async function setEvidenceKey(context: vscode.ExtensionContext): Promise<void> {
  const apiUrl = vscode.workspace.getConfiguration("rainbird").get<string>("apiUrl") ?? "https://api.rainbird.ai";
  const key = await vscode.window.showInputBox({
    prompt: `x-evidence-key for ${apiUrl} (Studio → Publish → API Management → Access Control; leave empty to clear)`,
    password: true,
    ignoreFocusOut: true,
  });
  if (key === undefined) return;
  if (key) await context.secrets.store(`rainbird.evidenceKey.${apiUrl}`, key);
  else await context.secrets.delete(`rainbird.evidenceKey.${apiUrl}`);
  vscode.window.setStatusBarMessage(key ? "Rainbird evidence key stored." : "Rainbird evidence key cleared.", 4000);
}

export async function runQuery(context: vscode.ExtensionContext): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  const client = await getClient(context);
  if (!client) return;

  const config = vscode.workspace.getConfiguration("rainbird", editor?.document.uri);
  let kmId = config.get<string>("knowledgeMapId");
  if (!kmId) {
    kmId = await vscode.window.showInputBox({
      prompt: "Knowledge Map ID (from the Publish page in Studio)",
      ignoreFocusOut: true,
    });
    if (!kmId) return;
    await config.update("knowledgeMapId", kmId, vscode.ConfigurationTarget.Workspace);
  }

  // Goal selection: from the open RBLang document when available, else free text.
  let relationship: string | undefined;
  if (editor?.document.languageId === "rblang") {
    const index = buildIndex(editor.document.getText());
    const picked = await vscode.window.showQuickPick(
      [...index.relationships.entries()].map(([name, rel]) => ({
        label: name,
        description: `${rel.subject} → ${rel.object}${rel.plural ? " (plural)" : ""}`,
      })),
      { title: "Goal relationship to query" }
    );
    relationship = picked?.label;
  } else {
    relationship = await vscode.window.showInputBox({ prompt: "Goal relationship (e.g. \"speaks\")" });
  }
  if (!relationship) return;

  const subject = await vscode.window.showInputBox({
    prompt: `Subject for "${relationship}" (leave empty for a subject query)`,
  });

  try {
    const useDraft = config.get<boolean>("useDraft") ?? true;
    const sessionId = await client.start(kmId, { useDraft });
    let response = await client.query(sessionId, {
      relationship,
      ...(subject ? { subject } : {}),
    });

    // The Ask loop: keep answering until the engine produces a result.
    while (response.kind === "question") {
      const answers = await askUser(response.question);
      if (!answers) {
        vscode.window.showInformationMessage("Rainbird query cancelled.");
        return;
      }
      response = await client.respond(sessionId, answers);
    }

    await presentResult(client, sessionId, response.result, await getEvidenceKey(context));
  } catch (error) {
    vscode.window.showErrorMessage(`Rainbird query failed: ${(error as Error).message}`);
  }
}

async function askUser(question: Question): Promise<Answer[] | undefined> {
  const base = { relationship: question.relationship, subject: question.subject };
  // 'Second Form Subject' asks for the SUBJECT; other forms ask for the object.
  const fill = (value: string | number | boolean): Answer =>
    question.type === "Second Form Subject"
      ? { relationship: question.relationship, subject: String(value), object: question.object, certainty: 100 }
      : { ...base, object: value, certainty: 100 };

  if (question.type === "First Form") {
    const choice = await vscode.window.showQuickPick(["yes", "no", ...(question.allowUnknown ? ["don't know"] : [])], {
      title: question.prompt,
    });
    if (!choice) return undefined;
    if (choice === "don't know") return [{ ...base, object: question.object, unanswered: true }];
    return [{ ...base, object: question.object, answer: choice as "yes" | "no", certainty: 100 }];
  }

  const options = (question.concepts ?? []).map((c) => c.name);
  let value: string | undefined;
  if (options.length > 0) {
    if (question.plural) {
      const picked = await vscode.window.showQuickPick(options, { title: question.prompt, canPickMany: true });
      if (!picked) return undefined;
      return picked.map((v) =>
        fill(question.dataType === "number" ? Number(v) : question.dataType === "truth" ? v === "true" : v)
      );
    }
    value = await vscode.window.showQuickPick(
      question.canAdd !== "none" ? [...options, "$(edit) Other…"] : options,
      { title: question.prompt }
    );
    if (value === "$(edit) Other…") value = await vscode.window.showInputBox({ prompt: question.prompt });
  } else {
    value = await vscode.window.showInputBox({ prompt: `${question.prompt} (${question.dataType})` });
  }
  if (value === undefined) return undefined;
  return [fill(question.dataType === "number" ? Number(value) : question.dataType === "truth" ? value === "true" : value)];
}

async function presentResult(
  client: RainbirdClient,
  sessionId: string,
  results: ResultItem[],
  evidenceKey?: string
): Promise<void> {
  if (results.length === 0) {
    vscode.window.showWarningMessage("Rainbird returned no results for this query.");
    return;
  }
  const items = results.map((r) => ({
    label: `${r.subject} ${r.relationship} ${r.object}`,
    description: `certainty ${r.certainty}%`,
    detail: `factID ${r.factID}`,
    result: r,
  }));
  const picked = await vscode.window.showQuickPick(items, {
    title: `Result (${results.length}) — select one to inspect its evidence tree`,
  });
  if (picked) {
    await showEvidenceTree(client, sessionId, picked.result.factID, evidenceKey);
  }
}
