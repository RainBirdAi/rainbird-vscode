/**
 * JSON schemas for every assistant tool plus a small validator. The model's
 * tool inputs are validated here before a tool runs: with eager input
 * streaming the SDK can hand back a truncated or malformed object, and an
 * invalid input must become an error result, never an exception. No vscode
 * import, so the schemas and validator are unit-tested under plain node.
 */

export interface JsonSchema {
  type?: string | string[];
  description?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: boolean;
  items?: JsonSchema;
  enum?: unknown[];
  minimum?: number;
  maximum?: number;
}

const str = (description: string): JsonSchema => ({ type: "string", description });
const num = (description: string): JsonSchema => ({ type: "number", description });
const bool = (description: string): JsonSchema => ({ type: "boolean", description });
const obj = (properties: Record<string, JsonSchema>, required: string[] = []): JsonSchema => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});

export const ELEMENT_KINDS = ["concept", "rel", "concinst", "fact", "rule"] as const;
export const SELECTOR_KINDS = [...ELEMENT_KINDS, "relinst", "any"] as const;

const SELECTOR: JsonSchema = obj({
  kind: { type: "string", enum: [...SELECTOR_KINDS], description: "Element kind. fact = relinst without conditions, rule = relinst with conditions, relinst = either, any = no filter." },
  name: str("name attribute (concept, rel, concinst) or rule name"),
  rel: str("Relationship name: the type of a fact/rule, or the name of a rel"),
  subject: str("subject attribute (facts, rules)"),
  object: str("object attribute (facts, rules)"),
  type: str("type attribute of a concinst (its concept)"),
  line: { type: "integer", description: "1-based line where the element's opening tag starts. Selects any tag on that line, including conditions and question forms.", minimum: 1 },
});

const OPERATION: JsonSchema = obj(
  {
    op: { type: "string", enum: ["insert_element", "replace_element", "delete_element", "set_attribute", "replace_text"], description: "Operation type" },
    kind: { type: "string", enum: [...ELEMENT_KINDS], description: "insert_element: kind of element being inserted" },
    xml: str("insert_element / replace_element: the RBLang for one or more complete top-level elements"),
    after: { ...SELECTOR, description: "insert_element: place the new element right after this one (default: the correct section for its kind)" },
    selector: { ...SELECTOR, description: "replace_element / delete_element / set_attribute: which element" },
    attr: str("set_attribute: attribute name"),
    value: { type: ["string", "null"], description: "set_attribute: new value, or null to remove the attribute" },
    old_text: str("replace_text: exact text to find (must occur exactly once)"),
    new_text: str("replace_text: replacement text"),
  },
  ["op"]
);

const ANSWER_ITEM: JsonSchema = obj({
  relationship: str("Relationship of the question being answered — answers are matched to the pending questions by relationship, then subject/object"),
  subject: str("Subject of the question being answered; for a second-form subject question, the answer itself (an instance name)"),
  object: {
    type: ["string", "number", "boolean"],
    description:
      "For a second-form object question, the answer: an instance name, a plain number, true/false for a truth question, or a date as YYYY-MM-DD (see the question's `expected`). For first-form and subject questions, the question's object.",
  },
  answer: { type: "string", enum: ["yes", "no"], description: "Answer to a first-form question" },
  certainty: num("Certainty 1-100 attached to the answer"),
  unanswered: bool(
    "true to skip the question. Accepted only when the question has allowUnknown or knownAnswers (its canSkip); with knownAnswers it means \"no more\" and the known answers are kept. Send the triple that identifies the question (relationship plus subject for an object question, object for a subject question) and no value — the question's skipHint shows it."
  ),
});

const FACT_ITEM: JsonSchema = obj(
  {
    subject: str("Subject instance"),
    relationship: str("Relationship name"),
    object: { type: ["string", "number", "boolean"], description: "Object value" },
    certainty: num("Certainty 1-100 (default 100)"),
  },
  ["subject", "relationship", "object"]
);

export const TOOL_SCHEMAS: Record<string, JsonSchema> = {
  get_map_overview: obj({}),
  read_map: obj({
    start_line: { type: "integer", description: "First line to read (1-based)", minimum: 1 },
    end_line: { type: "integer", description: "Last line to read (inclusive)", minimum: 1 },
    element: { ...SELECTOR, description: "Read one element instead of a line range" },
  }),
  get_diagnostics: obj({
    severity: { type: "string", enum: ["error", "warning", "all"], description: "Which findings to return (default all)" },
  }),
  edit_map: obj(
    {
      operations: { type: "array", items: OPERATION, description: "Operations applied in order, atomically" },
    },
    ["operations"]
  ),
  create_map: obj(
    {
      xml: str("Complete RBLang document"),
      file_name: str("File name such as eligibility.rbl to create in the workspace; omit for an untitled document"),
    },
    ["xml"]
  ),
  lint_rblang: obj(
    {
      rblang: str("RBLang to check"),
      mode: { type: "string", enum: ["map", "snippet"], description: "map: a complete document. snippet: one or more elements checked in the context of the open map." },
    },
    ["rblang", "mode"]
  ),
  run_query: obj(
    {
      kmId: str("Knowledge map ID. Omit to use the map this file is bound to (opened, pulled, pushed or bound by Knowledge Map ID), else rainbird.knowledgeMapId."),
      relationship: str("Goal relationship to query"),
      subject: str("Goal subject (give a subject, an object or both)"),
      object: str("Goal object (give a subject, an object or both; with a subject it asks how certain that exact fact is)"),
      version: num("Published version number to run against instead of the draft"),
      sessionId: str("Continue an existing session: skip start/inject/query and feed answers to its pending question(s)"),
      facts: { type: "array", items: FACT_ITEM, description: "Facts to inject before querying" },
      answers: {
        type: "array",
        items: ANSWER_ITEM,
        description: "Answers for the engine's questions, matched to each question by relationship (and subject/object); a question group is answered together, a plural question takes one entry per value",
      },
    },
    ["relationship"]
  ),
  push_map: obj(
    {
      rblang: str("RBLang to push. Omit to push the open map as it currently stands."),
      name: str("Plain-text map name (letters, numbers, spaces)"),
      description: str("Plain-text description"),
    },
    ["name", "description"]
  ),
  semantic_diff: obj(
    {
      against: {
        type: "string",
        enum: ["turn-start", "git-head", "pushed-snapshot", "text"],
        description:
          "What to compare the open map with: turn-start (as it was when this turn began), git-head (the last commit), pushed-snapshot (the snapshot taken when this file was last pulled or pushed) or text (an RBLang document you pass)",
      },
      text: str("against=text: the other RBLang document"),
    },
    ["against"]
  ),
  run_tests: obj({
    pattern: str("Glob for .rbtest.json files (default: every test in the workspace)"),
  }),
  get_evidence: obj(
    {
      sessionId: str("Session the fact was inferred in"),
      factId: str("Fact ID from a run_query result"),
    },
    ["sessionId", "factId"]
  ),
};

/**
 * Tools whose schema the API can enforce with strict mode: flat objects with
 * additionalProperties:false and every property either required or simple.
 * edit_map / run_query / push_map have union-shaped items and stay client-validated.
 */
export const STRICT_TOOLS = new Set(["get_map_overview", "read_map", "get_diagnostics", "lint_rblang", "create_map", "get_evidence", "semantic_diff", "run_tests"]);

const typeOf = (v: unknown): string => (v === null ? "null" : Array.isArray(v) ? "array" : typeof v);

/** Validate `value` against `schema`; returns the first problem as a message, or undefined when valid. */
export function validateAgainstSchema(value: unknown, schema: JsonSchema, path = "input"): string | undefined {
  if (schema.type) {
    const allowed = Array.isArray(schema.type) ? schema.type : [schema.type];
    const actual = typeOf(value);
    const ok = allowed.some((t) => (t === "integer" ? actual === "number" && Number.isInteger(value) : t === actual));
    if (!ok) return `${path} must be ${allowed.join(" or ")}, got ${actual}`;
  }
  if (schema.enum && !schema.enum.includes(value)) return `${path} must be one of ${schema.enum.map((e) => JSON.stringify(e)).join(", ")}`;
  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum) return `${path} must be at least ${schema.minimum}`;
    if (schema.maximum !== undefined && value > schema.maximum) return `${path} must be at most ${schema.maximum}`;
  }
  if (Array.isArray(value) && schema.items) {
    for (let i = 0; i < value.length; i++) {
      const problem = validateAgainstSchema(value[i], schema.items, `${path}[${i}]`);
      if (problem) return problem;
    }
  }
  if (typeOf(value) === "object" && schema.properties) {
    const record = value as Record<string, unknown>;
    for (const key of schema.required ?? []) {
      if (!(key in record) || record[key] === undefined) return `${path}.${key} is required`;
    }
    for (const [key, v] of Object.entries(record)) {
      const sub = schema.properties[key];
      if (!sub) {
        if (schema.additionalProperties === false) return `${path}.${key} is not a recognised field`;
        continue;
      }
      if (v === undefined) continue;
      const problem = validateAgainstSchema(v, sub, `${path}.${key}`);
      if (problem) return problem;
    }
  }
  return undefined;
}

/**
 * The schema as sent to the API. The Messages API rejects some JSON Schema
 * keywords (e.g. `minimum` on integers) that the client-side validator still
 * enforces, so they are stripped here and only here.
 */
export function toApiSchema(schema: JsonSchema): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema)) {
    if (key === "minimum" || key === "maximum") continue;
    if (key === "properties" && value) {
      out.properties = Object.fromEntries(Object.entries(value as Record<string, JsonSchema>).map(([k, v]) => [k, toApiSchema(v)]));
    } else if (key === "items" && value) {
      out.items = toApiSchema(value as JsonSchema);
    } else {
      out[key] = value;
    }
  }
  return out;
}

/** Validate a tool call's input. Unknown tool names are reported too. */
export function validateToolInput(name: string, input: unknown): string | undefined {
  const schema = TOOL_SCHEMAS[name];
  if (!schema) return `Unknown tool: ${name}`;
  if (typeOf(input) !== "object") return `input must be an object, got ${typeOf(input)}`;
  return validateAgainstSchema(input, schema);
}
