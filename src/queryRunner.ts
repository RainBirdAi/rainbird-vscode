/**
 * Interactive query runner: pick a goal relationship from the open map,
 * drive the engine's question loop through QuickPick/InputBox, and land on a
 * result with certainty — with a jump-off into the evidence tree.
 *
 * This is the Regal "evaluate this rule" affordance translated to Rainbird's
 * interactive Match → Infer → Ask model.
 */
import * as vscode from "vscode";
import { ApiError } from "./api";
import { answerFor, canAddHere, coerceAnswer, controlKind, describeDate, formatValue, groupRejectionNote, HINTS, optionsFor, readDateOrder, rejectionNote } from "./answers";
import { canSkip, knownEntries, questionKey, skipAnswer, skipLabel, skipRejectedNote, skipTitle } from "./questionSkip";
import { Answer, Question, RainbirdClient, ResultItem } from "./api";
import { buildIndex } from "./mapIndex";
import { showEvidenceTree } from "./evidenceView";
// platform.ts imports getClient from here: the cycle is safe while every use on either side stays inside a function.
import { activeRblangUri, resolveKmIdFor } from "./platform";
import { Goal, goalsFromIndex, goalsFromMap } from "./goals";
import { canonicalGoal } from "./goalFilter";
import { relationshipAt } from "./authoringModel";
import { panelGoals } from "./queryWebview/setup";

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

  // One kmID precedence (O-2): the file's binding, then its folder's setting,
  // then a prompt whose answer is remembered for the folder.
  const kmId = await resolveKmIdFor(context, { uri: editor?.document.uri, prompt: true, title: "Run Query: which map?" });
  if (!kmId) return;
  const config = vscode.workspace.getConfiguration("rainbird", editor?.document.uri);

  // Goal selection (G-4): the open map's relationships, searchable by name,
  // "subject → object" and rule/fact counts, the one under the cursor first;
  // else free text.
  let relationship: string | undefined;
  // The text of the map the goal came from: the goal's object type formats the results (a date reads 1981-10-01).
  let mapText: string | undefined;
  const rbl = editor?.document.languageId === "rblang" ? editor : undefined;
  const index = rbl ? buildIndex(rbl.document.getText()) : undefined;
  const goals = index ? goalsFromIndex(index).goals : [];
  if (rbl && index && goals.length) {
    mapText = rbl.document.getText();
    const atCursor = relationshipAt(index, rbl.document.offsetAt(rbl.selection.active));
    const cursorName = atCursor && (canonicalGoal(goals, atCursor) ?? atCursor);
    const first = goals.find((g) => g.name === cursorName);
    const ordered = first ? [first, ...goals.filter((g) => g !== first)] : goals;
    const picked = await vscode.window.showQuickPick(
      ordered.map((g) => ({
        label: g.name,
        description: `${g.subject} → ${g.object}${g.plural ? " · plural" : ""}`,
        detail: `${g.rules} rule${g.rules === 1 ? "" : "s"} · ${g.facts} fact${g.facts === 1 ? "" : "s"}`,
      })),
      {
        title: "Goal relationship to query",
        placeHolder: "Type to search by name, subject or object",
        matchOnDescription: true,
        matchOnDetail: true,
      }
    );
    relationship = picked?.label;
  } else {
    const typed = (await vscode.window.showInputBox({ prompt: "Goal relationship (e.g. \"speaks\")" }))?.trim();
    if (!typed) return;
    // Names are case-sensitive (a mismatch is a bare 400): with a map open, send its declared spelling.
    let declared: Goal[] = [];
    const open = activeRblangUri();
    if (open) {
      try {
        mapText = (await vscode.workspace.openTextDocument(open)).getText();
        declared = goalsFromMap(mapText).goals;
      } catch {
        // Not readable: send the name as typed.
      }
    }
    relationship = canonicalGoal(declared, typed) ?? typed;
  }
  if (!relationship) return;
  // Without a map (or for a name it does not declare) the results show the values as the engine sends them.
  const objectType = mapText === undefined ? undefined : panelGoals(mapText).goals.find((g) => g.name === relationship)?.objectType;

  // The engine needs a subject, an object or both (verified live: a query with neither is a 400).
  const subjectText = await vscode.window.showInputBox({
    prompt: `Subject for "${relationship}", e.g. Fred — leave empty to give the object instead`,
  });
  if (subjectText === undefined) return; // Escape cancels the query
  const subject = subjectText.trim();
  let object: string | undefined;
  if (!subject) {
    object = (
      await vscode.window.showInputBox({
        prompt: `Object for "${relationship}", e.g. French — the engine needs a subject or an object`,
      })
    )?.trim();
    if (!object) {
      vscode.window.showWarningMessage("Rainbird needs a subject or an object to run a query.");
      return;
    }
  }

  try {
    const useDraft = config.get<boolean>("useDraft") ?? true;
    const sessionId = await client.start(kmId, { useDraft });
    let response = await client.query(sessionId, {
      relationship,
      ...(subject ? { subject } : {}),
      ...(object ? { object } : {}),
    });

    // The Ask loop: answer every question of a group (question + extraQuestions)
    // and send them in ONE /response call, until the engine produces a result.
    // questionKey()s whose skip the engine refused: not offered again, or the
    // user could walk straight back into the same refusal.
    const refusedSkips = new Set<string>();
    while (response.kind === "question") {
      const group = [response.question, ...(response.extraQuestions ?? [])];
      const answers = await askGroup(group, refusedSkips);
      if (!answers) {
        vscode.window.showInformationMessage("Rainbird query cancelled.");
        return;
      }
      try {
        response = await client.respond(sessionId, answers);
      } catch (error) {
        // A rejected batch leaves the session on the same question: say why and ask again.
        if (!(error instanceof ApiError && error.status === 400)) throw error;
        for (const a of answers) if (a.unanswered) refusedSkips.add(questionKey(a));
        void vscode.window.showWarningMessage(rejectedBatchNote(error, group, answers));
      }
    }

    await presentResult(client, sessionId, response.result, () => getEvidenceKey(context), objectType);
  } catch (error) {
    vscode.window.showErrorMessage(`Rainbird query failed: ${(error as Error).message}`);
  }
}

/** One row of a question's Quick Pick: answer `value`, type a value, or skip. */
interface Choice extends vscode.QuickPickItem {
  action: "value" | "type" | "skip";
  value?: string | number | boolean;
}

/** Ask every question of a group in turn, for one /response call; undefined as soon as the user cancels a step. */
async function askGroup(group: Question[], refusedSkips: Set<string>): Promise<Answer[] | undefined> {
  const answers: Answer[] = [];
  for (const [i, question] of group.entries()) {
    const title = group.length > 1 ? `${question.prompt} (${i + 1} of ${group.length})` : question.prompt;
    const given = await askUser(question, title, !refusedSkips.has(questionKey(question)));
    if (!given) return undefined;
    answers.push(...given);
  }
  return answers;
}

/**
 * Ask one question with the control its kind needs (see controlKind): a fixed
 * Yes/No or True/False pick; de-duplicated options, with "Other…" only where
 * the map lets the user add a value; a validated input box for numbers and
 * dates, whose known values are suggestions, never a closed list. What the
 * engine already knows is shown in the placeholder, and a skip row (labelled
 * by skipLabel) appears only when the engine accepts a skip — and not again
 * once it refused one for this question (`skippable` false).
 */
async function askUser(question: Question, title: string, skippable: boolean): Promise<Answer[] | undefined> {
  const kind = controlKind(question);
  const known = knownEntries(question);
  const knownLine = known.length ? `Already known: ${known.map((k) => k.label).join(", ")}` : "";
  const skip: Choice | undefined =
    skippable && canSkip(question) ? { label: skipLabel(question), detail: skipTitle(question), action: "skip" } : undefined;

  if (kind === "yesno" || kind === "truth") {
    const items: Choice[] =
      kind === "yesno"
        ? [{ label: "Yes", action: "value", value: "yes" }, { label: "No", action: "value", value: "no" }]
        : [{ label: "True", action: "value", value: true }, { label: "False", action: "value", value: false }];
    const picked = await vscode.window.showQuickPick(skip ? [...items, skip] : items, {
      title,
      placeHolder: knownLine || undefined,
      ignoreFocusOut: true,
    });
    if (!picked) return undefined;
    return [picked.action === "skip" ? skipAnswer(question) : answerFor(question, picked.value!)];
  }

  // Instances for a string question; known values as suggestions for a number
  // or date question, which always keeps a typed entry (canAdd is about instances).
  const options = optionsFor(question);
  const typed = kind !== "string" || options.length === 0 || canAddHere(question);
  const typeRow: Choice = {
    label: kind === "number" ? "$(edit) Enter a number…" : kind === "date" ? "$(edit) Enter a date…" : options.length ? "$(edit) Other…" : "$(edit) Type an answer…",
    action: "type",
  };
  const valueOf = async (choice: Choice): Promise<string | number | boolean | undefined> => {
    if (choice.action === "type") return typeValue(question, title, knownLine);
    if (kind === "string") return choice.value; // the engine's own instance name, sent as offered
    const result = coerceAnswer(question, choice.value);
    return result.ok ? result.value : choice.value;
  };

  if (question.plural) {
    // Values the engine already holds are kept anyway, so they are not offered again.
    const held = new Set(known.map((k) => k.value));
    const fresh = options.filter((o) => !held.has(o.value));
    if (!fresh.length && !typed && skip) {
      // Every value the map offers is already known and the map allows no new
      // one, so the skip is the only answer left: no "Add more" leading to a
      // free-text box the map does not allow. (Values are held only when there
      // are known answers, so `skip` is set here unless the engine refused it.)
      const only = await vscode.window.showQuickPick<Choice>(
        [{ ...skip, detail: `Every value the map offers is already known, and the map allows no new ones. ${skip.detail}` }],
        { title, placeHolder: knownLine || question.prompt, ignoreFocusOut: true }
      );
      return only ? [skipAnswer(question)] : undefined;
    }
    // Typing is offered only where `typed` allows it; with nothing new to pick
    // and no typing (the engine refused the skip), the known values are offered again.
    const choices: Choice[] = (fresh.length || typed ? fresh : options).map((o) => ({ label: o.label, action: "value", value: o.value }));
    for (;;) {
      if (skip) {
        // Two steps, so the skip is never ticked together with values in a multi-pick.
        const first = await vscode.window.showQuickPick<Choice>(
          [{ label: known.length ? "Add more" : "Answer", detail: known.length ? "Pick values to add to the known answers." : "Pick one or more answers.", action: "value" }, skip],
          { title, placeHolder: knownLine || question.prompt, ignoreFocusOut: true }
        );
        if (!first) return undefined;
        if (first.action === "skip") return [skipAnswer(question)];
      }
      const picked = choices.length
        ? await vscode.window.showQuickPick<Choice>(typed ? [...choices, typeRow] : choices, {
            title,
            placeHolder: knownLine ? `${knownLine} — pick what to add` : "Pick one or more",
            canPickMany: true,
            ignoreFocusOut: true,
          })
        : [typeRow];
      if (!picked) return undefined;
      const answers: Answer[] = [];
      for (const choice of picked) {
        const value = await valueOf(choice);
        if (value === undefined) return undefined;
        answers.push(answerFor(question, value));
      }
      if (answers.length) return answers;
      // Accepted with nothing ticked: ask again (Escape cancels the query).
    }
  }

  const choices: Choice[] = options.map((o) => ({ label: o.label, action: "value", value: o.value }));
  let picked: Choice | undefined = typeRow;
  if (choices.length || skip) {
    picked = await vscode.window.showQuickPick([...choices, ...(typed ? [typeRow] : []), ...(skip ? [skip] : [])], {
      title,
      placeHolder: knownLine || (choices.length ? "Pick an answer" : undefined),
      ignoreFocusOut: true,
    });
  }
  if (!picked) return undefined;
  if (picked.action === "skip") return [skipAnswer(question)];
  const value = await valueOf(picked);
  return value === undefined ? undefined : [answerFor(question, value)];
}

/** An input box for one typed value, validated as the engine needs it; undefined when cancelled. */
async function typeValue(question: Question, title: string, knownLine: string): Promise<string | number | boolean | undefined> {
  const kind = controlKind(question);
  const dateOrder = readDateOrder(vscode.workspace.getConfiguration("rainbird").get("query.dateOrder"));
  const hint = kind === "number" ? HINTS.number : kind === "date" ? HINTS.date : HINTS.string;
  for (;;) {
    const text = await vscode.window.showInputBox({
      title,
      prompt: knownLine ? `${hint} ${knownLine}.` : hint,
      placeHolder: kind === "number" ? HINTS.numberPlaceholder : kind === "date" ? HINTS.datePlaceholder : HINTS.stringPlaceholder,
      ignoreFocusOut: true,
      validateInput: (value) => {
        if (!value.trim()) return undefined;
        const result = coerceAnswer(question, value, { dateOrder });
        // An ambiguous date is an error naming both readings: never a silent guess.
        if (!result.ok) return { message: result.error, severity: vscode.InputBoxValidationSeverity.Error };
        if (kind === "date") {
          return { message: `Will send ${result.value} (${describeDate(String(result.value))})`, severity: vscode.InputBoxValidationSeverity.Info };
        }
        return undefined;
      },
    });
    if (text === undefined) return undefined;
    const result = coerceAnswer(question, text, { dateOrder });
    if (result.ok) return result.value;
    // Only an empty box gets here (validateInput blocks anything else): ask again.
  }
}

/**
 * What to tell the user when the engine refuses a batch. A batch of skips only
 * was refused for a skip; a batch mixing skips and values does not say which
 * failed, so the note lists what each question expects and says the skip is
 * withdrawn in case it was the cause.
 */
function rejectedBatchNote(error: ApiError, group: Question[], answers: Answer[]): string {
  const detail = error.errMessages()?.join("; ") ?? error.body.slice(0, 160);
  const skipped = group.filter((q) => answers.some((a) => a.unanswered && questionKey(a) === questionKey(q)));
  if (!skipped.length) return group.length === 1 ? rejectionNote(detail, group[0]) : groupRejectionNote(detail, group);
  if (answers.every((a) => a.unanswered)) return skipRejectedNote(detail, skipped[0], "Pick an answer instead.");
  const names = skipped.map((q) => `“${q.prompt || q.relationship}”`).join(", ");
  return groupRejectionNote(detail, group, `Skipping ${names} is no longer offered, in case that was the cause — answer ${skipped.length > 1 ? "them" : "it"} this time.`);
}

/** The results as a Quick Pick; `objectType` (the goal's object type, when the map is known) formats each value as the panel does. */
async function presentResult(
  client: RainbirdClient,
  sessionId: string,
  results: ResultItem[],
  evidenceKey?: string | (() => Promise<string | undefined>),
  objectType?: string
): Promise<void> {
  if (results.length === 0) {
    vscode.window.showWarningMessage("Rainbird returned no results for this query.");
    return;
  }
  const items = results.map((r) => ({
    label: `${r.subject} ${r.relationship} ${objectType ? formatValue(objectType, r.object) : r.object}`,
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
