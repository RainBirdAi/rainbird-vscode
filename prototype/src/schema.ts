/**
 * RBLang structural schema.
 *
 * Clean-room TypeScript encoding of the RBLang element/attribute rules, derived
 * from Rainbird's public RBLang reference documentation
 * (https://docs.rainbird.ai/rainbird/knowledge-modelling/modelling-features/rblang-reference)
 * and observed Studio validation behaviour. In the full extension this table
 * becomes the core of the language server; here it drives prototype
 * diagnostics and completions.
 */

export interface ElementSpec {
  /** Attributes that must be present */
  required: string[];
  /** Attributes that may be present */
  optional: string[];
  /** Allowed enum values per attribute (attributes not listed are free-form) */
  enums?: Record<string, string[]>;
  /** Child element names allowed inside this element */
  children: string[];
  /** Whether text content is allowed */
  text: boolean;
  /** One-line hover documentation */
  doc: string;
}

export const RBLANG_NAMESPACE = "http://rbl.io/schema/RBLang";

export const SCHEMA: Record<string, ElementSpec> = {
  "rbl:kb": {
    required: ["xmlns:rbl"],
    optional: [],
    children: ["concept", "concinst", "rel", "relinst", "import", "compound"],
    text: false,
    doc: "Root element of an RBLang knowledge map. xmlns:rbl must be \"http://rbl.io/schema/RBLang\".",
  },
  concept: {
    required: ["name", "type"],
    optional: ["scope", "behaviour"],
    enums: {
      type: ["string", "number", "date", "truth"],
      behaviour: ["mutually-exclusive", "mutex", "mx"],
      scope: ["context"],
    },
    children: ["datasource"],
    text: false,
    doc: "A typed container of things. Only string concepts can be relationship subjects or have instances.",
  },
  concinst: {
    required: ["name", "type"],
    optional: [],
    children: ["meta"],
    text: false,
    doc: "A concept instance. Valid only for string concepts; type refers to the concept name.",
  },
  meta: {
    required: [],
    optional: ["type"],
    children: [],
    text: true,
    doc: "Markdown metadata attached to a concept instance (type=\"md\").",
  },
  rel: {
    required: ["name", "subject", "object"],
    optional: ["plural", "allowCF", "allowUnknown", "askable", "canAdd", "group", "scope"],
    enums: {
      plural: ["true", "false"],
      allowCF: ["true", "false"],
      allowUnknown: ["true", "false"],
      askable: ["all", "none", "secondFormSubject", "secondFormObject", "true", "false"],
      canAdd: ["all", "subject,object", "object,subject", "subject", "object", "none"],
      scope: ["context"],
    },
    children: ["firstForm", "secondFormSubject", "secondFormObject"],
    text: false,
    doc: "A directional relationship between a subject concept (must be string-typed) and an object concept.",
  },
  firstForm: {
    required: [],
    optional: [],
    children: [],
    text: true,
    doc: "Yes/no question wording used when both subject and object are known. %S and %O are substituted.",
  },
  secondFormSubject: {
    required: [],
    optional: [],
    children: [],
    text: true,
    doc: "Question wording asking for the subject given the object (%O).",
  },
  secondFormObject: {
    required: [],
    optional: [],
    children: [],
    text: true,
    doc: "Question wording asking for the object given the subject (%S).",
  },
  relinst: {
    required: ["type"],
    optional: ["subject", "object", "cf", "behaviour", "minimum-rule-certainty", "alt", "name"],
    enums: {
      behaviour: ["top-down", "top-down-strict"],
    },
    children: ["condition"],
    text: false,
    doc: "A relationship instance: a fact (no conditions) or a rule (with <condition> children). cf caps certainty (default 100).",
  },
  condition: {
    required: [],
    optional: ["rel", "subject", "object", "expression", "value", "weight", "behaviour", "salience", "funct", "alt"],
    enums: {
      behaviour: ["mandatory", "optional"],
    },
    children: [],
    text: false,
    doc: "A rule condition: either a relationship pattern (rel/subject/object) or an expression, optionally assigning via value=.",
  },
  datasource: {
    required: ["hostname"],
    optional: ["path", "method", "name"],
    enums: {
      method: ["GET", "POST"],
    },
    children: ["action", "input", "headers"],
    text: true,
    doc: "REST datasource attached to the subject concept, invoked mid-inference (Match → Infer → Ask). Text content is the request body.",
  },
  action: {
    required: ["map"],
    optional: [],
    children: ["action"],
    text: false,
    doc: "Maps a response path to facts: map=\"relationship name=/Response/Path\".",
  },
  input: {
    required: [],
    optional: ["rel", "subject", "object", "value", "expression"],
    children: [],
    text: false,
    doc: "Binds an additional variable for the datasource request from a relationship in the graph.",
  },
  headers: {
    required: [],
    optional: [],
    children: ["header"],
    text: false,
    doc: "HTTP headers for the datasource request.",
  },
  header: {
    required: ["key", "value"],
    optional: [],
    children: [],
    text: false,
    doc: "One HTTP header. Values support {{%VARIABLE}} substitution.",
  },
  import: {
    required: ["km", "versionNumber"],
    optional: ["username"],
    children: [],
    text: false,
    doc: "Links another knowledge map version into this one (Studio 'linked knowledge maps').",
  },
  compound: {
    required: ["subject", "type", "object"],
    optional: [],
    children: ["relinst"],
    text: false,
    doc: "Legacy compound element. Accepted by the validator; semantics undocumented.",
  },
};

/** The complete expression-language function catalogue (engine v4.118). */
export const EXPRESSION_FUNCTIONS: { name: string; signature: string; doc: string }[] = [
  { name: "countRelationshipInstances", signature: "countRelationshipInstances(subject, 'relationship', object)", doc: "Count facts matching the pattern; * is a wildcard. Use `is equal to 0` to test absence — there is no null test." },
  { name: "sumObjects", signature: "sumObjects(subject, 'relationship', object)", doc: "Sum the numeric objects of matching facts." },
  { name: "minObjects", signature: "minObjects(subject, 'relationship', object)", doc: "Minimum numeric object of matching facts." },
  { name: "maxObjects", signature: "maxObjects(subject, 'relationship', object)", doc: "Maximum numeric object of matching facts." },
  { name: "joinObjects", signature: "joinObjects(subject, 'relationship', object)", doc: "Comma-joined string of matching fact objects." },
  { name: "isSubset", signature: "isSubset(s1, 'rel1', o1, s2, 'rel2', o2)", doc: "True when the first fact set is a subset of the second." },
  { name: "today", signature: "today()", doc: "Today's date (unix ms)." },
  { name: "now", signature: "now()", doc: "Current timestamp (unix ms)." },
  { name: "addDays", signature: "addDays(date, n)", doc: "Add n days to a date." },
  { name: "addWeeks", signature: "addWeeks(date, n)", doc: "Add n weeks to a date." },
  { name: "addMonths", signature: "addMonths(date, n)", doc: "Add n months to a date." },
  { name: "addYears", signature: "addYears(date, n)", doc: "Add n years to a date." },
  { name: "subtractDays", signature: "subtractDays(date, n)", doc: "Subtract n days from a date." },
  { name: "subtractWeeks", signature: "subtractWeeks(date, n)", doc: "Subtract n weeks from a date." },
  { name: "subtractMonths", signature: "subtractMonths(date, n)", doc: "Subtract n months from a date." },
  { name: "subtractYears", signature: "subtractYears(date, n)", doc: "Subtract n years from a date." },
  { name: "daysBetween", signature: "daysBetween(a, b)", doc: "Days between two dates." },
  { name: "weeksBetween", signature: "weeksBetween(a, b)", doc: "Weeks between two dates." },
  { name: "monthsBetween", signature: "monthsBetween(a, b)", doc: "Months between two dates." },
  { name: "yearsBetween", signature: "yearsBetween(a, b)", doc: "Years between two dates." },
  { name: "hoursBetween", signature: "hoursBetween(a, b)", doc: "Hours between two dates." },
  { name: "minutesBetween", signature: "minutesBetween(a, b)", doc: "Minutes between two dates." },
  { name: "secondsBetween", signature: "secondsBetween(a, b)", doc: "Seconds between two dates." },
  { name: "dayOfWeek", signature: "dayOfWeek(date)", doc: "Day of week of a date." },
  { name: "dayOfMonth", signature: "dayOfMonth(date)", doc: "Day of month of a date." },
  { name: "dayOfYear", signature: "dayOfYear(date)", doc: "Day of year of a date." },
  { name: "monthOfYear", signature: "monthOfYear(date)", doc: "Month of year of a date." },
  { name: "year", signature: "year(date)", doc: "Year of a date." },
  { name: "isBeforeDate", signature: "isBeforeDate(a, b)", doc: "True when a is before b. Dates must use date functions, not comparison operators." },
  { name: "isSameDate", signature: "isSameDate(a, b)", doc: "True when a and b are the same date." },
  { name: "isAfterDate", signature: "isAfterDate(a, b)", doc: "True when a is after b." },
  { name: "isWithinRange", signature: "isWithinRange(value, min, max)", doc: "True when value is within [min, max]. Works for numbers and dates." },
  { name: "includes", signature: "includes(string, 'substring')", doc: "Case- and whitespace-sensitive substring test. Negate with `= false`." },
  { name: "startsWith", signature: "startsWith(string, 'prefix')", doc: "Case-sensitive prefix test." },
  { name: "endsWith", signature: "endsWith(string, 'suffix')", doc: "Case-sensitive suffix test." },
  { name: "regexCount", signature: "regexCount(string, '/pattern/flags')", doc: "JS-flavoured regex match count. Negative return values are error codes." },
  { name: "round", signature: "round(x, places)", doc: "Round to up to 15 decimal places." },
  { name: "ceil", signature: "ceil(x)", doc: "Round up." },
  { name: "floor", signature: "floor(x)", doc: "Round down." },
  { name: "abs", signature: "abs(x)", doc: "Absolute value." },
  { name: "min", signature: "min(a, b)", doc: "Minimum of two numbers." },
  { name: "max", signature: "max(a, b)", doc: "Maximum of two numbers." },
  { name: "mod", signature: "mod(a, b)", doc: "Remainder of a / b." },
  { name: "pow", signature: "pow(base, exp)", doc: "Exponentiation." },
  { name: "sqrt", signature: "sqrt(x)", doc: "Square root." },
  { name: "factorial", signature: "factorial(n)", doc: "Factorial." },
  { name: "tan", signature: "tan(x)", doc: "Tangent." },
  { name: "atan2", signature: "atan2(y, x)", doc: "Two-argument arctangent." },
  { name: "sec", signature: "sec(x)", doc: "Secant." },
  { name: "csc", signature: "csc(x)", doc: "Cosecant." },
  { name: "cot", signature: "cot(x)", doc: "Cotangent." },
];
