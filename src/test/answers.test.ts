/**
 * Answer controls: which control a question gets, how offered values are
 * formatted and de-duplicated, how typed dates are read, and how answers are
 * coerced before they reach /response. The webview runs the same functions
 * (inlined from ANSWER_WEBVIEW_SOURCE), so the last suite checks that copy
 * behaves exactly like these imports.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import type { Question } from "../api";
import {
  ANSWER_WEBVIEW_SOURCE,
  HINTS,
  answerFor,
  answerHints,
  canAddHere,
  coerceAnswer,
  controlKind,
  describeAmbiguousDate,
  describeDate,
  epochMillisToIso,
  expectedFormat,
  formatValue,
  groupRejectionNote,
  knownSuggestions,
  optionsFor,
  parseHumanDate,
  readDateOrder,
  rejectionNote,
} from "../answers";

function question(overrides: Partial<Question> = {}): Question {
  return {
    relationship: "has date of birth",
    subject: "Tom",
    prompt: "When was Tom born?",
    type: "Second Form Object",
    dataType: "string",
    plural: false,
    allowCF: true,
    allowUnknown: false,
    canAdd: false,
    concepts: [],
    ...overrides,
  };
}

/** The concepts of the live "Where does Tom live?" question (HelloWorld sandbox, 2026-10-07). */
const LIVE_CONCEPTS = [
  { conceptType: "country", name: "England", type: "string", value: "England" },
  { conceptType: "country", name: "France", type: "string", value: "France" },
];

describe("canAddHere", () => {
  test("a boolean on the wire is used as is", () => {
    assert.equal(canAddHere(question({ canAdd: true })), true);
    assert.equal(canAddHere(question({ canAdd: false })), false);
  });

  test("the RBLang string form is read for the side being asked", () => {
    const sfo = (canAdd: string) => canAddHere(question({ canAdd }));
    const sfs = (canAdd: string) => canAddHere(question({ canAdd, type: "Second Form Subject" }));
    assert.equal(sfo("all"), true);
    assert.equal(sfo("none"), false);
    assert.equal(sfo("object"), true);
    assert.equal(sfo("subject"), false, "adding subjects says nothing about objects");
    assert.equal(sfs("subject"), true);
    assert.equal(sfs("object"), false);
    assert.equal(sfo("subject,object"), true);
    assert.equal(sfs("subject, object"), true);
    assert.equal(sfo("true"), true);
    assert.equal(sfo("false"), false);
  });

  test("missing or unexpected values never allow adding", () => {
    assert.equal(canAddHere({ type: "Second Form Object" }), false);
    assert.equal(canAddHere({ canAdd: null }), false);
    assert.equal(canAddHere({ canAdd: 1 }), false);
  });
});

describe("controlKind", () => {
  test("decides by form, then by dataType — never by the presence of concepts", () => {
    assert.equal(controlKind(question({ type: "First Form", dataType: "truth" })), "yesno");
    assert.equal(controlKind(question({ type: "Second Form Subject", dataType: "number" })), "string");
    assert.equal(controlKind(question({ dataType: "truth", concepts: [{ name: "true" }, { name: "true" }] })), "truth");
    assert.equal(controlKind(question({ dataType: "number", concepts: [{ name: "0" }] })), "number");
    assert.equal(controlKind(question({ dataType: "date" })), "date");
    assert.equal(controlKind(question({ dataType: "string" })), "string");
    assert.equal(controlKind({ type: "Second Form Object", dataType: "boolean" }), "truth", "the legacy spelling of truth");
  });
});

describe("formatValue and epochMillisToIso", () => {
  test("epoch milliseconds become YYYY-MM-DD in UTC — detected by magnitude, not digit count", () => {
    assert.equal(formatValue("date", 370742400000), "1981-10-01", "1981-10-01 is a 12-digit epoch");
    assert.equal(formatValue("date", "370742400000"), "1981-10-01");
    assert.equal(formatValue("date", " 370742400000 "), "1981-10-01");
    assert.equal(formatValue("date", "1000000000000"), "2001-09-09");
    assert.equal(formatValue("date", -370742400000), "1958-04-03", "pre-1970 dates are negative");
    assert.equal(formatValue("date", "-370742400000"), "1958-04-03");
  });

  test("small numbers and other strings are not epochs", () => {
    assert.equal(formatValue("date", "1981"), "1981", "a typed year is not 1970-01-01");
    assert.equal(formatValue("date", 9999999999), "9999999999");
    assert.equal(formatValue("date", "1981-10-01"), "1981-10-01");
    assert.equal(epochMillisToIso("12abc"), "");
    assert.equal(epochMillisToIso(true), "");
    assert.equal(epochMillisToIso(9e15), "", "outside the Date range");
  });

  test("numbers, truth values and strings", () => {
    assert.equal(formatValue("number", "3.50"), "3.5");
    assert.equal(formatValue("number", "0"), "0");
    assert.equal(formatValue("number", 42), "42");
    assert.equal(formatValue("number", "4,200"), "4,200", "left alone: not a number");
    assert.equal(formatValue("truth", true), "true");
    assert.equal(formatValue("truth", "FALSE"), "false");
    assert.equal(formatValue("string", " Tom "), " Tom ", "instance names are exact");
    assert.equal(formatValue("string", null), "");
    assert.equal(formatValue(undefined, 7), "7");
  });
});

describe("optionsFor and knownSuggestions", () => {
  test("truth and yes/no questions get no options (their controls are fixed)", () => {
    assert.deepEqual(optionsFor(question({ dataType: "truth", concepts: [{ name: "true" }, { name: "true" }] })), []);
    assert.deepEqual(optionsFor(question({ dataType: "truth", concepts: [{ name: "false" }] })), []);
    assert.deepEqual(optionsFor(question({ type: "First Form", concepts: [{ name: "France" }] })), []);
  });

  test("duplicates collapse by canonical value; the first wins", () => {
    assert.deepEqual(optionsFor(question({ dataType: "number", concepts: [{ name: "0" }, { name: "0" }, { name: "0.0" }] })), [{ label: "0", value: "0" }]);
    assert.deepEqual(
      optionsFor(question({ dataType: "date", concepts: [{ name: "370742400000" }, { name: "1981-10-01" }, { name: "x", value: "y" }] })),
      [{ label: "1981-10-01", value: "1981-10-01" }],
      "epoch and ISO are one date; values the field would refuse are not suggested"
    );
    assert.deepEqual(
      optionsFor(question({ concepts: [{ name: "France" }, { name: "England" }, { name: "France" }, { name: "" }] })).map((o) => o.value),
      ["France", "England"]
    );
  });

  test("the live question's concepts", () => {
    assert.deepEqual(optionsFor(question({ concepts: LIVE_CONCEPTS })), [
      { label: "England", value: "England" },
      { label: "France", value: "France" },
    ]);
  });

  test("a concept without a name falls back to its value", () => {
    assert.deepEqual(optionsFor(question({ concepts: [{ name: "", value: "Spain" }] })), [{ label: "Spain", value: "Spain" }]);
  });

  test("subject questions offer subjects as strings", () => {
    const sfs = question({ type: "Second Form Subject", dataType: "date", concepts: [{ name: "Tom" }, { name: "Ann" }] });
    assert.deepEqual(optionsFor(sfs).map((o) => o.value), ["Tom", "Ann"]);
  });

  test("knownSuggestions: distinct, valid values for number and date fields only", () => {
    assert.deepEqual(knownSuggestions(question({ dataType: "number", concepts: [{ name: "0" }, { name: "0" }, { name: "12.50" }, { name: "lots" }] })), ["0", "12.5"]);
    assert.deepEqual(knownSuggestions(question({ dataType: "date", concepts: [{ name: "370742400000" }] })), ["1981-10-01"]);
    assert.deepEqual(knownSuggestions(question({ concepts: LIVE_CONCEPTS })), []);
  });
});

describe("parseHumanDate", () => {
  test("accepts the common ways of writing a date", () => {
    for (const text of [
      "1st October 1981",
      "1 Oct 1981",
      "1 oct. 1981",
      "1st of October 1981",
      "1-Oct-1981",
      "1 October, 1981",
      "October 1, 1981",
      "Oct 1st 1981",
      "1981-10-01",
      "1981/10/01",
      "1981.10.01",
      "1981-10-1",
      "  1st   October 1981 ",
      "370742400000",
      "1 October 1981.",
      "October 1,1981",
      "Thursday 1 October 1981",
      "Thu, 1 Oct 1981",
      "thurs. 1981-10-01",
    ]) {
      assert.deepEqual(parseHumanDate(text, "day-first"), { iso: "1981-10-01" }, text);
    }
  });

  test("the preview text reads back as the same date", () => {
    for (const iso of ["1981-10-01", "2024-02-29", "1066-10-14", "9999-12-31"]) {
      assert.deepEqual(parseHumanDate(describeDate(iso)), { iso }, describeDate(iso));
      assert.deepEqual(parseHumanDate(describeDate(iso, false)), { iso }, describeDate(iso, false));
    }
  });

  test("a leading weekday is checked against the date, not just dropped", () => {
    assert.deepEqual(parseHumanDate("Friday 1 October 1981"), { error: "1 October 1981 is a Thursday, not a Friday." });
    assert.deepEqual(parseHumanDate("Sat 1981-10-01"), { error: "1 October 1981 is a Thursday, not a Saturday." });
    assert.deepEqual(parseHumanDate("Thursday 01/10/1981"), { ambiguous: ["1981-10-01", "1981-01-10"] }, "an ambiguous date still asks");
    assert.deepEqual(parseHumanDate("Thursday 31 February 1981"), { error: "31 February 1981 is not a real date." });
    assert.deepEqual(parseHumanDate("Th 1 October 1981"), { error: HINTS.dateNotRecognised }, "too short to be a weekday");
  });

  test("a numeric date whose parts could swap is ambiguous, listed in the chosen order", () => {
    assert.deepEqual(parseHumanDate("01/10/1981", "day-first"), { ambiguous: ["1981-10-01", "1981-01-10"] });
    assert.deepEqual(parseHumanDate("1/10/1981", "day-first"), { ambiguous: ["1981-10-01", "1981-01-10"] });
    assert.deepEqual(parseHumanDate("1.10.1981", "day-first"), { ambiguous: ["1981-10-01", "1981-01-10"] });
    assert.deepEqual(parseHumanDate("01/10/1981", "month-first"), { ambiguous: ["1981-01-10", "1981-10-01"] });
    assert.deepEqual(parseHumanDate("01/10/1981"), { ambiguous: ["1981-10-01", "1981-01-10"] }, "day-first by default");
  });

  test("a part above 12 can only be the day, and equal parts read the same", () => {
    assert.deepEqual(parseHumanDate("13/10/1981", "day-first"), { iso: "1981-10-13" });
    assert.deepEqual(parseHumanDate("13/10/1981", "month-first"), { iso: "1981-10-13" });
    assert.deepEqual(parseHumanDate("10/13/1981", "day-first"), { iso: "1981-10-13" });
    assert.deepEqual(parseHumanDate("05/05/1990"), { iso: "1990-05-05" });
  });

  test("refuses impossible dates", () => {
    assert.deepEqual(parseHumanDate("31/02/1981"), { error: "31 February 1981 is not a real date." });
    assert.deepEqual(parseHumanDate("29 Feb 1981"), { error: "29 February 1981 is not a real date." });
    assert.deepEqual(parseHumanDate("29 Feb 1984"), { iso: "1984-02-29" });
    assert.deepEqual(parseHumanDate("1981-13-01"), { error: HINTS.dateNotRecognised });
    assert.deepEqual(parseHumanDate("13/13/1981"), { error: HINTS.dateNotRecognised });
    assert.deepEqual(parseHumanDate("0/10/1981"), { error: HINTS.dateNotRecognised });
  });

  test("refuses two- and three-digit years with their own message", () => {
    assert.deepEqual(parseHumanDate("1 Oct 81"), { error: "Use a four-digit year, e.g. 1981." });
    assert.deepEqual(parseHumanDate("01/10/81"), { error: "Use a four-digit year, e.g. 1981." });
    assert.deepEqual(parseHumanDate("198-10-01"), { error: "Use a four-digit year, e.g. 1981." });
    assert.deepEqual(parseHumanDate("October 1, 81"), { error: "Use a four-digit year, e.g. 1981." });
  });

  test("anything else is not a date", () => {
    for (const text of ["1981", "next Tuesday", "1 Octobre 1981", "19811-10-01", "1981-10-01T10:00", "1/2", "October 11981", "1 October 1981..", "Thursday", "."]) {
      assert.deepEqual(parseHumanDate(text), { error: "Not a date I recognise — try 1981-10-01 or 1 October 1981." }, text);
    }
    assert.deepEqual(parseHumanDate("   "), { error: HINTS.dateMissing });
  });
});

describe("describeDate", () => {
  test("names the weekday", () => {
    assert.equal(describeDate("1981-10-01"), "Thursday 1 October 1981");
    assert.equal(describeDate("1981-10-01", false), "1 October 1981");
    assert.equal(describeDate("2024-02-29"), "Thursday 29 February 2024");
  });

  test("anything that is not an ISO date comes back unchanged", () => {
    assert.equal(describeDate("1 October 1981"), "1 October 1981");
    assert.equal(describeDate("1981-02-31"), "1981-02-31");
  });

  test("an ambiguous date is described with both readings and the unambiguous way to type it", () => {
    assert.equal(
      describeAmbiguousDate("01/10/1981", ["1981-10-01", "1981-01-10"]),
      "01/10/1981 is ambiguous (1 October 1981 or 10 January 1981) — type 1981-10-01 or 1 October 1981."
    );
  });
});

describe("coerceAnswer", () => {
  const num = question({ dataType: "number" });
  const truth = question({ dataType: "truth" });
  const date = question({ dataType: "date" });
  const text = question({ dataType: "string" });

  test("numbers: plain digits and a decimal point only", () => {
    assert.deepEqual(coerceAnswer(num, "3.50"), { ok: true, value: 3.5 });
    assert.deepEqual(coerceAnswer(num, " -12 "), { ok: true, value: -12 });
    assert.deepEqual(coerceAnswer(num, ".5"), { ok: true, value: 0.5 });
    assert.deepEqual(coerceAnswer(num, 42), { ok: true, value: 42 });
    for (const bad of ["1e3", "42 kg", "4,200", "£5", "", "abc", "Infinity"]) {
      assert.deepEqual(coerceAnswer(num, bad), { ok: false, error: HINTS.number }, bad);
    }
    assert.deepEqual(coerceAnswer(num, NaN), { ok: false, error: HINTS.number });
    assert.deepEqual(coerceAnswer(num, "1000000000000000"), { ok: false, error: HINTS.numberTooLarge });
    assert.deepEqual(coerceAnswer(num, "999999999999999"), { ok: true, value: 999999999999999 });
  });

  test("numbers: at most 15 significant digits, never rounded silently", () => {
    assert.deepEqual(coerceAnswer(num, "3.14159265358979"), { ok: true, value: 3.14159265358979 });
    assert.deepEqual(coerceAnswer(num, "1.50000000000000000"), { ok: true, value: 1.5 }, "trailing zeros are not significant");
    assert.deepEqual(coerceAnswer(num, "0.000000000000000000123"), { ok: true, value: 1.23e-19 });
    for (const bad of ["3.14159265358979323", "123456789012345.6", "0.1234567890123456"]) {
      assert.deepEqual(coerceAnswer(num, bad), { ok: false, error: HINTS.numberTooPrecise }, bad);
    }
    assert.deepEqual(coerceAnswer(num, Math.PI), { ok: false, error: HINTS.numberTooPrecise });
    assert.equal(HINTS.numberTooPrecise, "Rainbird numbers have at most 15 significant digits — round this one.");
  });

  test("truth: true or false only, any case", () => {
    assert.deepEqual(coerceAnswer(truth, "True"), { ok: true, value: true });
    assert.deepEqual(coerceAnswer(truth, " false "), { ok: true, value: false });
    assert.deepEqual(coerceAnswer(truth, false), { ok: true, value: false });
    assert.deepEqual(coerceAnswer(truth, "yes"), { ok: false, error: HINTS.truth });
    assert.deepEqual(coerceAnswer(truth, "1"), { ok: false, error: HINTS.truth });
  });

  test("dates become ISO strings", () => {
    assert.deepEqual(coerceAnswer(date, "1st October 1981"), { ok: true, value: "1981-10-01" });
    assert.deepEqual(coerceAnswer(date, "1981-10-01"), { ok: true, value: "1981-10-01" });
    assert.deepEqual(coerceAnswer(date, 370742400000), { ok: true, value: "1981-10-01" });
    assert.deepEqual(coerceAnswer(date, 1981), { ok: false, error: HINTS.dateNotRecognised });
    assert.deepEqual(coerceAnswer(date, "1 Oct 81"), { ok: false, error: HINTS.dateFourDigitYear });
  });

  test("an ambiguous date is refused, naming both readings — the order setting never guesses", () => {
    assert.deepEqual(coerceAnswer(date, "01/10/1981"), {
      ok: false,
      error: "01/10/1981 is ambiguous (1 October 1981 or 10 January 1981) — type 1981-10-01 or 1 October 1981.",
    });
    assert.deepEqual(coerceAnswer(date, "01/10/1981", { dateOrder: "month-first" }), {
      ok: false,
      error: "01/10/1981 is ambiguous (10 January 1981 or 1 October 1981) — type 1981-01-10 or 10 January 1981.",
    });
  });

  test("strings are trimmed; the characters Rainbird refuses and over-long answers are explained", () => {
    assert.deepEqual(coerceAnswer(text, "  France "), { ok: true, value: "France" });
    assert.deepEqual(coerceAnswer(text, 42), { ok: true, value: "42" });
    const quoted = coerceAnswer(text, 'O\'Brien <b>');
    assert.equal(quoted.ok, false);
    assert.match((quoted as { error: string }).error, /does not accept the characters " ' \\ < > in answers — remove ' < >\./);
    const long = coerceAnswer(text, "x".repeat(2001));
    assert.deepEqual(long, { ok: false, error: "Rainbird accepts at most 2000 characters in an answer — this one has 2001." });
    assert.deepEqual(coerceAnswer(text, "x".repeat(2000)), { ok: true, value: "x".repeat(2000) });
    assert.deepEqual(coerceAnswer(text, "  "), { ok: false, error: HINTS.stringMissing });
  });

  test("yes/no questions", () => {
    const ff = question({ type: "First Form" });
    assert.deepEqual(coerceAnswer(ff, "Yes"), { ok: true, value: "yes" });
    assert.deepEqual(coerceAnswer(ff, false), { ok: true, value: "no" });
    assert.deepEqual(coerceAnswer(ff, "maybe"), { ok: false, error: HINTS.yesNo });
  });

  test("subject questions are coerced as strings whatever the object's type", () => {
    assert.deepEqual(coerceAnswer(question({ type: "Second Form Subject", dataType: "number" }), " Tom "), { ok: true, value: "Tom" });
  });
});

describe("hints, expected formats and rejection notes", () => {
  test("the copy the plan fixes", () => {
    assert.equal(HINTS.number, "A number, e.g. 42 or 3.5. Digits and a decimal point only — no units or thousands separators.");
    assert.equal(HINTS.datePlaceholder, "YYYY-MM-DD or e.g. 1 October 1981");
    assert.equal(HINTS.dateNotRecognised, "Not a date I recognise — try 1981-10-01 or 1 October 1981.");
    assert.equal(HINTS.dateFourDigitYear, "Use a four-digit year, e.g. 1981.");
    assert.deepEqual(answerHints(), HINTS);
  });

  test("expectedFormat per kind", () => {
    assert.equal(expectedFormat(question({ dataType: "date" })), "a date as YYYY-MM-DD, e.g. 1981-10-01");
    assert.equal(expectedFormat(question({ dataType: "number" })), "a plain number, e.g. 42 or 3.5 (no units or thousands separators)");
    assert.equal(expectedFormat(question({ dataType: "truth" })), "true or false");
    assert.equal(expectedFormat(question({ type: "First Form" })), "yes or no");
    assert.equal(expectedFormat(question({ concepts: LIVE_CONCEPTS, canAdd: false })), "one of the options offered");
    assert.equal(expectedFormat(question({ concepts: LIVE_CONCEPTS, canAdd: true })), "one of the options offered, or a new value as plain text without the characters \" ' \\ < >");
    assert.equal(expectedFormat(question()), "plain text without the characters \" ' \\ < >");
  });

  test("rejectionNote", () => {
    assert.equal(
      rejectionNote("Invalid date", question({ dataType: "date" })),
      "Rainbird rejected that answer (Invalid date). It expects a date as YYYY-MM-DD, e.g. 1981-10-01. Try again."
    );
    assert.equal(rejectionNote("", question({ dataType: "truth" })), "Rainbird rejected that answer. It expects true or false. Try again.");
  });

  test("groupRejectionNote lists what every question expects, then the action", () => {
    const group = [question({ dataType: "number", prompt: "How old is Tom?" }), question({ dataType: "truth", prompt: "Is Tom resident?" })];
    assert.equal(
      groupRejectionNote("bad value", group),
      "Rainbird rejected one of these answers (bad value). Expected: “How old is Tom?” — a plain number, e.g. 42 or 3.5 (no units or thousands separators); “Is Tom resident?” — true or false. Try again."
    );
    assert.match(groupRejectionNote("", group, "Answer it this time."), /^Rainbird rejected one of these answers\. Expected: .* true or false\. Answer it this time\.$/);
  });
});

describe("answerFor and readDateOrder", () => {
  test("object questions answer the object, subject questions the subject, first form yes/no", () => {
    assert.deepEqual(answerFor(question(), "1981-10-01"), { relationship: "has date of birth", subject: "Tom", object: "1981-10-01" });
    assert.deepEqual(answerFor(question(), 41, 80), { relationship: "has date of birth", subject: "Tom", object: 41, certainty: 80 });
    assert.deepEqual(answerFor(question({ type: "Second Form Subject", subject: undefined, object: "France", relationship: "lives in" }), "Tom"), {
      relationship: "lives in",
      subject: "Tom",
      object: "France",
    });
    assert.deepEqual(answerFor(question({ type: "First Form", relationship: "speaks", object: "French" }), "yes", 100), {
      relationship: "speaks",
      subject: "Tom",
      object: "French",
      answer: "yes",
      certainty: 100,
    });
    assert.equal(answerFor(question({ type: "First Form" }), false).answer, "no");
    assert.equal(answerFor(question({ type: "First Form" }), true).answer, "yes");
    assert.equal(answerFor(question({ type: "First Form" }), " Yes ").answer, "yes");
  });

  test("a first-form value that is not yes or no throws instead of answering no", () => {
    for (const bad of ["maybe", "y", "", 1, "true"]) {
      assert.throws(() => answerFor(question({ type: "First Form" }), bad), /A first-form answer is yes or no/, String(bad));
    }
  });

  test("the date order setting defaults to day-first", () => {
    assert.equal(readDateOrder("month-first"), "month-first");
    assert.equal(readDateOrder("day-first"), "day-first");
    assert.equal(readDateOrder(undefined), "day-first");
    assert.equal(readDateOrder("auto"), "day-first");
  });
});

describe("ANSWER_WEBVIEW_SOURCE (the copy the webview runs)", () => {
  type Inlined = {
    parseHumanDate: typeof parseHumanDate;
    describeDate: typeof describeDate;
    formatValue: typeof formatValue;
    optionsFor: typeof optionsFor;
    knownSuggestions: typeof knownSuggestions;
    coerceAnswer: typeof coerceAnswer;
    expectedFormat: typeof expectedFormat;
    rejectionNote: typeof rejectionNote;
    groupRejectionNote: typeof groupRejectionNote;
    canAddHere: typeof canAddHere;
    controlKind: typeof controlKind;
    answerHints: typeof answerHints;
  };
  const inlined = new Function(
    `${ANSWER_WEBVIEW_SOURCE}\nreturn { parseHumanDate, describeDate, formatValue, optionsFor, knownSuggestions, coerceAnswer, expectedFormat, rejectionNote, groupRejectionNote, canAddHere, controlKind, answerHints };`
  )() as Inlined;

  test("is plain, self-contained browser script", () => {
    assert.doesNotMatch(ANSWER_WEBVIEW_SOURCE, /\bexports\b|\brequire\(|_\d\./, "no CommonJS or import references");
    assert.ok(!ANSWER_WEBVIEW_SOURCE.includes("`"), "no template literals (it is interpolated into a template)");
    assert.doesNotMatch(ANSWER_WEBVIEW_SOURCE, /<\/script|<!--/i);
    for (const name of ["parseHumanDate", "describeDate", "formatValue", "optionsFor", "coerceAnswer", "isoFromParts", "monthNumber", "epochMillisToIso"]) {
      assert.match(ANSWER_WEBVIEW_SOURCE, new RegExp(`function ${name}\\(`), name);
    }
  });

  test("behaves exactly like the Node import", () => {
    const dates = [
      "1st October 1981",
      "October 1, 1981",
      "October 1,1981",
      "1 October 1981.",
      "Thursday 1 October 1981",
      "Friday 1 October 1981",
      "Thursday 01/10/1981",
      "01/10/1981",
      "13/10/1981",
      "31/02/1981",
      "1 Oct 81",
      "1981.10.01",
      "nonsense",
      "",
      "370742400000",
    ];
    for (const text of dates) {
      for (const order of ["day-first", "month-first"] as const) {
        assert.deepEqual(inlined.parseHumanDate(text, order), parseHumanDate(text, order), `${text} ${order}`);
      }
    }
    for (const iso of ["1981-10-01", "2000-02-29", "junk"]) {
      assert.equal(inlined.describeDate(iso), describeDate(iso));
      assert.equal(inlined.describeDate(iso, false), describeDate(iso, false));
    }
    const values: [string, unknown][] = [["date", 370742400000], ["date", "-370742400000"], ["date", "1981"], ["number", "3.50"], ["truth", "TRUE"], ["string", "x"]];
    for (const [type, raw] of values) assert.equal(inlined.formatValue(type, raw), formatValue(type, raw));
    const questions = [
      question({ dataType: "date", concepts: [{ name: "370742400000" }, { name: "1981-10-01" }, { name: "junk" }] }),
      question({ dataType: "number", concepts: [{ name: "0" }, { name: "0" }], canAdd: "none" }),
      question({ dataType: "truth", concepts: [{ name: "true" }, { name: "true" }] }),
      question({ concepts: LIVE_CONCEPTS, canAdd: true }),
      question({ type: "Second Form Subject", canAdd: "subject" }),
      question({ type: "First Form" }),
    ];
    for (const q of questions) {
      assert.deepEqual(inlined.optionsFor(q), optionsFor(q));
      assert.deepEqual(inlined.knownSuggestions(q), knownSuggestions(q));
      assert.equal(inlined.expectedFormat(q), expectedFormat(q));
      assert.equal(inlined.rejectionNote("x", q), rejectionNote("x", q));
      assert.equal(inlined.canAddHere(q), canAddHere(q));
      assert.equal(inlined.controlKind(q), controlKind(q));
      for (const raw of ["01/10/1981", "1st October 1981", "3.50", "3.14159265358979323", "true", "yes", " O'Brien ", ""]) {
        assert.deepEqual(inlined.coerceAnswer(q, raw), coerceAnswer(q, raw), `${q.dataType} ${raw}`);
      }
    }
    assert.deepEqual(inlined.answerHints(), answerHints());
    assert.equal(inlined.groupRejectionNote("x", questions), groupRejectionNote("x", questions));
    assert.equal(inlined.groupRejectionNote("x", questions, "Go on."), groupRejectionNote("x", questions, "Go on."));
  });
});
