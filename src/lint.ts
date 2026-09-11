/**
 * Structural + referential diagnostics for RBLang documents — the editor-agnostic core.
 *
 * Mirrors what Studio's validator and rblint check, reimplemented from the
 * documented RBLang reference: lexical problems (malformed or duplicate
 * attributes, unbalanced quotes, stray text), unknown elements/attributes,
 * missing or empty required attributes, invalid enum values, references to
 * undeclared concepts and relationships, and a set of semantic footguns
 * (non-string subjects, cf out of range, minimum-rule-certainty above cf,
 * datasource inputs of the wrong concept, ...).
 *
 * No VS Code import here: `collectIssues` runs on assistant-generated RBLang
 * before it is offered and under plain node in the unit tests. diagnostics.ts
 * adapts it to the editor.
 */
import { SCHEMA, EXPRESSION_FUNCTIONS, LEGACY_VALUES } from "./schema";
import {
  buildIndex,
  maskNonMarkup,
  instanceTypes,
  instancesOf,
  MapIndex,
  TagOccurrence,
  attrValueRange,
  attrFullRange,
} from "./mapIndex";
import { analyseExpression } from "./expressions";

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

/** Attributes that may legitimately be empty. Every other empty value is an error, as in Studio ("Please specify …"). */
const EMPTY_ALLOWED: Record<string, string[]> = { datasource: ["path"] };

/** Lint arbitrary RBLang text (used on assistant-generated code before it is offered). */
export function collectIssues(text: string): LintIssue[] {
  const index = buildIndex(text);
  const issues: LintIssue[] = [];

  const lineStarts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === "\n") lineStarts.push(i + 1);
  const lineOf = (offset: number): number => {
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lineStarts[mid] <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  };

  const addAt: AddAt = (start, end, message, severity = "error", fixes) => {
    issues.push({ start, end, line: lineOf(start), message, severity, ...(fixes?.length ? { fixes } : {}) });
  };
  const add: AddIssue = (tag, message, severity = "error", fixes) => addAt(tag.start, tag.end, message, severity, fixes);

  // Lexical problems met while tokenising (malformed / duplicate attributes, runaway quotes).
  for (const p of index.problems) addAt(p.start, p.end, p.message, "error", p.fix ? [p.fix] : undefined);

  // Duplicate declarations: the index maps name → declaration, so re-declared
  // names silently shadow the first one — surface them instead. Concepts and
  // relationships are errors (Studio rejects them); an instance is identified
  // by name AND concept, so only an exact repeat is a duplicate, and a warning.
  const declared = new Set<string>();
  for (const tag of index.tags) {
    if (tag.closing || tag.malformed || !tag.attrs.name) continue;
    if (tag.name === "concept" || tag.name === "rel") {
      const key = `${tag.name}\u0000${tag.attrs.name}`;
      if (declared.has(key)) {
        const kind = tag.name === "concept" ? "concept" : "relationship";
        add(tag, `Duplicate ${kind}: "${tag.attrs.name}" is already declared in this map`, "error", [removeElementFix(text, index, tag)]);
      } else {
        declared.add(key);
      }
    } else if (tag.name === "concinst") {
      const key = `concinst\u0000${tag.attrs.type ?? ""}\u0000${tag.attrs.name}`;
      if (declared.has(key)) {
        add(tag, `Duplicate concept instance: "${tag.attrs.name}" of "${tag.attrs.type ?? ""}" is already declared in this map`, "warning", [
          removeElementFix(text, index, tag),
        ]);
      } else {
        declared.add(key);
      }
    }
  }

  for (const tag of index.tags) {
    if (tag.closing) continue;
    const spec = SCHEMA[tag.name];
    if (!spec) {
      if (tag.name !== "xml") add(tag, `Unrecognised element: ${tag.name}`);
      continue;
    }
    if (tag.malformed) continue; // the lexical error is the one that matters; its attributes are not trustworthy
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
      const value = tag.attrs[attr];
      if (!known.has(attr)) {
        const range = attrFullRange(tag, attr);
        add(tag, `${tag.name} element has unrecognised attribute: ${attr}`, "warning", range
          ? [{ title: `Remove ${attr}`, edits: [{ ...range, newText: "" }] }]
          : undefined);
        continue;
      }
      if (value === "" && !EMPTY_ALLOWED[tag.name]?.includes(attr)) {
        const range = attrFullRange(tag, attr);
        addAt(range?.start ?? tag.start, range?.end ?? tag.end, `${tag.name} element has empty attribute: ${attr}`);
        continue;
      }
      const preferred = LEGACY_VALUES[tag.name]?.[attr]?.[value];
      if (preferred) {
        const range = attrValueRange(tag, attr);
        add(tag, `${tag.name} ${attr}="${value}" is a legacy spelling of "${preferred}"`, "info", range
          ? [{ title: `Change to "${preferred}"`, edits: [{ start: range.start, end: range.end, newText: preferred }] }]
          : undefined);
        continue;
      }
      const allowed = spec.enums?.[attr];
      if (allowed && !allowed.includes(value)) {
        const range = attrValueRange(tag, attr);
        add(
          tag,
          `${tag.name} has invalid value for attribute: ${attr}="${value}" (expected one of: ${allowed.join(", ")})`,
          "error",
          range ? allowed.slice(0, 6).map((v) => ({ title: `Change to "${v}"`, edits: [{ ...range, newText: v }] })) : undefined
        );
      }
    }
    checkReferences(tag, index, add);
    checkSemantics(tag, index, add);
  }

  checkStrayText(text, index, addAt);
  checkNesting(index, add);
  checkRelinsts(text, index, add);
  checkDatasourceInputs(index, add);
  checkExpressions(index, add);
  checkMutexInstances(index, add);
  checkOrphanConcepts(index, add);
  checkQuestionForms(text, index, add);
  checkEvaluationOrder(index, add);
  checkReachability(index, add);
  checkCycles(index, add);

  return issues;
}

type AddIssue = (tag: TagOccurrence, message: string, severity?: LintIssue["severity"], fixes?: LintFix[]) => void;
type AddAt = (start: number, end: number, message: string, severity?: LintIssue["severity"], fixes?: LintFix[]) => void;

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

  if (tag.name === "input" && tag.attrs.rel && !index.relationships.has(tag.attrs.rel)) {
    add(tag, `Unknown relationship in datasource input: "${tag.attrs.rel}"`, "error", didYouMean(tag, "rel", tag.attrs.rel, [...index.relationships.keys()]));
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
  if (tag.attrs.cf !== undefined && tag.attrs.cf !== "") {
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
  if (tag.name === "condition" && tag.attrs.weight !== undefined && tag.attrs.weight !== "") {
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

/**
 * Text where none is allowed: between elements whose schema has no text
 * content, before the root element, after it, or a "<" that never became a
 * tag (the usual symptom of an unbalanced quote or a missing ">"). Comments
 * and CDATA are masked out first, so their contents never count.
 */
function checkStrayText(text: string, index: MapIndex, addAt: AddAt): void {
  const masked = maskNonMarkup(text);
  const stack: string[] = [];
  let cursor = 0;

  const report = (from: number, to: number) => {
    const segment = masked.slice(from, to);
    const first = segment.search(/\S/);
    if (first < 0) return;
    const start = from + first;
    const end = from + segment.trimEnd().length;
    const raw = text.slice(start, end).replace(/\s+/g, " ");
    const snippet = raw.length > 40 ? raw.slice(0, 40) + "…" : raw;
    if (text[start] === "<") {
      addAt(start, end, `Malformed element: "${snippet}" could not be parsed — check for unbalanced quotes or a missing ">"`);
    } else {
      addAt(start, end, `Unexpected text outside an element: "${snippet}"`);
    }
  };

  for (const tag of index.tags) {
    const parent = stack[stack.length - 1];
    const allowsText = parent !== undefined && (SCHEMA[parent]?.text ?? true);
    if (!allowsText) report(cursor, tag.start);
    cursor = tag.end;
    if (tag.closing) {
      const at = stack.lastIndexOf(tag.name);
      if (at >= 0) stack.length = at;
    } else if (!tag.selfClosing) {
      stack.push(tag.name);
    }
  }
  report(cursor, masked.length);
}

/** Element nesting per the schema's children table, plus mismatched, orphan and missing closing tags. */
function checkNesting(index: MapIndex, add: AddIssue): void {
  const stack: TagOccurrence[] = [];
  for (const tag of index.tags) {
    if (tag.name === "xml") continue;
    if (tag.closing) {
      const top = stack[stack.length - 1];
      if (top && top.name !== tag.name) {
        add(tag, `Mismatched closing tag: expected </${top.name}>`);
      } else if (!top) {
        add(tag, `Unexpected closing tag </${tag.name}>: no element is open`);
      }
      // Recover by popping to the matching open tag when one exists.
      let at = -1;
      for (let i = stack.length - 1; i >= 0; i--) {
        if (stack[i].name === tag.name) {
          at = i;
          break;
        }
      }
      if (at >= 0) stack.length = at;
      continue;
    }
    const parent = stack[stack.length - 1]?.name;
    const parentSpec = parent ? SCHEMA[parent] : undefined;
    if (parentSpec && SCHEMA[tag.name] && !parentSpec.children.includes(tag.name)) {
      add(tag, `<${tag.name}> is not allowed inside <${parent}> (expected: ${parentSpec.children.join(", ") || "no children"})`);
    }
    if (!tag.selfClosing) stack.push(tag);
  }
  for (const open of stack) add(open, `Unclosed element <${open.name}>: missing </${open.name}>`);
}

/**
 * Does a literal satisfy the engine's rules for the concept's primitive type?
 * The platform's importer is the authority here, and it is stricter than
 * Studio's linter: dates are ISO-8601 (YYYY-MM-DD, optional time) or epoch
 * milliseconds; truth values are exactly `true` or `false`; numbers are
 * anything Number() accepts within ±999,999,999,999,999 (15 digits).
 */
export const NUMBER_LIMIT = 999999999999999;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:?\d{2})?)?$/;
const EPOCH_MS_RE = /^\d{1,13}$/;

export function literalMatchesType(value: string, type: string): boolean {
  switch (type) {
    case "number": {
      const n = value.trim() === "" ? NaN : Number(value);
      return Number.isFinite(n) && Math.abs(n) <= NUMBER_LIMIT;
    }
    case "date":
      return EPOCH_MS_RE.test(value) || (ISO_DATE_RE.test(value) && !Number.isNaN(Date.parse(value)));
    case "truth":
    case "boolean":
      return value === "true" || value === "false";
    default:
      return true;
  }
}

/** The platform's own wording for a rejected literal, followed by what it does accept. */
function literalMessage(rel: string, role: string, value: string, type: string): string {
  switch (type) {
    case "date":
      return `Relationship "${rel}" expects a date as its ${role} (got "${value}"): use YYYY-MM-DD, an ISO-8601 date-time, or epoch milliseconds`;
    case "truth":
    case "boolean":
      return `Relationship "${rel}" must have true or false as its ${role} (got "${value}"): lower-case, no other spellings`;
    default:
      return `Relationship "${rel}" expects a number as its ${role} (got "${value}"): up to 15 digits, magnitude at most ${NUMBER_LIMIT}`;
  }
}

const isVar = (v: string | undefined): boolean => !!v && v.startsWith("%");

/** Group each relinst with its condition tags. Malformed tags are skipped: their attributes are not trustworthy. */
function eachRelinst(
  index: MapIndex,
  visit: (tag: TagOccurrence, conditions: TagOccurrence[]) => void
): void {
  for (let i = 0; i < index.tags.length; i++) {
    const tag = index.tags[i];
    if (tag.closing || tag.name !== "relinst" || tag.malformed) continue;
    const conditions: TagOccurrence[] = [];
    if (!tag.selfClosing) {
      for (let j = i + 1; j < index.tags.length; j++) {
        const inner = index.tags[j];
        if (inner.name === "relinst" && inner.closing) break;
        if (inner.name === "condition" && !inner.closing && !inner.malformed) conditions.push(inner);
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
function checkRelinsts(text: string, index: MapIndex, add: AddIssue): void {
  const seenFacts = new Map<string, TagOccurrence>();

  const checkEndpoint = (tag: TagOccurrence, role: "subject" | "object", value: string, conceptName: string, relName: string) => {
    const concept = index.concepts.get(conceptName);
    if (!concept) return; // the rel declaration already errors on this
    if (concept.type !== "string") {
      if (!literalMatchesType(value, concept.type)) add(tag, literalMessage(relName, role, value, concept.type));
      return;
    }
    const types = instanceTypes(index, value);
    if (types.length === 0) {
      const fixes = [
        ...(!/["'\\<>]/.test(value) ? [declareInstanceFix(index, value, conceptName)] : []),
        ...didYouMean(tag, role, value, instancesOf(index, conceptName)),
      ].filter((f): f is LintFix => !!f);
      add(tag, `"${value}" is not a declared instance of "${conceptName}" — the fact will attach to nothing until that instance exists`, "warning", fixes);
    } else if (!types.includes(conceptName)) {
      const declaredAs = types.map((t) => `"${t}"`).join(" / ");
      add(
        tag,
        `"${value}" is an instance of ${declaredAs}, but ${role} of this relationship must be a "${conceptName}"`,
        "warning",
        [declareInstanceFix(index, value, conceptName), ...didYouMean(tag, role, value, instancesOf(index, conceptName))].filter(
          (f): f is LintFix => !!f
        )
      );
    }
  };

  eachRelinst(index, (tag, conditions) => {
    const rel = index.relationships.get(tag.attrs.type ?? "");

    if (conditions.length === 0) {
      // A fact: needs both endpoints, and identical facts are almost certainly a paste error.
      for (const side of ["subject", "object"] as const) {
        if (!(side in tag.attrs)) add(tag, `A fact (relinst without conditions) needs a ${side}`); // present-but-empty is already reported
      }
      if (tag.attrs.subject && tag.attrs.object) {
        const key = `${tag.attrs.type}|${tag.attrs.subject}|${tag.attrs.object}`;
        if (seenFacts.has(key)) {
          add(tag, `Duplicate fact: ${tag.attrs.subject} ${tag.attrs.type} ${tag.attrs.object} is already declared`, "warning", [
            removeElementFix(text, index, tag),
          ]);
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
        if (value && !isVar(value)) checkEndpoint(tag, side, value, conceptName, tag.attrs.type ?? "");
      }
    }

    // Endpoint agreement inside relationship conditions.
    for (const c of conditions) {
      const condRel = index.relationships.get(c.attrs.rel ?? "");
      if (!condRel) continue;
      for (const [side, conceptName] of [["subject", condRel.subject], ["object", condRel.object]] as const) {
        const value = c.attrs[side];
        if (value && !isVar(value)) checkEndpoint(c, side, value, conceptName, c.attrs.rel ?? "");
      }
    }
  });
}

/**
 * Datasource inputs: %S is the instance of the datasource's concept being
 * looked up, so an input that binds %S as the subject or object of a
 * relationship must name a relationship whose side is that concept.
 */
function checkDatasourceInputs(index: MapIndex, add: AddIssue): void {
  const stack: TagOccurrence[] = [];
  const enclosing = (name: string): TagOccurrence | undefined => {
    for (let i = stack.length - 1; i >= 0; i--) if (stack[i].name === name) return stack[i];
    return undefined;
  };
  for (const tag of index.tags) {
    if (tag.closing) {
      for (let i = stack.length - 1; i >= 0; i--) {
        if (stack[i].name === tag.name) {
          stack.length = i;
          break;
        }
      }
      continue;
    }
    if (tag.name === "input" && tag.attrs.rel && !tag.malformed) {
      const concept = enclosing("datasource") ? enclosing("concept")?.attrs.name : undefined;
      const rel = index.relationships.get(tag.attrs.rel);
      if (concept && rel) {
        for (const [side, expected] of [["subject", rel.subject], ["object", rel.object]] as const) {
          if (tag.attrs[side] === "%S" && expected && expected !== concept) {
            add(tag, `Datasource input: %S is a "${concept}" (this datasource's concept), but the ${side} of "${tag.attrs.rel}" must be a "${expected}"`);
          }
        }
      }
    }
    if (!tag.selfClosing) stack.push(tag);
  }
}

const KNOWN_FUNCTIONS = new Set(EXPRESSION_FUNCTIONS.map((f) => f.name));

/**
 * Words that may legitimately precede "(" without being a function call: the
 * logical operators and the natural-language comparison aliases, e.g.
 * `%A > 1 and (%B < 2 or %C < 3)` or `%X is equal to (%Y + 1)`.
 */
const EXPRESSION_KEYWORDS = new Set(["and", "or", "is", "equal", "to", "not", "greater", "less", "than", "equals", "does", "gt", "gte", "lt", "lte"]);

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
      if (EXPRESSION_KEYWORDS.has(m[1].toLowerCase())) continue;
      if (!KNOWN_FUNCTIONS.has(m[1])) {
        add(tag, `Unknown expression function: ${m[1]} (the engine supports exactly ${KNOWN_FUNCTIONS.size} functions)`);
      }
    }
  }
}

/** Mutually-exclusive concepts model a binary choice — exactly two instances. */
function checkMutexInstances(index: MapIndex, add: AddIssue): void {
  for (const tag of index.tags) {
    if (tag.closing || tag.malformed || tag.name !== "concept" || !tag.attrs.name) continue;
    if (!["mutually-exclusive", "mutex", "mx"].includes(tag.attrs.behaviour ?? "")) continue;
    const count = instancesOf(index, tag.attrs.name).length;
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
    if (tag.closing || tag.malformed || tag.name !== "concept" || !tag.attrs.name) continue;
    if (!used.has(tag.attrs.name)) {
      add(tag, `Concept "${tag.attrs.name}" is not used by any relationship`, "info");
    }
  }
}

/**
 * Left-to-right arithmetic: the engine has no operator precedence, so
 * `%A + %B * 2` is `(%A + %B) * 2`. Warn on every chain where that differs
 * from the conventional reading and offer both explicit forms as fixes.
 */
function checkEvaluationOrder(index: MapIndex, add: AddIssue): void {
  for (const tag of index.tags) {
    if (tag.closing || tag.name !== "condition" || !tag.attrs.expression) continue;
    const range = attrValueRange(tag, "expression");
    if (!range) continue;
    for (const chain of analyseExpression(tag.attrs.expression)) {
      if (!chain.mixed) continue;
      const start = range.start + chain.start;
      const end = range.start + chain.end;
      add(
        tag,
        `Expressions evaluate strictly left to right (no operator precedence): "${chain.text}" is computed as ${chain.leftToRight}, not ${chain.conventional}. Add parentheses to make the intended order explicit`,
        "warning",
        [
          { title: `Keep the engine's order: ${chain.leftToRight}`, edits: [{ start, end, newText: chain.leftToRight }] },
          { title: `Use conventional precedence: ${chain.conventional}`, edits: [{ start, end, newText: chain.conventional }] },
        ]
      );
    }
  }
}

/** A relationship is askable unless it says otherwise (askable="none" / legacy "false"). */
function isAskable(relTag: TagOccurrence): boolean {
  const askable = relTag.attrs.askable ?? "all";
  return askable !== "none" && askable !== "false";
}

/**
 * Reachability: in a conversational map, a relationship with no facts, no
 * rules, no question and no datasource can only ever be satisfied by injected
 * facts — so every mandatory condition on it, and every rule behind such a
 * condition, is dead in a live session. This is the static half of the docs'
 * "why did I get no result?" troubleshooting page.
 *
 * Skipped for headless maps (nothing askable → everything arrives by
 * injection by design) and for maps with <import>s (linked maps may supply
 * the missing facts or rules).
 */
function checkReachability(index: MapIndex, add: AddIssue): void {
  const relTags = index.tags.filter((t) => !t.closing && t.name === "rel" && t.attrs.name);
  if (!relTags.some(isAskable)) return;
  if (index.tags.some((t) => !t.closing && t.name === "import")) return;

  const hasFact = new Set<string>();
  const hasRule = new Set<string>();
  eachRelinst(index, (tag, conditions) => {
    if (!tag.attrs.type) return;
    (conditions.length ? hasRule : hasFact).add(tag.attrs.type);
  });
  const hasDatasource = new Set<string>();
  for (const tag of index.tags) {
    if (tag.closing || tag.name !== "action" || !tag.attrs.map) continue;
    const eq = tag.attrs.map.indexOf("=");
    if (eq > 0) hasDatasource.add(tag.attrs.map.slice(0, eq).trim());
  }

  const injectOnly = new Set<string>();
  for (const relTag of relTags) {
    const name = relTag.attrs.name;
    if (isAskable(relTag) || hasFact.has(name) || hasRule.has(name) || hasDatasource.has(name)) continue;
    injectOnly.add(name);
    add(
      relTag,
      `"${name}" can only be satisfied by injected facts: it has no facts, no rules, askable="none" and no datasource maps to it. In a conversational session, conditions on it can never be met`,
      "warning"
    );
  }
  if (!injectOnly.size) return;

  eachRelinst(index, (tag, conditions) => {
    if (!conditions.length) return;
    const blockers = conditions
      .filter((c) => c.attrs.rel && injectOnly.has(c.attrs.rel) && c.attrs.behaviour !== "optional")
      .map((c) => `"${c.attrs.rel}"`);
    if (!blockers.length) return;
    const unique = [...new Set(blockers)];
    add(
      tag,
      `This rule can never fire without injected facts: its mandatory condition${unique.length > 1 ? "s" : ""} on ${unique.join(", ")} can never be satisfied (make the condition optional, add facts or rules, or make the relationship askable)`,
      "warning"
    );
  });
}

/**
 * Rule recursion: a relationship that (transitively) depends on itself is
 * legal — transitive "is in" chains are the classic use — but unbounded
 * recursion is what hits the engine's query-depth limit. Surface each
 * recursive rule as a hint with the cycle it closes.
 */
function checkCycles(index: MapIndex, add: AddIssue): void {
  const deps = new Map<string, Set<string>>();
  eachRelinst(index, (tag, conditions) => {
    if (!conditions.length || !tag.attrs.type) return;
    const set = deps.get(tag.attrs.type) ?? new Set<string>();
    for (const c of conditions) if (c.attrs.rel) set.add(c.attrs.rel);
    deps.set(tag.attrs.type, set);
  });
  if (!deps.size) return;

  /** Shortest path from → to over the dependency graph, or undefined. */
  const pathTo = (from: string, to: string): string[] | undefined => {
    const queue: string[][] = [[from]];
    const seen = new Set<string>([from]);
    while (queue.length) {
      const path = queue.shift()!;
      const last = path[path.length - 1];
      if (last === to && path.length > 1) return path;
      for (const next of deps.get(last) ?? []) {
        if (next === to) return [...path, next];
        if (!seen.has(next)) {
          seen.add(next);
          queue.push([...path, next]);
        }
      }
    }
    return undefined;
  };

  eachRelinst(index, (tag, conditions) => {
    if (!conditions.length || !tag.attrs.type) return;
    const head = tag.attrs.type;
    for (const c of conditions) {
      if (!c.attrs.rel) continue;
      const path = c.attrs.rel === head ? [head] : pathTo(c.attrs.rel, head);
      if (!path) continue;
      const chain = [head, ...path].map((r) => `"${r}"`).join(" → ");
      add(
        tag,
        `Recursive rule: ${chain}. Recursion is legal, but unbounded recursion hits the engine's query-depth limit — make sure a base case (a fact, an answer or a datasource) terminates it`,
        "info"
      );
      break; // one hint per rule is enough
    }
  });
}

// ---------------------------------------------------------------------------
// Fix builders

/** "Change to …" fixes for near-miss names: exact case-insensitive first, then edit distance ≤ 2. */
function didYouMean(tag: TagOccurrence, attr: string, value: string, candidates: string[]): LintFix[] {
  const range = attrValueRange(tag, attr);
  if (!range) return [];
  const lower = value.toLowerCase();
  return candidates
    .filter((c) => c !== value)
    .map((c) => ({ c, d: c.toLowerCase() === lower ? 0 : levenshtein(c.toLowerCase(), lower) }))
    .filter(({ d }) => d <= 2)
    .sort((a, b) => a.d - b.d)
    .slice(0, 3)
    .map(({ c }) => ({ title: `Change to "${c}"`, edits: [{ start: range.start, end: range.end, newText: c }] }));
}

/** Insert a concinst declaration after the last instance (or concept, or the root open tag). */
function declareInstanceFix(index: MapIndex, name: string, conceptName: string): LintFix | undefined {
  const anchor =
    [...index.tags].reverse().find((t) => !t.closing && t.name === "concinst") ??
    [...index.tags].reverse().find((t) => !t.closing && t.name === "concept") ??
    index.tags.find((t) => !t.closing && t.name === "rbl:kb");
  if (!anchor) return undefined;
  return {
    title: `Declare <concinst name="${name}" type="${conceptName}"/>`,
    edits: [{ start: anchor.end, end: anchor.end, newText: `\n\t<concinst name="${name}" type="${conceptName}"/>` }],
  };
}

/** Delete an element's full lines (open tag through matching close for containers). */
function removeElementFix(text: string, index: MapIndex, tag: TagOccurrence): LintFix {
  let endOffset = tag.end;
  if (!tag.selfClosing && !tag.closing) {
    let depth = 0;
    for (const t of index.tags.slice(index.tags.indexOf(tag) + 1)) {
      if (t.name !== tag.name) continue;
      if (t.closing) {
        if (depth === 0) {
          endOffset = t.end;
          break;
        }
        depth--;
      } else if (!t.selfClosing) {
        depth++;
      }
    }
  }
  const lineStart = text.lastIndexOf("\n", tag.start - 1) + 1;
  const lineEnd = text.indexOf("\n", endOffset);
  return {
    title: "Remove this declaration",
    edits: [{ start: lineStart, end: lineEnd === -1 ? text.length : lineEnd + 1, newText: "" }],
  };
}

function levenshtein(a: string, b: string): number {
  if (Math.abs(a.length - b.length) > 2) return 3; // early out — we only care about d ≤ 2
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0]++;
    for (let j = 1; j <= b.length; j++) {
      const next = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = row[j];
      row[j] = next;
    }
  }
  return row[b.length];
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
