/**
 * Guided authoring: add a concept, relationship, instance, fact, rule or
 * condition without knowing RBLang. Every flow is a short series of quick
 * picks whose choices come from what the map already declares (so a subject is
 * always a real string concept, a fact's instances really exist), inserts the
 * element in the docs' recommended section of the file, and leaves the cursor
 * on the RBLang it produced — so authors see and learn the language rather
 * than being shielded from it. Reached from the Map Explorer's ＋ buttons, the
 * editor's ＋ Insert… button, the right-click menu and CodeLenses on
 * relationships (＋ fact, ＋ rule) and rules (＋ condition).
 */
import * as vscode from "vscode";
import { buildIndex, MapIndex } from "./mapIndex";
import {
  Askable,
  ConditionSpec,
  conceptXml,
  conditionEnglish,
  conditionXml,
  detectIndent,
  ElementKind,
  factXml,
  hasRoot,
  insertPoint,
  instanceXml,
  lineStartOf,
  Part,
  relXml,
  ruleAt,
  ruleXml,
  SKELETON,
  toVariable,
  topLevelElements,
  variablesIn,
} from "./authoringModel";

const NAME_FORBIDDEN = /["\\<>]/;
const NEW = "$(add) ";

type Item<T> = vscode.QuickPickItem & { value: T };

async function pick<T>(items: Item<T>[], title: string, placeHolder?: string): Promise<T | undefined> {
  const picked = await vscode.window.showQuickPick(items, { title, placeHolder, matchOnDescription: true, ignoreFocusOut: true });
  return picked?.value;
}

/**
 * The RBLang editor a flow works on: the given document, else the active or
 * any visible .rbl editor. Only a real Uri selects a document: menu commands
 * receive whatever VS Code hands them (a tree item, a CodeLens argument), and
 * passing a plain object to openTextDocument would create a new untitled file.
 */
async function targetEditor(uri?: vscode.Uri): Promise<vscode.TextEditor | undefined> {
  if (uri instanceof vscode.Uri) {
    const visible = vscode.window.visibleTextEditors.find((e) => e.document.uri.toString() === uri.toString());
    if (visible) return visible;
    return vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri), { preserveFocus: true });
  }
  const active = vscode.window.activeTextEditor;
  if (active?.document.languageId === "rblang") return active;
  const visible = vscode.window.visibleTextEditors.find((e) => e.document.languageId === "rblang");
  if (visible) return visible;
  vscode.window.showInformationMessage("Open the RBLang (.rbl) file you want to edit first.");
  return undefined;
}

const indexOf = (editor: vscode.TextEditor): MapIndex => buildIndex(editor.document.getText());

/**
 * Insert an element in its section. Creates the knowledge-base skeleton in an
 * empty file; in a file without a root element, inserts at the cursor.
 */
async function insertElement(
  editor: vscode.TextEditor,
  kind: ElementKind,
  parts: Part[],
  prefer?: (el: { tag: { attrs: Record<string, string> } }) => boolean
): Promise<void> {
  const doc = editor.document;
  if (!hasRoot(indexOf(editor)) && !doc.getText().trim()) {
    await editor.edit((b) => b.insert(new vscode.Position(0, 0), SKELETON));
  }
  const text = doc.getText();
  const point = insertPoint(text, buildIndex(text), kind, prefer) ?? {
    offset: doc.offsetAt(editor.selection.active),
    before: "",
    after: "",
  };
  await insertParts(editor, point.offset, [point.before, ...parts, point.after]);
}

async function insertParts(editor: vscode.TextEditor, offset: number, parts: Part[]): Promise<void> {
  const snippet = new vscode.SnippetString();
  for (const p of parts) {
    if (typeof p === "string") snippet.appendText(p);
    else snippet.appendPlaceholder(p.placeholder);
  }
  const position = editor.document.positionAt(offset);
  await editor.insertSnippet(snippet, position, { undoStopBefore: true, undoStopAfter: true, keepWhitespace: true });
  editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenter);
}

async function inputName(prompt: string, placeHolder: string, taken: Iterable<string>, kindLabel: string): Promise<string | undefined> {
  const existing = new Set(taken);
  const value = await vscode.window.showInputBox({
    prompt,
    placeHolder,
    ignoreFocusOut: true,
    validateInput: (v) =>
      !v.trim()
        ? "Enter a name"
        : NAME_FORBIDDEN.test(v)
          ? `Names cannot contain " \\ < >`
          : existing.has(v.trim())
            ? `A ${kindLabel} named "${v.trim()}" already exists`
            : undefined,
  });
  return value?.trim();
}

async function inputCertainty(prompt: string): Promise<string | undefined> {
  return vscode.window.showInputBox({
    prompt,
    value: "100",
    ignoreFocusOut: true,
    validateInput: (v) => (/^\d+$/.test(v.trim()) && Number(v) <= 100 ? undefined : "A whole number from 0 to 100"),
  });
}

// ---------------------------------------------------------------------------
// Concepts

const CONCEPT_TYPES: Item<string>[] = [
  { label: "string", description: "Text — names and categories: Person, Country, Status", detail: "Only string concepts can have instances or be a relationship's subject.", value: "string" },
  { label: "number", description: "A quantity: Age, Income, Score", value: "number" },
  { label: "date", description: "A calendar date: Date Of Birth, Expiry Date", value: "date" },
  { label: "truth", description: "Yes / no: Is Resident, Has Consent", value: "truth" },
];

export async function addConcept(uri?: vscode.Uri): Promise<string | undefined> {
  const editor = await targetEditor(uri);
  if (!editor) return undefined;
  const name = await inputName("Concept name — a type of thing the map reasons about", "e.g. Person, Country, Age", indexOf(editor).concepts.keys(), "concept");
  if (!name) return undefined;
  const type = await pick(CONCEPT_TYPES, `Concept "${name}" — what kind of values does it hold?`);
  if (!type) return undefined;
  let mutuallyExclusive = false;
  if (type === "string") {
    const mode = await pick<boolean>(
      [
        { label: "Any number of instances", description: "the usual case", value: false },
        { label: "Mutually exclusive", description: "exactly two instances, only one can be true — e.g. Eligible / Not Eligible", value: true },
      ],
      `Concept "${name}" — how do its instances relate?`
    );
    if (mode === undefined) return undefined;
    mutuallyExclusive = mode;
  }
  await insertElement(editor, "concept", [conceptXml(name, type, mutuallyExclusive)]);
  return name;
}

async function pickConcept(
  editor: vscode.TextEditor,
  title: string,
  options: { stringOnly?: boolean; allowNew?: boolean } = {}
): Promise<string | undefined> {
  const index = indexOf(editor);
  const items: Item<string | typeof NEW>[] = [...index.concepts.entries()]
    .filter(([, c]) => !options.stringOnly || c.type === "string")
    .map(([name, c]) => ({ label: name, description: c.type, value: name }));
  if (options.allowNew) items.push({ label: `${NEW}New concept…`, description: "declare it first, then come back here", value: NEW });
  if (!items.length) {
    vscode.window.showInformationMessage(options.stringOnly ? "The map has no string concepts yet — add a concept first." : "The map has no concepts yet — add a concept first.");
    return undefined;
  }
  const picked = await pick(items, title, options.stringOnly ? "String concepts only — they are the only ones that can have instances or be subjects" : undefined);
  if (picked === NEW) return addConcept(editor.document.uri);
  return picked;
}

// ---------------------------------------------------------------------------
// Relationships

const ASKABLE: Item<Askable>[] = [
  { label: "Ask the user when unknown", description: "askable=\"all\" — the engine can ask in any form", value: "all" },
  { label: "Never ask", description: "askable=\"none\" — only inferred by rules or supplied as facts / data", value: "none" },
  { label: "Only ask “which … does %S …?”", description: "askable=\"secondFormObject\"", value: "secondFormObject" },
  { label: "Only ask “which … %O?”", description: "askable=\"secondFormSubject\"", value: "secondFormSubject" },
];

export async function addRelationship(uri?: vscode.Uri): Promise<string | undefined> {
  const editor = await targetEditor(uri);
  if (!editor) return undefined;
  const name = await inputName("Relationship name — how a subject relates to an object, read left to right", "e.g. lives in, speaks, has age", indexOf(editor).relationships.keys(), "relationship");
  if (!name) return undefined;
  const subject = await pickConcept(editor, `"${name}" — the subject: what is on the left?`, { stringOnly: true, allowNew: true });
  if (!subject) return undefined;
  const object = await pickConcept(editor, `"${subject} ${name} …" — the object: what is on the right?`, { allowNew: true });
  if (!object) return undefined;
  const plural = await pick<boolean>(
    [
      { label: "One value", description: `each ${subject} ${name} a single ${object}`, value: false },
      { label: "Many values", description: `plural="true" — a ${subject} can ${name} several ${object}s; the engine looks for all of them`, value: true },
    ],
    `"${subject} ${name} ${object}" — how many objects per subject?`
  );
  if (plural === undefined) return undefined;
  const askable = await pick(ASKABLE, `"${subject} ${name} ${object}" — may the engine ask the user about it?`);
  if (!askable) return undefined;
  const text = editor.document.getText();
  await insertElement(editor, "rel", relXml({ name, subject, object, plural, askable }, detectIndent(text)));
  return name;
}

async function pickRelationship(editor: vscode.TextEditor, title: string, allowNew: boolean): Promise<string | undefined> {
  const index = indexOf(editor);
  const items: Item<string>[] = [...index.relationships.entries()].map(([name, r]) => ({
    label: name,
    description: `${r.subject} → ${r.object}${r.plural ? " (plural)" : ""}`,
    value: name,
  }));
  if (allowNew) items.push({ label: `${NEW}New relationship…`, value: NEW });
  if (!items.length) {
    vscode.window.showInformationMessage("The map has no relationships yet — add a relationship first.");
    return undefined;
  }
  const picked = await pick(items, title);
  if (picked === NEW) return addRelationship(editor.document.uri);
  return picked;
}

// ---------------------------------------------------------------------------
// Instances

export async function addInstance(uri?: vscode.Uri, conceptName?: string): Promise<string | undefined> {
  const editor = await targetEditor(uri);
  if (!editor) return undefined;
  const concept = conceptName ?? (await pickConcept(editor, "Instance of which concept?", { stringOnly: true, allowNew: true }));
  if (!concept) return undefined;
  const name = await inputName(`Instance name — a specific ${concept}`, `e.g. ${concept === "Person" ? "Julio" : concept === "Country" ? "France" : "a value of " + concept}`, indexOf(editor).instances.keys(), "instance");
  if (!name) return undefined;
  await insertElement(editor, "concinst", [instanceXml(name, concept)], (el) => el.tag.attrs.type === concept);
  return name;
}

const LITERAL = "$(edit) ";

async function pickInstance(
  editor: vscode.TextEditor,
  concept: string,
  title: string,
  options: { allowNew?: boolean; allowLiteral?: boolean } = {}
): Promise<string | undefined> {
  const index = indexOf(editor);
  const items: Item<string>[] = [...index.instances.entries()]
    .filter(([, i]) => i.type === concept)
    .map(([name]) => ({ label: name, description: concept, value: name }));
  if (options.allowNew) items.push({ label: `${NEW}New ${concept} instance…`, value: NEW });
  if (options.allowLiteral) items.push({ label: `${LITERAL}Type a value…`, description: "a value not declared as an instance", value: LITERAL });
  const picked = await pick(items, title);
  if (picked === NEW) return addInstance(editor.document.uri, concept);
  if (picked === LITERAL) return vscode.window.showInputBox({ prompt: `A ${concept} value`, ignoreFocusOut: true });
  return picked;
}

/** A typed literal for a non-string object concept (number / date / truth). */
async function inputTypedValue(concept: string, type: string, prompt: string): Promise<string | undefined> {
  const check: Record<string, [RegExp, string]> = {
    number: [/^-?\d+(\.\d+)?$/, "A number, e.g. 42 or 3.5"],
    date: [/^\d{4}-\d{2}-\d{2}$/, "A date as YYYY-MM-DD"],
    truth: [/^(true|false)$/i, "true or false"],
  };
  const [re, hint] = check[type] ?? [/.*/, ""];
  return vscode.window.showInputBox({
    prompt: `${prompt} — ${concept} is a ${type}${hint ? ` (${hint})` : ""}`,
    ignoreFocusOut: true,
    validateInput: (v) => (re.test(v.trim()) ? undefined : hint),
  });
}

// ---------------------------------------------------------------------------
// Facts

export async function addFact(uri?: vscode.Uri, relName?: string): Promise<void> {
  const editor = await targetEditor(uri);
  if (!editor) return;
  const rel = relName ?? (await pickRelationship(editor, "Fact — which relationship does it assert?", true));
  if (!rel) return;
  const index = indexOf(editor);
  const r = index.relationships.get(rel);
  if (!r) return;
  const subject = await pickInstance(editor, r.subject, `Fact "… ${rel} …" — the subject (a ${r.subject})`, { allowNew: true, allowLiteral: true });
  if (!subject) return;
  const objectType = index.concepts.get(r.object)?.type ?? "string";
  const object =
    objectType === "string"
      ? await pickInstance(editor, r.object, `Fact "${subject} ${rel} …" — the object (a ${r.object})`, { allowNew: true, allowLiteral: true })
      : await inputTypedValue(r.object, objectType, `Fact "${subject} ${rel} …" — the object value`);
  if (!object) return;
  const cf = await inputCertainty(`How certain is "${subject} ${rel} ${object}"? (100 = certain)`);
  if (cf === undefined) return;
  await insertElement(editor, "fact", [factXml(rel, subject, object, cf.trim())], (el) => el.tag.attrs.type === rel);
}

// ---------------------------------------------------------------------------
// Conditions and rules

interface RuleContext {
  /** The relationship the rule concludes. */
  rel: string;
  subjectConcept: string;
  objectConcept: string;
  /** Variables already bound in the rule (%S and %O included). */
  variables: string[];
}

const CUSTOM = "$(symbol-numeric) ";

/** %S / %O / an existing variable / a new variable / a fixed instance or literal, for a condition's subject or object. */
async function pickVariableOrValue(
  editor: vscode.TextEditor,
  ctx: RuleContext,
  concept: string,
  title: string,
  role: "subject" | "object"
): Promise<string | undefined> {
  const index = indexOf(editor);
  const items: Item<string>[] = [];
  const matchesS = concept === ctx.subjectConcept;
  const matchesO = concept === ctx.objectConcept;
  const reserved: Item<string>[] = [
    { label: "%S", description: `the rule's subject (${ctx.subjectConcept})`, value: "%S" },
    { label: "%O", description: `the rule's object (${ctx.objectConcept})`, value: "%O" },
  ];
  // The variable whose concept matches comes first — it is nearly always the intended one.
  items.push(...(matchesO && !matchesS ? reserved.reverse() : reserved));
  for (const v of ctx.variables.filter((v) => v !== "%S" && v !== "%O")) items.push({ label: v, description: "variable already bound in this rule", value: v });
  items.push({ label: `${NEW}New variable…`, description: `bind the ${concept} found here to a name, e.g. %COUNTRY, for later conditions`, value: NEW });
  if (index.concepts.get(concept)?.type === "string") {
    for (const [name, i] of index.instances) if (i.type === concept) items.push({ label: name, description: `fixed value — this ${concept} specifically`, value: name });
  }
  items.push({ label: `${LITERAL}Type a fixed value…`, value: LITERAL });
  const picked = await pick(items, title, `${role} of the condition — a ${concept}`);
  if (picked === NEW) {
    const raw = await vscode.window.showInputBox({
      prompt: `Variable name for the ${concept} — letters, digits and underscores; it becomes %UPPER_CASE`,
      value: toVariable(concept).slice(1),
      ignoreFocusOut: true,
      validateInput: (v) => (toVariable(v) ? undefined : "Enter at least one letter"),
    });
    return raw ? toVariable(raw) : undefined;
  }
  if (picked === LITERAL) return vscode.window.showInputBox({ prompt: `A fixed ${concept} value`, ignoreFocusOut: true });
  return picked;
}

async function pickWeight(summary: string): Promise<{ weight: string; optional: boolean } | undefined> {
  const mode = await pick<"mandatory" | "optional" | "custom">(
    [
      { label: "Mandatory", description: "weight 100 — the rule cannot fire without it", value: "mandatory" },
      { label: "Optional", description: "weight 100 — if unmet the rule can still fire, at lower certainty", value: "optional" },
      { label: `${CUSTOM}Custom weight…`, description: "relative importance; 0 = no effect on certainty", value: "custom" },
    ],
    `Condition "${summary}" — how much does it matter?`
  );
  if (!mode) return undefined;
  if (mode !== "custom") return { weight: "100", optional: mode === "optional" };
  const weight = await vscode.window.showInputBox({
    prompt: "Weight — a whole number, 100 is the usual value",
    value: "100",
    ignoreFocusOut: true,
    validateInput: (v) => (/^\d+$/.test(v.trim()) ? undefined : "A whole number, 0 or more"),
  });
  if (weight === undefined) return undefined;
  const optional = await pick<boolean>(
    [
      { label: "Mandatory", value: false },
      { label: "Optional", description: "the rule can fire without it", value: true },
    ],
    `Condition "${summary}"`
  );
  if (optional === undefined) return undefined;
  return { weight: weight.trim(), optional };
}

/** One guided condition. Returns undefined when the author cancels. */
async function buildCondition(editor: vscode.TextEditor, ctx: RuleContext): Promise<ConditionSpec | undefined> {
  const kind = await pick<"rel" | "test" | "assign">(
    [
      { label: "$(arrow-right) Relationship condition", description: "a fact that must hold, e.g. %S lives in %COUNTRY", detail: "Binds variables (%COUNTRY) that later conditions can use.", value: "rel" },
      { label: "$(symbol-operator) Expression test", description: "compare values, e.g. %AGE is greater than or equal to 18", value: "test" },
      { label: "$(symbol-variable) Expression assignment", description: "compute a value into a variable, e.g. yearsBetween(%DOB, today()) → %O", value: "assign" },
    ],
    `Rule "${ctx.rel}" — what kind of condition?`
  );
  if (!kind) return undefined;
  const available = `Variables available: ${ctx.variables.join(", ")}`;

  if (kind === "rel") {
    const index = indexOf(editor);
    const rels = [...index.relationships.entries()].sort(([, a], [, b]) => Number(b.subject === ctx.subjectConcept) - Number(a.subject === ctx.subjectConcept));
    const rel = await pick(
      rels.map(([name, r]) => ({ label: name, description: `${r.subject} → ${r.object}${r.subject === ctx.subjectConcept ? "  ·  about the rule's subject" : ""}`, value: name })),
      "Relationship condition — which relationship must hold?"
    );
    if (!rel) return undefined;
    const r = index.relationships.get(rel)!;
    const subject = await pickVariableOrValue(editor, ctx, r.subject, `Condition "… ${rel} …" — the subject`, "subject");
    if (!subject) return undefined;
    const object = await pickVariableOrValue(editor, ctx, r.object, `Condition "${subject} ${rel} …" — the object`, "object");
    if (!object) return undefined;
    const w = await pickWeight(`${subject} ${rel} ${object}`);
    if (!w) return undefined;
    return { kind: "rel", rel, subject, object, ...w };
  }

  const expression = await vscode.window.showInputBox({
    prompt: kind === "test" ? `Expression that must be true. ${available}` : `Expression to compute. ${available}`,
    placeHolder: kind === "test" ? "%AGE is greater than or equal to 18" : "yearsBetween(%DOB, today())",
    ignoreFocusOut: true,
    validateInput: (v) => (v.trim() ? undefined : "Enter an expression"),
  });
  if (!expression) return undefined;
  if (kind === "test") {
    const w = await pickWeight(expression.trim());
    return w ? { kind: "expression", expression: expression.trim(), ...w } : undefined;
  }
  const targets: Item<string>[] = [
    { label: "%O", description: "the rule's object — the value the rule concludes", value: "%O" },
    ...ctx.variables.filter((v) => v !== "%S" && v !== "%O").map((v) => ({ label: v, description: "existing variable", value: v })),
    { label: `${NEW}New variable…`, value: NEW },
  ];
  let value = await pick(targets, `Store "${expression.trim()}" into which variable?`);
  if (value === NEW) {
    const raw = await vscode.window.showInputBox({ prompt: "Variable name — becomes %UPPER_CASE", placeHolder: "TOTAL", ignoreFocusOut: true, validateInput: (v) => (toVariable(v) ? undefined : "Enter at least one letter") });
    value = raw ? toVariable(raw) : undefined;
  }
  if (!value) return undefined;
  return { kind: "expression", expression: expression.trim(), value, weight: "100", optional: false };
}

const variablesOf = (c: ConditionSpec): string[] =>
  c.kind === "rel" ? variablesIn(`${c.subject} ${c.object}`) : variablesIn(`${c.expression} ${c.value ?? ""}`);

export async function addRule(uri?: vscode.Uri, relName?: string): Promise<void> {
  const editor = await targetEditor(uri);
  if (!editor) return;
  const rel = relName ?? (await pickRelationship(editor, "Rule — which relationship does it conclude? (THEN %S ‹relationship› %O)", true));
  if (!rel) return;
  const index = indexOf(editor);
  const r = index.relationships.get(rel);
  if (!r) return;
  const name = await vscode.window.showInputBox({
    prompt: `Rule name — what it establishes, in plain words (optional, shown in evidence and diffs)`,
    placeHolder: `e.g. ${rel === "speaks" ? "Speaks national language of home country" : `Infer ${rel}`}`,
    ignoreFocusOut: true,
    validateInput: (v) => (NAME_FORBIDDEN.test(v) ? `Names cannot contain " \\ < >` : undefined),
  });
  if (name === undefined) return;

  let object: string | undefined;
  const objectInstances = [...index.instances.entries()].filter(([, i]) => i.type === r.object).map(([n]) => n);
  if (objectInstances.length) {
    const picked = await pick<string>(
      [
        { label: "Infer the object", description: `%O — the conditions determine which ${r.object}`, value: "%O" },
        ...objectInstances.map((n) => ({ label: n, description: `always conclude "%S ${rel} ${n}"`, value: n })),
      ],
      `Rule "${name || rel}" — what does it conclude?`
    );
    if (!picked) return;
    if (picked !== "%O") object = picked;
  }
  const cf = await inputCertainty(`Maximum certainty of what the rule concludes (100 = certain when all conditions are met)`);
  if (cf === undefined) return;

  const ctx: RuleContext = { rel, subjectConcept: r.subject, objectConcept: r.object, variables: ["%S", "%O"] };
  const conditions: ConditionSpec[] = [];
  for (;;) {
    const english = conditions.length ? `IF ${conditions.map(conditionEnglish).join(" AND ")} THEN %S ${rel} ${object ?? "%O"}` : `IF … THEN %S ${rel} ${object ?? "%O"}`;
    const next = await pick<"add" | "done">(
      [
        { label: `${NEW}Add a condition`, description: conditions.length ? "another thing that must hold" : "what must hold for the rule to fire", value: "add" },
        { label: `$(check) Insert the rule`, description: conditions.length ? `${conditions.length} condition${conditions.length === 1 ? "" : "s"}` : "with a placeholder condition to fill in", value: "done" },
      ],
      english
    );
    if (!next) return;
    if (next === "done") break;
    const condition = await buildCondition(editor, ctx);
    if (!condition) continue;
    conditions.push(condition);
    for (const v of variablesOf(condition)) if (!ctx.variables.includes(v)) ctx.variables.push(v);
  }
  const text = editor.document.getText();
  await insertElement(editor, "rule", ruleXml({ rel, name: name.trim() || undefined, cf: cf.trim(), object, conditions }, detectIndent(text)), (el) => el.tag.attrs.type === rel);
}

/** Add a condition to the rule at `offset` (or at the cursor). */
export async function addCondition(uri?: vscode.Uri, offset?: number): Promise<void> {
  const editor = await targetEditor(uri);
  if (!editor) return;
  const text = editor.document.getText();
  const index = buildIndex(text);
  const rule = ruleAt(index, offset ?? editor.document.offsetAt(editor.selection.active));
  if (!rule || rule.closeStart === undefined) {
    vscode.window.showInformationMessage("Place the cursor inside a rule (a <relinst> with conditions) to add a condition to it.");
    return;
  }
  const rel = rule.tag.attrs.type ?? "";
  const r = index.relationships.get(rel);
  const ctx: RuleContext = {
    rel,
    subjectConcept: r?.subject ?? "?",
    objectConcept: r?.object ?? "?",
    variables: [...new Set(["%S", "%O", ...variablesIn(text.slice(rule.start, rule.end))])],
  };
  const condition = await buildCondition(editor, ctx);
  if (!condition) return;
  const indent = detectIndent(text);
  await insertParts(editor, lineStartOf(text, rule.closeStart), [`${indent}${indent}${conditionXml(condition)}\n`]);
}

// ---------------------------------------------------------------------------
// The Insert… menu, CodeLenses and registration

export async function insertMenu(): Promise<void> {
  const editor = await targetEditor();
  if (!editor) return;
  const inRule = !!ruleAt(indexOf(editor), editor.document.offsetAt(editor.selection.active));
  type Flow = () => Promise<unknown>;
  const items: Item<Flow>[] = [
    { label: "$(symbol-class) Concept", description: "a type of thing: Person, Age, Country", value: () => addConcept(editor.document.uri) },
    { label: "$(arrow-right) Relationship", description: "how two concepts relate: Person lives in Country", value: () => addRelationship(editor.document.uri) },
    { label: "$(symbol-field) Instance", description: "a specific value of a concept: Julio, England", value: () => addInstance(editor.document.uri) },
    { label: "$(symbol-constant) Fact", description: "a known relationship between instances: England national language English", value: () => addFact(editor.document.uri) },
    { label: "$(law) Rule", description: "infers a relationship when conditions hold: IF … THEN Person speaks Language", value: () => addRule(editor.document.uri) },
  ];
  if (inRule) items.unshift({ label: "$(list-tree) Condition", description: "add to the rule at the cursor", value: () => addCondition(editor.document.uri) });
  const flow = await pick(items, "Insert into the knowledge map", "Each choice asks a few questions, then inserts the RBLang in the right place");
  if (flow) await flow();
}

class AuthoringCodeLensProvider implements vscode.CodeLensProvider {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this.emitter.event;
  private debounce?: NodeJS.Timeout;

  constructor(context: vscode.ExtensionContext) {
    context.subscriptions.push(
      vscode.workspace.onDidChangeTextDocument((e) => {
        if (e.document.languageId !== "rblang") return;
        clearTimeout(this.debounce);
        this.debounce = setTimeout(() => this.emitter.fire(), 500);
      })
    );
  }

  provideCodeLenses(doc: vscode.TextDocument): vscode.CodeLens[] {
    const index = buildIndex(doc.getText());
    const lenses: vscode.CodeLens[] = [];
    for (const [name, rel] of index.relationships) {
      const range = new vscode.Range(doc.positionAt(rel.offset), doc.positionAt(rel.offset));
      lenses.push(
        new vscode.CodeLens(range, { title: "$(add) fact", tooltip: `Add a fact asserting "${name}"`, command: "rainbird.addFact", arguments: [doc.uri, name] }),
        new vscode.CodeLens(range, { title: "$(add) rule", tooltip: `Add a rule that infers "${name}"`, command: "rainbird.addRule", arguments: [doc.uri, name] })
      );
    }
    for (const rule of topLevelElements(index)) {
      if (rule.kind !== "rule") continue;
      const range = new vscode.Range(doc.positionAt(rule.start), doc.positionAt(rule.start));
      lenses.push(new vscode.CodeLens(range, { title: "$(add) condition", tooltip: "Add a condition to this rule", command: "rainbird.addCondition", arguments: [doc.uri, rule.start] }));
    }
    return lenses;
  }
}

/**
 * The document a command argument refers to. Editor menus pass a Uri; the Map
 * Explorer's ＋ buttons pass the category tree item, which carries the Uri of
 * the document the tree is showing; anything else means "the active editor".
 */
function uriOf(arg: unknown): vscode.Uri | undefined {
  if (arg instanceof vscode.Uri) return arg;
  if (arg && typeof arg === "object" && (arg as { uri?: unknown }).uri instanceof vscode.Uri) return (arg as { uri: vscode.Uri }).uri;
  return undefined;
}

export function registerAuthoring(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.languages.registerCodeLensProvider({ language: "rblang" }, new AuthoringCodeLensProvider(context)),
    vscode.commands.registerCommand("rainbird.insertElement", () => insertMenu()),
    vscode.commands.registerCommand("rainbird.addConcept", (arg?: unknown) => addConcept(uriOf(arg))),
    vscode.commands.registerCommand("rainbird.addRelationship", (arg?: unknown) => addRelationship(uriOf(arg))),
    vscode.commands.registerCommand("rainbird.addInstance", (arg?: unknown) => addInstance(uriOf(arg))),
    vscode.commands.registerCommand("rainbird.addFact", (arg?: unknown, rel?: string) => addFact(uriOf(arg), typeof rel === "string" ? rel : undefined)),
    vscode.commands.registerCommand("rainbird.addRule", (arg?: unknown, rel?: string) => addRule(uriOf(arg), typeof rel === "string" ? rel : undefined)),
    vscode.commands.registerCommand("rainbird.addCondition", (arg?: unknown, offset?: number) => addCondition(uriOf(arg), typeof offset === "number" ? offset : undefined))
  );
}
