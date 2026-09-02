/**
 * Structural + referential diagnostics for RBLang documents.
 *
 * Mirrors what Studio's validator and rblint check, reimplemented from the
 * documented RBLang reference: unknown elements/attributes, missing required
 * attributes, invalid enum values, references to undeclared concepts and
 * relationships, and a handful of semantic footguns (non-string subjects,
 * cf out of range, minimum-rule-certainty above cf).
 *
 * The core (`collectIssues`) is editor-agnostic so the AI assistant can lint
 * generated RBLang before offering it; `validate` adapts it to VSCode
 * diagnostics.
 */
import * as vscode from "vscode";
import { SCHEMA, EXPRESSION_FUNCTIONS } from "./schema";
import { buildIndex, MapIndex, TagOccurrence, attrValueRange, attrFullRange } from "./mapIndex";

/** A machine-applicable repair for an issue (offsets into the linted text). */
export interface LintFix {
  title: string;
  edits: { start: number; end: number; newText: string }[];
}

export interface LintIssue {
  start: number;
  end: number;
  /** 0-based line of `start` */
  line: number;
  message: string;
  severity: "error" | "warning" | "info";
  fixes?: LintFix[];
}

/** Latest issues per document, so the code-action provider can serve fixes without re-linting. */
const latestIssues = new Map<string, LintIssue[]>();

export function getCachedIssues(uriKey: string): LintIssue[] | undefined {
  return latestIssues.get(uriKey);
}

export function registerDiagnostics(context: vscode.ExtensionContext): void {
  const collection = vscode.languages.createDiagnosticCollection("rblang");
  context.subscriptions.push(collection);

  const refresh = (doc: vscode.TextDocument) => {
    if (doc.languageId !== "rblang") return;
    collection.set(doc.uri, validate(doc));
  };

  context.subscriptions.push(
    vscode.workspace.onDidOpenTextDocument(refresh),
    vscode.workspace.onDidChangeTextDocument((e) => refresh(e.document)),
    vscode.workspace.onDidCloseTextDocument((doc) => {
      collection.delete(doc.uri);
      latestIssues.delete(doc.uri.toString());
    })
  );
  vscode.workspace.textDocuments.forEach(refresh);
}

export function validate(doc: vscode.TextDocument): vscode.Diagnostic[] {
  const severities = {
    error: vscode.DiagnosticSeverity.Error,
    warning: vscode.DiagnosticSeverity.Warning,
    info: vscode.DiagnosticSeverity.Information,
  } as const;
  const issues = collectIssues(doc.getText());
  latestIssues.set(doc.uri.toString(), issues);
  return issues.map((issue) => {
    const range = new vscode.Range(doc.positionAt(issue.start), doc.positionAt(issue.end));
    const d = new vscode.Diagnostic(range, issue.message, severities[issue.severity]);
    d.source = "rblang";
    return d;
  });
}

/** Lint arbitrary RBLang text (used on assistant-generated code before it is offered). */
export function collectIssues(text: string): LintIssue[] {
  const index = buildIndex(text);
  const issues: LintIssue[] = [];

  const add = (tag: TagOccurrence, message: string, severity: LintIssue["severity"] = "error", fixes?: LintFix[]) => {
    issues.push({
      start: tag.start,
      end: tag.end,
      line: text.slice(0, tag.start).split("\n").length - 1,
      message,
      severity,
      ...(fixes?.length ? { fixes } : {}),
    });
  };

  // Duplicate declarations: the index maps name → declaration, so re-declared
  // names silently shadow the first one — surface them instead.
  const DECL_KINDS: Record<string, string> = { concept: "concept", rel: "relationship", concinst: "concept instance" };
  const declared = new Map<string, Set<string>>();
  for (const tag of index.tags) {
    if (tag.closing || !(tag.name in DECL_KINDS) || !tag.attrs.name) continue;
    const seen = declared.get(tag.name) ?? new Set<string>();
    declared.set(tag.name, seen);
    if (seen.has(tag.attrs.name)) {
      add(tag, `Duplicate ${DECL_KINDS[tag.name]}: "${tag.attrs.name}" is already declared in this map`, "warning", [
        removeElementFix(text, index, tag),
      ]);
    } else {
      seen.add(tag.attrs.name);
    }
  }

  for (const tag of index.tags) {
    if (tag.closing) continue;
    const spec = SCHEMA[tag.name];
    if (!spec) {
      if (tag.name !== "xml") add(tag, `Unrecognised element: ${tag.name}`);
      continue;
    }
    for (const required of spec.required) {
      if (!(required in tag.attrs)) {
        const at = tag.end - (tag.selfClosing ? 2 : 1);
        add(tag, `${tag.name} element has missing attribute: ${required}`, "error", [
          { title: `Add ${required}=""`, edits: [{ start: at, end: at, newText: ` ${required}=""` }] },
        ]);
      }
    }
    const known = new Set([...spec.required, ...spec.optional]);
    for (const attr of Object.keys(tag.attrs)) {
      if (!known.has(attr)) {
        const range = attrFullRange(tag, attr);
        add(tag, `${tag.name} element has unrecognised attribute: ${attr}`, "warning", range
          ? [{ title: `Remove ${attr}`, edits: [{ ...range, newText: "" }] }]
          : undefined);
      }
      const allowed = spec.enums?.[attr];
      if (allowed && !allowed.includes(tag.attrs[attr])) {
        const range = attrValueRange(tag, attr);
        add(
          tag,
          `${tag.name} has invalid value for attribute: ${attr}="${tag.attrs[attr]}" (expected one of: ${allowed.join(", ")})`,
          "error",
          range ? allowed.slice(0, 6).map((v) => ({ title: `Change to "${v}"`, edits: [{ ...range, newText: v }] })) : undefined
        );
      }
    }
    checkReferences(tag, index, add);
    checkSemantics(tag, index, add);
  }

  checkNesting(index, add);
  checkRelinsts(text, index, add);
  checkExpressions(index, add);
  checkMutexInstances(index, add);
  checkOrphanConcepts(index, add);
  checkQuestionForms(text, index, add);

  return issues;
}

type AddIssue = (tag: TagOccurrence, message: string, severity?: LintIssue["severity"]) => void;

function checkReferences(tag: TagOccurrence, index: MapIndex, add: AddIssue): void {
  const isVariable = (v: string | undefined) => !!v && v.startsWith("%");

  if (tag.name === "rel") {
    for (const side of ["subject", "object"] as const) {
      const concept = tag.attrs[side];
      if (concept && !index.concepts.has(concept)) {
        add(tag, `Unknown concept in ${side}: "${concept}"`, "error", didYouMean(tag, side, concept, [...index.concepts.keys()]));
      }
    }
    const subjectType = index.concepts.get(tag.attrs.subject ?? "")?.type;
    if (subjectType && subjectType !== "string") {
      add(tag, `Relationship subjects must be string concepts; "${tag.attrs.subject}" is ${subjectType}`);
    }
  }

  if (tag.name === "concinst") {
    const concept = index.concepts.get(tag.attrs.type ?? "");
    if (tag.attrs.type && !concept) {
      add(tag, `Unknown concept type: "${tag.attrs.type}"`, "error", didYouMean(tag, "type", tag.attrs.type, [...index.concepts.keys()]));
    } else if (concept && concept.type !== "string") {
      add(tag, `Concept instances are only valid for string concepts; "${tag.attrs.type}" is ${concept.type}`);
    }
  }

  if (tag.name === "relinst" && tag.attrs.type && !index.relationships.has(tag.attrs.type)) {
    add(tag, `Unknown relationship type: "${tag.attrs.type}"`, "error", didYouMean(tag, "type", tag.attrs.type, [...index.relationships.keys()]));
  }

  if (tag.name === "condition" && tag.attrs.rel && !index.relationships.has(tag.attrs.rel)) {
    add(tag, `Unknown relationship in condition: "${tag.attrs.rel}"`, "error", didYouMean(tag, "rel", tag.attrs.rel, [...index.relationships.keys()]));
  }

  if (tag.name === "relinst") {
    for (const side of ["subject", "object"] as const) {
      const value = tag.attrs[side];
      if (isVariable(value) && value !== "%S" && value !== "%O") {
        add(tag, `Rule headers cannot use custom variables (${value}); only literal instances, %S or %O are allowed`);
      }
    }
  }
}

function checkSemantics(tag: TagOccurrence, _index: MapIndex, add: AddIssue): void {
  if (tag.attrs.cf !== undefined) {
    const cf = Number(tag.attrs.cf);
    if (!Number.isFinite(cf) || cf < 0 || cf > 100) {
      add(tag, `cf must be a number between 0 and 100 (got "${tag.attrs.cf}")`);
    }
  }
  if (tag.name === "relinst" && tag.attrs["minimum-rule-certainty"] !== undefined) {
    const minimum = Number(tag.attrs["minimum-rule-certainty"]);
    const cf = tag.attrs.cf !== undefined ? Number(tag.attrs.cf) : 100;
    if (Number.isFinite(minimum) && minimum > cf) {
      add(tag, `minimum-rule-certainty (${minimum}) must not exceed the rule's cf (${cf})`);
    }
  }
  if (tag.name === "condition" && tag.attrs.expression && tag.attrs.rel) {
    add(tag, "A condition is either a relationship condition (rel/subject/object) or an expression, not both");
  }
  if (tag.name === "condition" && tag.attrs.weight !== undefined) {
    const weight = Number(tag.attrs.weight);
    if (!Number.isFinite(weight) || weight < 0) {
      add(tag, `weight must be a non-negative integer (got "${tag.attrs.weight}")`);
    }
  }
  if (tag.name === "datasource" && tag.attrs.hostname && !/^https?:\/\//.test(tag.attrs.hostname)) {
    add(tag, "datasource hostname must start with http:// or https://");
  }
  const nameLike = tag.attrs.name;
  if (nameLike && /["'\\<>]/.test(nameLike)) {
    add(tag, `Names cannot contain " ' \\ < > characters`);
  }
}

/** Element nesting per the schema's children table, plus mismatched closing tags. */
function checkNesting(index: MapIndex, add: AddIssue): void {
  const stack: string[] = [];
  for (const tag of index.tags) {
    if (tag.name === "xml") continue;
    if (tag.closing) {
      if (stack.length && stack[stack.length - 1] !== tag.name) {
        add(tag, `Mismatched closing tag: expected </${stack[stack.length - 1]}>`);
      }
      // Recover by popping to the matching open tag when one exists.
      const at = stack.lastIndexOf(tag.name);
      if (at >= 0) stack.length = at;
      continue;
    }
    const parent = stack[stack.length - 1];
    const parentSpec = parent ? SCHEMA[parent] : undefined;
    if (parentSpec && SCHEMA[tag.name] && !parentSpec.children.includes(tag.name)) {
      add(tag, `<${tag.name}> is not allowed inside <${parent}> (expected: ${parentSpec.children.join(", ") || "no children"})`);
    }
    if (!tag.selfClosing) stack.push(tag.name);
  }
}

/** Does a literal parse as the concept's primitive type? */
function literalMatchesType(value: string, type: string): boolean {
  switch (type) {
    case "number":
      return /^-?\d+(\.\d+)?$/.test(value);
    case "date":
      return /^\d{4}-\d{2}-\d{2}(T[\d:.]+Z?)?$/.test(value) || /^\d{10,13}$/.test(value);
    case "truth":
      return value === "true" || value === "false";
    default:
      return true;
  }
}

const isVar = (v: string | undefined): boolean => !!v && v.startsWith("%");

/** Group each relinst with its condition tags. */
function eachRelinst(
  index: MapIndex,
  visit: (tag: TagOccurrence, conditions: TagOccurrence[]) => void
): void {
  for (let i = 0; i < index.tags.length; i++) {
    const tag = index.tags[i];
    if (tag.closing || tag.name !== "relinst") continue;
    const conditions: TagOccurrence[] = [];
    if (!tag.selfClosing) {
      for (let j = i + 1; j < index.tags.length; j++) {
        const inner = index.tags[j];
        if (inner.name === "relinst" && inner.closing) break;
        if (inner.name === "condition" && !inner.closing) conditions.push(inner);
      }
    }
    visit(tag, conditions);
  }
}

/**
 * Fact/rule-level checks: fact completeness, duplicate facts, weight sums,
 * subject/object agreement against the relationship's signature (declared
 * instances for string concepts, literal parsing for typed concepts), and
 * single-use custom variables that can never connect.
 */
function checkRelinsts(index: MapIndex, add: AddIssue): void {
  const seenFacts = new Map<string, TagOccurrence>();

  const checkEndpoint = (tag: TagOccurrence, role: "subject" | "object", value: string, conceptName: string) => {
    const concept = index.concepts.get(conceptName);
    if (!concept) return; // the rel declaration already errors on this
    if (concept.type !== "string") {
      if (!literalMatchesType(value, concept.type)) {
        add(tag, `${role} "${value}" is not a valid ${concept.type} (concept "${conceptName}")`);
      }
      return;
    }
    const instance = index.instances.get(value);
    if (!instance) {
      add(tag, `"${value}" is not a declared instance of "${conceptName}" — the fact will attach to nothing until that instance exists`, "warning");
    } else if (instance.type !== conceptName) {
      add(tag, `"${value}" is an instance of "${instance.type}", but ${role} of this relationship must be a "${conceptName}"`, "warning");
    }
  };

  eachRelinst(index, (tag, conditions) => {
    const rel = index.relationships.get(tag.attrs.type ?? "");

    if (conditions.length === 0) {
      // A fact: needs both endpoints, and identical facts are almost certainly a paste error.
      for (const side of ["subject", "object"] as const) {
        if (!tag.attrs[side]) add(tag, `A fact (relinst without conditions) needs a ${side}`);
      }
      if (tag.attrs.subject && tag.attrs.object) {
        const key = `${tag.attrs.type}|${tag.attrs.subject}|${tag.attrs.object}`;
        if (seenFacts.has(key)) {
          add(tag, `Duplicate fact: ${tag.attrs.subject} ${tag.attrs.type} ${tag.attrs.object} is already declared`, "warning");
        } else {
          seenFacts.set(key, tag);
        }
      }
    } else {
      // A rule: explicit weights must not all be zero.
      const weights = conditions.map((c) => (c.attrs.weight !== undefined ? Number(c.attrs.weight) : 100));
      if (weights.every((w) => w === 0)) {
        add(tag, "Every condition has weight 0 — this rule can never contribute any certainty");
      }

      // Custom variables must appear at least twice across the rule's conditions to connect.
      const counts = new Map<string, number>();
      for (const c of conditions) {
        for (const attr of ["subject", "object", "expression", "value"] as const) {
          for (const m of (c.attrs[attr] ?? "").matchAll(/%([A-Z][A-Z0-9_]*)/g)) {
            if (m[1] === "S" || m[1] === "O") continue;
            counts.set(m[1], (counts.get(m[1]) ?? 0) + 1);
          }
        }
      }
      for (const [name, count] of counts) {
        if (count === 1) {
          add(tag, `Variable %${name} appears only once in this rule — it binds nothing and can never connect conditions`, "warning");
        }
      }
    }

    // Endpoint agreement for the head (facts and literal rule heads alike).
    if (rel) {
      for (const [side, conceptName] of [["subject", rel.subject], ["object", rel.object]] as const) {
        const value = tag.attrs[side];
        if (value && !isVar(value)) checkEndpoint(tag, side, value, conceptName);
      }
    }

    // Endpoint agreement inside relationship conditions.
    for (const c of conditions) {
      const condRel = index.relationships.get(c.attrs.rel ?? "");
      if (!condRel) continue;
      for (const [side, conceptName] of [["subject", condRel.subject], ["object", condRel.object]] as const) {
        const value = c.attrs[side];
        if (value && !isVar(value)) checkEndpoint(c, side, value, conceptName);
      }
    }
  });
}

const KNOWN_FUNCTIONS = new Set(EXPRESSION_FUNCTIONS.map((f) => f.name));

/** Expression sanity: only engine functions exist; parens and quotes must balance. */
function checkExpressions(index: MapIndex, add: AddIssue): void {
  for (const tag of index.tags) {
    if (tag.closing || tag.name !== "condition" || !tag.attrs.expression) continue;
    const expression = tag.attrs.expression;

    // Strip single-quoted string literals before structural checks.
    const stripped = expression.replace(/'[^']*'/g, "''");
    if ((expression.match(/'/g)?.length ?? 0) % 2 !== 0) {
      add(tag, "Unbalanced single quote in expression");
    }
    let depth = 0;
    for (const ch of stripped) {
      if (ch === "(") depth++;
      if (ch === ")") depth--;
      if (depth < 0) break;
    }
    if (depth !== 0) add(tag, "Unbalanced parentheses in expression");

    for (const m of stripped.matchAll(/([A-Za-z_][A-Za-z0-9_]*)\s*\(/g)) {
      if (!KNOWN_FUNCTIONS.has(m[1])) {
        add(tag, `Unknown expression function: ${m[1]} (the engine supports exactly ${KNOWN_FUNCTIONS.size} functions)`);
      }
    }
  }
}

/** Mutually-exclusive concepts model a binary choice — exactly two instances. */
function checkMutexInstances(index: MapIndex, add: AddIssue): void {
  for (const tag of index.tags) {
    if (tag.closing || tag.name !== "concept") continue;
    if (!["mutually-exclusive", "mutex", "mx"].includes(tag.attrs.behaviour ?? "")) continue;
    const count = [...index.instances.values()].filter((i) => i.type === tag.attrs.name).length;
    if (count !== 2) {
      add(tag, `Mutually-exclusive concept "${tag.attrs.name}" should declare exactly 2 instances (found ${count})`, "warning");
    }
  }
}

/** A concept no relationship touches can never take part in reasoning. */
function checkOrphanConcepts(index: MapIndex, add: AddIssue): void {
  const used = new Set<string>();
  for (const rel of index.relationships.values()) {
    used.add(rel.subject);
    used.add(rel.object);
  }
  for (const tag of index.tags) {
    if (tag.closing || tag.name !== "concept" || !tag.attrs.name) continue;
    if (!used.has(tag.attrs.name)) {
      add(tag, `Concept "${tag.attrs.name}" is not used by any relationship`, "info");
    }
  }
}

/**
 * Question wording: firstForm confirms a known subject AND object, so it
 * should mention both; each second form asks FOR one side given the other.
 */
function checkQuestionForms(text: string, index: MapIndex, add: AddIssue): void {
  const EXPECT: Record<string, { need: string; needName: string; avoid: string; avoidWhy: string }> = {
    firstForm: { need: "", needName: "", avoid: "", avoidWhy: "" }, // handled separately below
    secondFormObject: { need: "%S", needName: "the subject", avoid: "%O", avoidWhy: "the object is what this question asks for" },
    secondFormSubject: { need: "%O", needName: "the object", avoid: "%S", avoidWhy: "the subject is what this question asks for" },
  };
  for (let i = 0; i < index.tags.length; i++) {
    const tag = index.tags[i];
    if (tag.closing || tag.selfClosing || !(tag.name in EXPECT)) continue;
    const close = index.tags
      .slice(i + 1)
      .find((t) => t.closing && t.name === tag.name);
    if (!close) continue;
    const wording = text.slice(tag.end, close.start);
    const has = (p: string) => new RegExp(`${p}\\b`).test(wording);

    if (tag.name === "firstForm") {
      if (!has("%S") || !has("%O")) {
        add(tag, "firstForm is asked when both sides are known — include %S and %O so the question reads naturally", "warning");
      }
      continue;
    }
    const rule = EXPECT[tag.name];
    if (!has(rule.need)) {
      add(tag, `${tag.name} should mention ${rule.needName} (${rule.need}) so the user knows what the question is about`, "warning");
    }
    if (has(rule.avoid)) {
      add(tag, `${tag.name} should not contain ${rule.avoid} — ${rule.avoidWhy}`, "warning");
    }
  }
}
