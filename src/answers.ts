/**
 * Answer controls shared by every surface that answers the engine's questions:
 * the query panel (host and webview), the Quick Pick runner and the assistant's
 * run_query tool. It decides which control a question gets (by dataType, never
 * by whether the engine happened to send concepts), formats and de-duplicates
 * the values the engine offers, reads dates the way people type them, and
 * coerces answers to wire types before anything reaches /response. VS
 * Code-free, so it is unit-tested under plain node.
 *
 * Platform facts relied on (Rainbird OpenAPI 1.2.0 and live checks):
 * - Question.dataType is string | number | truth | date; an answer's object is
 *   a string, a number or a boolean.
 * - Dates go to the engine as ISO YYYY-MM-DD (epoch milliseconds are accepted
 *   too).
 * - Strings are at most 2000 characters and may not contain " ' \ < >.
 * - Numbers have at most 15 significant digits and a magnitude of at most
 *   999999999999999 (the language reference); coerceAnswer() refuses both
 *   rather than let a value be rounded or rejected later.
 * - canAdd is a boolean on the wire (live: `canAdd: true`); the RBLang string
 *   form (all | subject | object | subject,object | none) is tolerated.
 * - Truth objects are never plural, so a truth question never needs chips.
 *
 * Assumed, not yet verified live (the rainbird.query.logQuestions log will
 * show it): the engine reports date values in concepts and knownAnswers as
 * epoch milliseconds at UTC midnight. 1981-10-01 is 370742400000, twelve
 * digits, so an epoch is told apart by magnitude (|n| >= 1e10), never by its
 * number of digits; ISO strings are taken as they are.
 *
 * The functions in ANSWER_WEBVIEW_SOURCE are inlined into the query panel's
 * webview, so they are self-contained: no imports, no module-level constants,
 * no template literals, and they call only each other. tsc emits unbundled
 * ES2022, so a function's toString() is valid browser JavaScript;
 * src/test/answers.test.ts evaluates the inlined source with new Function and
 * checks it against these imports. Keep it that way when editing them.
 */
import type { Answer, Question, QuestionConcept } from "./api";

/** The control a question gets. A subject question always asks for a string instance; First Form is a yes/no confirmation. */
export type ControlKind = "yesno" | "string" | "number" | "date" | "truth";

/** Which reading of an ambiguous numeric date such as 01/10/1981 is listed first (setting rainbird.query.dateOrder). Neither is ever picked silently. */
export type DateOrder = "day-first" | "month-first";

/** A value to offer. `value` is canonical (ISO for dates, Number(v) for numbers) and is what gets answered; `label` is what is shown. */
export interface AnswerOption {
  label: string;
  value: string;
}

/** parseHumanDate(): one date, the two readings of an ambiguous numeric date (in DateOrder order), or why it is not a date. */
export type ParsedDate = { iso: string } | { ambiguous: [string, string] } | { error: string };

/** coerceAnswer(): the value to send, or a message for the person (or model) who typed it. */
export type CoerceResult = { ok: true; value: string | number | boolean } | { ok: false; error: string };

/** The parts of a question these helpers read. Webview copies of questions are plain JSON, so everything is optional. */
export interface QuestionLike {
  type?: string;
  dataType?: string;
  canAdd?: unknown;
  concepts?: QuestionConcept[];
  prompt?: string;
  relationship?: string;
}

/** User-facing copy for answer controls. A function as well as a constant (HINTS) so the inlined webview functions can read it. */
export function answerHints() {
  return {
    number: "A number, e.g. 42 or 3.5. Digits and a decimal point only — no units or thousands separators.",
    numberPlaceholder: "e.g. 42",
    numberTooLarge: "Rainbird numbers go up to 999999999999999 (15 digits).",
    numberTooPrecise: "Rainbird numbers have at most 15 significant digits — round this one.",
    date: "e.g. 1 October 1981 or 1981-10-01 — Rainbird receives it as YYYY-MM-DD.",
    datePlaceholder: "YYYY-MM-DD or e.g. 1 October 1981",
    dateNotRecognised: "Not a date I recognise — try 1981-10-01 or 1 October 1981.",
    dateFourDigitYear: "Use a four-digit year, e.g. 1981.",
    dateMissing: "Type a date, e.g. 1981-10-01 or 1 October 1981.",
    truth: "Answer true or false.",
    yesNo: "Answer yes or no.",
    string: "Plain text, without the characters \" ' \\ < >.",
    stringPlaceholder: "Type your answer…",
    stringMissing: "Type an answer.",
  };
}

/** The answer-control copy for host code: HINTS.number, HINTS.datePlaceholder, HINTS.dateNotRecognised, … */
export const HINTS: Readonly<ReturnType<typeof answerHints>> = Object.freeze(answerHints());

/**
 * Whether the person answering may type a value that is not offered, on the
 * side this question asks about. A boolean on the wire; the RBLang string form
 * lists the sides (subject, object) that accept new instances.
 */
export function canAddHere(q: { canAdd?: unknown; type?: string }): boolean {
  const v = q.canAdd;
  if (typeof v === "boolean") return v;
  if (typeof v !== "string") return false;
  const s = v.trim().toLowerCase();
  if (s === "true" || s === "all") return true;
  const side = q.type === "Second Form Subject" ? "subject" : "object";
  return s.split(",").map((p) => p.trim()).indexOf(side) !== -1;
}

/** The control for a question: by form first (yes/no, subject), then by the object's dataType — never by the presence of concepts. */
export function controlKind(q: { type?: string; dataType?: string }): ControlKind {
  if (q.type === "First Form") return "yesno";
  if (q.type === "Second Form Subject") return "string";
  const t = q.dataType;
  if (t === "number" || t === "date" || t === "truth") return t;
  return t === "boolean" ? "truth" : "string";
}

/** "YYYY-MM-DD" (UTC) for epoch milliseconds — a number or a digit string with |n| >= 1e10 — and "" for anything else, so a typed year such as 1981 is never read as 1970. */
export function epochMillisToIso(raw: unknown): string {
  let n: number;
  if (typeof raw === "number") n = raw;
  else if (typeof raw === "string" && /^\s*-?\d+\s*$/.test(raw)) n = Number(raw);
  else return "";
  if (!isFinite(n) || Math.abs(n) < 1e10) return "";
  const d = new Date(n);
  const y = d.getUTCFullYear();
  if (!(y >= 1 && y <= 9999)) return "";
  return String(y).padStart(4, "0") + "-" + String(d.getUTCMonth() + 1).padStart(2, "0") + "-" + String(d.getUTCDate()).padStart(2, "0");
}

/** "YYYY-MM-DD" for a real calendar date, "" otherwise (31 February, month 13, day 0). */
function isoFromParts(year: number, month: number, day: number): string {
  if (!(year >= 1 && year <= 9999 && month >= 1 && month <= 12 && day >= 1 && day <= 31)) return "";
  const d = new Date(Date.UTC(2000, 0, 1));
  // setUTCFullYear keeps years below 100 literal (Date.UTC would read 81 as 1981).
  d.setUTCFullYear(year, month - 1, day);
  if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) return "";
  return String(year).padStart(4, "0") + "-" + String(month).padStart(2, "0") + "-" + String(day).padStart(2, "0");
}

/** 1–12 for an English month name or an abbreviation of at least three letters ("Oct", "Sept."); 0 otherwise. */
function monthNumber(name: string): number {
  const months = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
  const s = String(name).toLowerCase().replace(/\.$/, "");
  if (s.length < 3) return 0;
  for (let i = 0; i < months.length; i++) if (months[i].startsWith(s)) return i + 1;
  return 0;
}

/**
 * A value as the person answering should see it, and the canonical form used
 * to de-duplicate: dates as YYYY-MM-DD (epoch milliseconds converted in UTC),
 * truth as lowercase true/false, numbers as Number(v) ("3.50" → "3.5"),
 * strings unchanged.
 */
export function formatValue(dataType: string | undefined, raw: unknown): string {
  if (raw === undefined || raw === null) return "";
  if (dataType === "date") return epochMillisToIso(raw) || String(raw).trim();
  if (dataType === "truth" || dataType === "boolean") {
    const s = String(raw).trim().toLowerCase();
    return s === "true" || s === "false" ? s : String(raw).trim();
  }
  if (dataType === "number") {
    if (typeof raw === "number") return String(raw);
    const s = String(raw).trim();
    return /^[+-]?(\d+\.?\d*|\.\d+)$/.test(s) ? String(Number(s)) : s;
  }
  return String(raw);
}

/** "Thursday 1 October 1981" for "1981-10-01" ("1 October 1981" when withWeekday is false); anything that is not an ISO date comes back unchanged. */
export function describeDate(iso: string, withWeekday?: boolean): string {
  const text = String(iso ?? "").trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (!m || !isoFromParts(Number(m[1]), Number(m[2]), Number(m[3]))) return String(iso ?? "");
  const months = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  const days = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  const d = new Date(Date.UTC(2000, 0, 1));
  d.setUTCFullYear(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const long = Number(m[3]) + " " + months[Number(m[2]) - 1] + " " + Number(m[1]);
  return withWeekday === false ? long : days[d.getUTCDay()] + " " + long;
}

/**
 * Read a date the way people type it: 1st October 1981, 1 Oct 1981, 1st of
 * October 1981, October 1, 1981 (or October 1,1981), 01/10/1981, 1/10/1981,
 * 1.10.1981, 1981-10-01, 1981/10/01, 1981.10.01 (and epoch milliseconds). A
 * trailing full stop is ignored, and a leading weekday — as describeDate()
 * writes it, "Thursday 1 October 1981" — is checked against the date. Years
 * must have four digits; impossible dates (31/02/1981) are refused. A numeric
 * date whose day and month could swap (01/10/1981, but not 13/10/1981) is
 * ambiguous: both readings come back, `order` deciding which is listed first,
 * and the caller must let the person choose — the date order setting never
 * decides silently.
 */
export function parseHumanDate(text: string, order?: DateOrder): ParsedDate {
  const hints = answerHints();
  let t = String(text ?? "").trim().replace(/\s+/g, " ");
  if (!t) return { error: hints.dateMissing };
  // A weekday name or its abbreviation (three letters at least, so "T" is neither Tuesday nor Thursday); no month name starts like one.
  let weekday = "";
  const w = /^([a-z]{3,})\.?,? (?=\S)/i.exec(t);
  if (w) {
    const typed = w[1].toLowerCase();
    for (const day of ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"]) {
      if (day.toLowerCase().startsWith(typed)) weekday = day;
    }
    if (weekday) t = t.slice(w[0].length);
  }
  // One full stop at the end closes a sentence, not the date.
  t = t.replace(/\.$/, "");
  const months = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  // A four-digit year is 1000–9999; shorter ones (81, 198) get their own message, longer ones are not dates.
  const yearOf = (s: string): number => (s.length === 4 && Number(s) >= 1000 ? Number(s) : s.length <= 4 ? -1 : -2);
  const exact = (y: number, month: number, day: number): ParsedDate => {
    if (y === -1) return { error: hints.dateFourDigitYear };
    if (y < 0 || !(month >= 1 && month <= 12) || !(day >= 1 && day <= 31)) return { error: hints.dateNotRecognised };
    const iso = isoFromParts(y, month, day);
    return iso ? { iso } : { error: day + " " + months[month - 1] + " " + y + " is not a real date." };
  };
  const read = (): ParsedDate => {
    const epoch = epochMillisToIso(t);
    if (epoch) return { iso: epoch };
    // Year first: 1981-10-01, 1981/10/01, 1981.10.01.
    let m = /^(\d{3,})[-\/.](\d{1,2})[-\/.](\d{1,2})$/.exec(t);
    if (m) return exact(yearOf(m[1]), Number(m[2]), Number(m[3]));
    // Numeric day and month: 01/10/1981, 1.10.1981, 1-10-1981.
    m = /^(\d{1,2})[-\/.](\d{1,2})[-\/.](\d+)$/.exec(t);
    if (m) {
      const y = yearOf(m[3]);
      const a = Number(m[1]);
      const b = Number(m[2]);
      // One reading only: a part above 12 can only be the day, and equal parts read the same either way.
      if (y < 0 || a > 12 || b > 12 || a === b) return b > 12 ? exact(y, a, b) : exact(y, b, a);
      const dayFirst = exact(y, b, a);
      const monthFirst = exact(y, a, b);
      if (!("iso" in dayFirst)) return dayFirst;
      if (!("iso" in monthFirst)) return monthFirst;
      const readings: [string, string] = order === "month-first" ? [monthFirst.iso, dayFirst.iso] : [dayFirst.iso, monthFirst.iso];
      return { ambiguous: readings };
    }
    // Day, month name, year: 1st October 1981, 1 Oct 1981, 1st of October 1981, 1-Oct-1981.
    m = /^(\d{1,2})(?:st|nd|rd|th)?(?: of)?[ ,.\/-]+([a-z]+)\.?[ ,.\/-]+(\d+)$/i.exec(t);
    if (m) return monthNumber(m[2]) ? exact(yearOf(m[3]), monthNumber(m[2]), Number(m[1])) : { error: hints.dateNotRecognised };
    // Month name, day, year: October 1, 1981; October 1,1981; Oct 1st 1981.
    m = /^([a-z]+)\.?[ ,.\/-]+(\d{1,2})(?:st|nd|rd|th)?(?:, ?| )(\d+)$/i.exec(t);
    if (m) return monthNumber(m[1]) ? exact(yearOf(m[3]), monthNumber(m[1]), Number(m[2])) : { error: hints.dateNotRecognised };
    return { error: hints.dateNotRecognised };
  };
  const result = read();
  // The weekday must agree with the date (an ambiguous date is left to the person's choice).
  if (!weekday || !("iso" in result)) return result;
  const actual = describeDate(result.iso).split(" ")[0];
  return actual === weekday ? result : { error: describeDate(result.iso, false) + " is a " + actual + ", not a " + weekday + "." };
}

/** "01/10/1981 is ambiguous (1 October 1981 or 10 January 1981) — type 1981-10-01 or 1 October 1981." */
export function describeAmbiguousDate(text: string, readings: [string, string]): string {
  const first = describeDate(readings[0], false);
  return String(text ?? "").trim() + " is ambiguous (" + first + " or " + describeDate(readings[1], false) + ") — type " + readings[0] + " or " + first + ".";
}

/**
 * The values to offer for a question: its concepts, formatted for its kind and
 * de-duplicated by canonical value (the first occurrence wins), empty values
 * dropped. Never anything for truth or yes/no questions — their controls are
 * fixed. For number and date questions these are known values to suggest
 * (only those the field would accept), not a closed list: those questions
 * always get a typed field whatever canAdd says.
 */
export function optionsFor(q: QuestionLike): AnswerOption[] {
  const kind = controlKind(q);
  if (kind === "yesno" || kind === "truth") return [];
  const seen = new Set<string>();
  const out: AnswerOption[] = [];
  for (const c of (Array.isArray(q.concepts) ? q.concepts : []) as unknown[]) {
    const entry = c as { name?: unknown; value?: unknown } | null;
    const raw = entry !== null && typeof entry === "object" ? (entry.name !== undefined && entry.name !== null && entry.name !== "" ? entry.name : entry.value) : entry;
    if (raw === undefined || raw === null) continue;
    const value = formatValue(kind, raw);
    if (!value.trim() || seen.has(value)) continue;
    if (kind !== "string" && !coerceAnswer(q, value).ok) continue;
    seen.add(value);
    out.push({ label: value, value });
  }
  return out;
}

/** The known values of a number or date question as fill-in suggestions for its field (distinct, formatted, valid); empty for other kinds. */
export function knownSuggestions(q: QuestionLike): string[] {
  const kind = controlKind(q);
  if (kind !== "number" && kind !== "date") return [];
  return optionsFor(q).map((o) => o.value);
}

/** What a question accepts, in words: "a date as YYYY-MM-DD, e.g. 1981-10-01". Used in hints, rejection notes and the assistant's question summaries. */
export function expectedFormat(q: QuestionLike): string {
  const kind = controlKind(q);
  if (kind === "yesno") return "yes or no";
  if (kind === "truth") return "true or false";
  if (kind === "number") return "a plain number, e.g. 42 or 3.5 (no units or thousands separators)";
  if (kind === "date") return "a date as YYYY-MM-DD, e.g. 1981-10-01";
  const text = "plain text without the characters \" ' \\ < >";
  if (!optionsFor(q).length) return text;
  return canAddHere(q) ? "one of the options offered, or a new value as " + text : "one of the options offered";
}

/**
 * Turn what was typed or picked into the value to send: yes/no → "yes" | "no";
 * truth → boolean; number → Number (the number hint on failure; at most 15
 * significant digits and 999999999999999 in magnitude); date → ISO
 * YYYY-MM-DD, an error, or — for an ambiguous numeric date — an error naming
 * both readings (never a guess); string → trimmed, refusing " ' \ < > and more
 * than 2000 characters. `dateOrder` only orders the readings in that message.
 */
export function coerceAnswer(q: QuestionLike, raw: unknown, opts?: { dateOrder?: DateOrder }): CoerceResult {
  const hints = answerHints();
  const kind = controlKind(q);
  if (kind === "yesno") {
    if (typeof raw === "boolean") return { ok: true, value: raw ? "yes" : "no" };
    const s = String(raw ?? "").trim().toLowerCase();
    return s === "yes" || s === "no" ? { ok: true, value: s } : { ok: false, error: hints.yesNo };
  }
  if (kind === "truth") {
    if (typeof raw === "boolean") return { ok: true, value: raw };
    const s = String(raw ?? "").trim().toLowerCase();
    return s === "true" || s === "false" ? { ok: true, value: s === "true" } : { ok: false, error: hints.truth };
  }
  if (kind === "number") {
    let n: number;
    if (typeof raw === "number") n = raw;
    else {
      const s = String(raw ?? "").trim();
      if (!/^[+-]?(\d+\.?\d*|\.\d+)$/.test(s)) return { ok: false, error: hints.number };
      n = Number(s);
    }
    if (!isFinite(n)) return { ok: false, error: hints.number };
    if (Math.abs(n) > 999999999999999) return { ok: false, error: hints.numberTooLarge };
    // More than 15 significant digits would be rounded somewhere on the way: say so instead.
    if (Number(n.toPrecision(15)) !== n) return { ok: false, error: hints.numberTooPrecise };
    return { ok: true, value: n };
  }
  if (kind === "date") {
    if (typeof raw === "number") {
      const iso = epochMillisToIso(raw);
      return iso ? { ok: true, value: iso } : { ok: false, error: hints.dateNotRecognised };
    }
    const text = String(raw ?? "");
    const parsed = parseHumanDate(text, opts && opts.dateOrder);
    if ("iso" in parsed) return { ok: true, value: parsed.iso };
    if ("ambiguous" in parsed) return { ok: false, error: describeAmbiguousDate(text, parsed.ambiguous) };
    return { ok: false, error: parsed.error };
  }
  const s = String(raw ?? "").trim();
  if (!s) return { ok: false, error: hints.stringMissing };
  const bad = s.match(/["'\\<>]/g);
  if (bad) {
    const chars = bad.filter((c, i) => bad.indexOf(c) === i).join(" ");
    return { ok: false, error: "Rainbird does not accept the characters \" ' \\ < > in answers — remove " + chars + "." };
  }
  if (s.length > 2000) return { ok: false, error: "Rainbird accepts at most 2000 characters in an answer — this one has " + s.length + "." };
  return { ok: true, value: s };
}

/** The note shown when the engine rejects an answer: "Rainbird rejected that answer (<detail>). It expects <expectedFormat>. Try again." */
export function rejectionNote(detail: string, q: QuestionLike): string {
  return "Rainbird rejected that answer" + (detail ? " (" + detail + ")" : "") + ". It expects " + expectedFormat(q) + ". Try again.";
}

/**
 * The same for a question group, whose rejection does not say which answer
 * failed: lists what each question expects, then `action`. For surfaces that
 * ask again from scratch (the Quick Pick runner). The query panel's group card
 * keeps the answers and uses the GQ-2 copy instead: "One of these answers was
 * rejected ({detail}). Your answers are kept — fix the one in question and
 * click Submit answers again."
 */
export function groupRejectionNote(detail: string, group: QuestionLike[], action?: string): string {
  const expected = group.map((q) => "“" + (q.prompt || q.relationship || "") + "” — " + expectedFormat(q)).join("; ");
  return "Rainbird rejected one of these answers" + (detail ? " (" + detail + ")" : "") + ". Expected: " + expected + ". " + (action || "Try again.");
}

/**
 * The wire answer giving an already coerced `value` for question q: a Second
 * Form Subject question asks for the subject, every other second-form question
 * for the object; a First Form question takes "yes" / "no" in `answer`.
 * Without `certainty` the field is left out and respond() sends 100. Throws
 * for a First Form value other than yes / no / a boolean: sending "no" for
 * "maybe" would silently answer the opposite.
 */
export function answerFor(
  q: Pick<Question, "type" | "relationship" | "subject" | "object">,
  value: string | number | boolean,
  certainty?: number
): Answer {
  const cf = certainty === undefined ? {} : { certainty };
  if (q.type === "First Form") {
    const said = typeof value === "boolean" ? (value ? "yes" : "no") : String(value).trim().toLowerCase();
    if (said !== "yes" && said !== "no") throw new Error(`A first-form answer is yes or no, not "${String(value)}": coerce it with coerceAnswer() first.`);
    const answer: "yes" | "no" = said;
    return {
      relationship: q.relationship,
      ...(q.subject !== undefined ? { subject: q.subject } : {}),
      ...(q.object !== undefined ? { object: q.object } : {}),
      answer,
      ...cf,
    };
  }
  if (q.type === "Second Form Subject") {
    return { relationship: q.relationship, subject: String(value), ...(q.object !== undefined ? { object: q.object } : {}), ...cf };
  }
  return { relationship: q.relationship, ...(q.subject !== undefined ? { subject: q.subject } : {}), object: value, ...cf };
}

/** The rainbird.query.dateOrder setting as a DateOrder; anything unexpected is the default, day-first. */
export function readDateOrder(value: unknown): DateOrder {
  return value === "month-first" ? "month-first" : "day-first";
}

/**
 * Source text of the answer helpers the query panel webview needs, to inline
 * into its single <script> (interpolate it into the script template). After
 * it the webview has answerHints, canAddHere, controlKind, epochMillisToIso,
 * formatValue, describeDate, parseHumanDate, describeAmbiguousDate,
 * optionsFor, knownSuggestions, expectedFormat, coerceAnswer, rejectionNote
 * and groupRejectionNote (plus the private helpers isoFromParts and
 * monthNumber) as top-level functions.
 */
export const ANSWER_WEBVIEW_SOURCE: string = [
  answerHints,
  canAddHere,
  controlKind,
  epochMillisToIso,
  isoFromParts,
  monthNumber,
  formatValue,
  describeDate,
  parseHumanDate,
  describeAmbiguousDate,
  optionsFor,
  knownSuggestions,
  expectedFormat,
  coerceAnswer,
  rejectionNote,
  groupRejectionNote,
]
  .map((fn) => fn.toString())
  .join("\n");
