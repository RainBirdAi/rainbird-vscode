/**
 * Unit tests for the goal search behind the query panel's goal picker
 * (goalFilter.ts): ranking, case correction, highlighting, grouping, and the
 * inlined copy the webview runs. Runs under plain node (`npm test`).
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { canonicalGoal, GOAL_FILTER_SOURCE, GoalLike, GoalMatch, groupGoals, highlightMatch, rankGoals } from "../goalFilter";
import { Goal, goalsFromMap } from "../goals";

const examples = path.join(__dirname, "..", "..", "examples");
const bigger = goalsFromMap(fs.readFileSync(path.join(examples, "bigger_map.rbl"), "utf8")).goals;
const hello = goalsFromMap(fs.readFileSync(path.join(examples, "hello-world.rbl"), "utf8")).goals;

const goal = (name: string, subject: string, object: string, rules = 0): Goal => ({
  name,
  subject,
  object,
  plural: false,
  askable: "all",
  rules,
  facts: 0,
});

/**
 * Similar wording, as in the user's map (bigger_map has no "has total income"
 * or Amount concept). "has internet access" sits before "has net income" so a
 * mid-word hit on "net" precedes a word-start hit in document order.
 */
const SIMILAR: Goal[] = [
  goal("has income", "Applicant", "Amount", 1),
  goal("has total income", "Applicant", "Amount", 2),
  goal("has total household income", "Household", "Amount", 1),
  goal("has income source", "Applicant", "Income Source"),
  goal("total income band", "Applicant", "Band", 1),
  goal("has gross income", "Applicant", "Amount"),
  goal("has internet access", "Person", "Yes No"),
  goal("has net income", "Applicant", "Amount", 1),
  goal("income is verified", "Applicant", "Yes No"),
  goal("receives payment from", "Applicant", "Income Source"),
  goal("is guarantor for", "Person", "Applicant"),
  goal("lives in", "Person", "Country"),
];

/** "name [score matched]" per row, for readable failures. */
const rows = (matches: GoalMatch<GoalLike>[]): string[] => matches.map((m) => `${m.goal.name} [${m.score} ${m.matched}]`);
const names = (matches: GoalMatch<GoalLike>[]): string[] => matches.map((m) => m.goal.name);
/** Highlight runs as text with the matched parts in [brackets]. */
const marked = (text: string, query: string, matched?: GoalMatch["matched"]): string =>
  highlightMatch(text, query, matched)
    .map((s) => (s.match ? `[${s.text}]` : s.text))
    .join("");

describe("goal filter: ranking similar names", () => {
  test("'total inc': name prefix, then word-start prefix, then all words in any order", () => {
    assert.deepEqual(rows(rankGoals(SIMILAR, "total inc")), [
      "total income band [6 name]",
      "has total income [5 name]",
      "has total household income [3 name]",
    ]);
  });

  test("'TOTAL' is case-insensitive", () => {
    assert.deepEqual(rows(rankGoals(SIMILAR, "TOTAL")), [
      "total income band [6 name]",
      "has total income [5 name]",
      "has total household income [5 name]",
    ]);
  });

  test("'hti' falls back to initials: names with words starting h, t, i in that order", () => {
    assert.deepEqual(rows(rankGoals(SIMILAR, "hti")), ["has total income [1 subsequence]", "has total household income [1 subsequence]"]);
    // Letters merely scattered through a name are not a match, wherever the name sits.
    const withScattered = [goal("has report version", "Case", "ReportVersion"), ...SIMILAR];
    assert.deepEqual(names(rankGoals(withScattered, "hti")), ["has total income", "has total household income"]);
    assert.ok(!names(rankGoals(SIMILAR, "hti")).includes("has net income"), "h…t…i inside words does not count");
    assert.deepEqual(rows(rankGoals(SIMILAR, "tib")), ["total income band [1 subsequence]"]);
  });

  test("'income source': the name match leads, then a relationship whose object matches", () => {
    assert.deepEqual(rows(rankGoals(SIMILAR, "income source")), ["has income source [5 name]", "receives payment from [2 object]"]);
  });

  test("'net': a word starting with it beats an earlier name that only contains it", () => {
    assert.deepEqual(rows(rankGoals(SIMILAR, "net")), ["has net income [5 name]", "has internet access [4 name]"]);
  });

  test("exact name > name prefix > every word in any order", () => {
    assert.deepEqual(rows(rankGoals(SIMILAR, "has income")), [
      "has income [7 name]",
      "has income source [6 name]",
      "has total income [3 name]",
      "has total household income [3 name]",
      "has gross income [3 name]",
      "has net income [3 name]",
    ]);
  });

  test("word order does not matter: 'income total' finds the same names as 'total income'", () => {
    assert.deepEqual(names(rankGoals(SIMILAR, "income total")), ["has total income", "has total household income", "total income band"]);
    assert.deepEqual(new Set(names(rankGoals(SIMILAR, "income total"))), new Set(names(rankGoals(SIMILAR, "total income"))));
  });

  test("ties keep document order — no name-length tiebreak", () => {
    assert.deepEqual(rows(rankGoals(SIMILAR, "income")), [
      "income is verified [6 name]",
      "has income [5 name]",
      "has total income [5 name]",
      "has total household income [5 name]",
      "has income source [5 name]",
      "total income band [5 name]",
      "has gross income [5 name]",
      "has net income [5 name]",
      "receives payment from [2 object]",
    ]);
  });

  test("a concept name finds the relationships of that concept, by subject or object", () => {
    assert.deepEqual(rows(rankGoals(SIMILAR, "Applicant")), [
      "has income [2 subject]",
      "has total income [2 subject]",
      "has income source [2 subject]",
      "total income band [2 subject]",
      "has gross income [2 subject]",
      "has net income [2 subject]",
      "income is verified [2 subject]",
      "receives payment from [2 subject]",
      "is guarantor for [2 object]",
    ]);
    assert.deepEqual(rows(rankGoals(SIMILAR, "countr")), ["lives in [2 object]"]);
    // Words may be spread over the name and the concepts.
    assert.deepEqual(names(rankGoals(SIMILAR, "household amount")), ["has total household income"]);
    assert.deepEqual(rows(rankGoals(SIMILAR, "person access")), ["has internet access [2 subject]"]);
    assert.deepEqual(rows(rankGoals(hello, "Language")), ["national language [5 name]", "speaks [2 object]"]);
  });

  test("whitespace and case in the query are normalised", () => {
    assert.deepEqual(rows(rankGoals(SIMILAR, "  has   TOTAL income ")).slice(0, 1), ["has total income [7 name]"]);
  });

  test("runs of whitespace in a declared name do not demote an exact or prefix match", () => {
    const spaced = [goal("has total", "Applicant", "Amount"), goal("has  total income", "Applicant", "Amount")];
    assert.deepEqual(rows(rankGoals(spaced, "has total income")), ["has  total income [7 name]"]);
    assert.deepEqual(rows(rankGoals(spaced, "has  total  income")), ["has  total income [7 name]"]);
    assert.deepEqual(rows(rankGoals(spaced, "has total")), ["has total [7 name]", "has  total income [6 name]"]);
    assert.equal(marked("has  total income", "has total income"), "[has]  [total] [income]", "highlighting still marks the words");
    assert.equal(canonicalGoal(spaced, "has total income"), "has  total income", "Start query sends the declared spelling");
    assert.equal(canonicalGoal(spaced, "has  total income"), undefined);
  });

  test("the fallback never outranks a real match, needs 3 characters and a single word", () => {
    // "eighties" contains "hti", so nothing falls back to initials.
    const withSubstring = [...SIMILAR, goal("eighties music", "Person", "Genre")];
    assert.deepEqual(rows(rankGoals(withSubstring, "hti")), ["eighties music [4 name]"]);
    assert.deepEqual(rankGoals(SIMILAR, "ht"), [], "two characters: no fallback");
    assert.deepEqual(rankGoals(SIMILAR, "ht i"), [], "two words: no fallback, although h-t-i are the initials of has total income");
    assert.deepEqual(rankGoals(SIMILAR, "zzz"), []);
    // Spaced letters are words, so this is an every-word match, not the fallback.
    assert.deepEqual(rows(rankGoals(SIMILAR, "h t i")).slice(0, 2), ["has total income [3 name]", "has total household income [3 name]"]);
  });

  test("an empty query keeps every goal in document order", () => {
    const all = rankGoals(SIMILAR, "");
    assert.deepEqual(names(all), SIMILAR.map((g) => g.name));
    assert.ok(all.every((m) => m.score === 0 && m.matched === "name"));
    assert.deepEqual(names(rankGoals(SIMILAR, "   ")), SIMILAR.map((g) => g.name));
    assert.equal(rankGoals(SIMILAR, "income")[0].goal, SIMILAR[8], "matches carry the caller's goal objects");
  });

  test("limit caps the ranked list", () => {
    assert.deepEqual(names(rankGoals(SIMILAR, "income", { limit: 2 })), ["income is verified", "has income"]);
    assert.equal(rankGoals(SIMILAR, "", { limit: 5 }).length, 5);
    assert.equal(rankGoals(SIMILAR, "income", { limit: 0 }).length, 0);
    assert.equal(rankGoals(SIMILAR, "income", {}).length, 9);
  });

  test("tolerates a missing goal list and goals without concepts (webview input)", () => {
    assert.deepEqual(rankGoals(undefined as unknown as Goal[], "x"), []);
    const bare = [{ name: "speaks" }] as unknown as GoalLike[];
    assert.deepEqual(rows(rankGoals(bare, "spe")), ["speaks [6 name]"]);
    assert.deepEqual(rankGoals(bare, "person"), []);
  });
});

describe("goal filter: examples/bigger_map.rbl", () => {
  test("'penalty sub' lists the subtotal series in document order (one … six)", () => {
    assert.deepEqual(names(rankGoals(bigger, "penalty sub")), [
      "penalty subtotal one",
      "penalty subtotal two",
      "penalty subtotal three",
      "penalty subtotal four",
      "penalty subtotal five",
      "penalty subtotal six",
    ]);
  });

  test("'total' puts the name that starts with it first, then names containing it", () => {
    const ranked = rankGoals(bigger, "total");
    assert.deepEqual(rows(ranked).slice(0, 2), ["total penalty [6 name]", "penalty subtotal one [4 name]"]);
    assert.equal(ranked.length, 7);
  });

  test("name matches always come before subject / object matches", () => {
    const ranked = rankGoals(bigger, "case");
    const firstConcept = ranked.findIndex((m) => m.matched !== "name");
    assert.ok(firstConcept > 0);
    assert.ok(ranked.slice(0, firstConcept).every((m) => m.goal.name.includes("case")));
    assert.ok(ranked.slice(firstConcept).every((m) => m.score === 2 && (m.matched === "subject" || m.matched === "object")));
    assert.deepEqual(names(rankGoals(bigger, "case")).slice(0, 4), [
      "case block ordinal",
      "case evidence edition drifted",
      "case requires lookup instruction",
      "belongs to case",
    ]);
  });

  test("names the map does not declare, and typos, match nothing (no unrelated rows to pick)", () => {
    for (const q of ["lives in", "has age", "Amount", "hti", "evidnce"]) assert.deepEqual(rows(rankGoals(bigger, q)), [], q);
  });

  test("the initials fallback still finds acronyms, in document order", () => {
    assert.deepEqual(rows(rankGoals(bigger, "pst")), ["penalty subtotal two [1 subsequence]", "penalty subtotal three [1 subsequence]"]);
    assert.deepEqual(names(rankGoals(bigger, "cbo")), ["candidate band ordinal", "case block ordinal"]);
  });

  test("canonicalGoal corrects case against the real map", () => {
    assert.equal(canonicalGoal(bigger, "TOTAL PENALTY"), "total penalty");
    assert.equal(canonicalGoal(bigger, "total penalty"), undefined);
  });
});

describe("goal filter: canonicalGoal", () => {
  test("returns the declared spelling when the typed name differs only in case", () => {
    assert.equal(canonicalGoal(SIMILAR, "HAS TOTAL INCOME"), "has total income");
    assert.equal(canonicalGoal(SIMILAR, "Has Total Income"), "has total income");
    assert.equal(canonicalGoal(SIMILAR, "  Has Total Income "), "has total income");
  });

  test("also fixes runs of whitespace the engine would reject", () => {
    assert.equal(canonicalGoal(SIMILAR, "has   total income"), "has total income");
  });

  test("undefined when already exact, empty, partial or unknown", () => {
    assert.equal(canonicalGoal(SIMILAR, "has total income"), undefined);
    assert.equal(canonicalGoal(SIMILAR, " has total income "), undefined, "surrounding whitespace is trimmed before sending anyway");
    assert.equal(canonicalGoal(SIMILAR, ""), undefined);
    assert.equal(canonicalGoal(SIMILAR, "   "), undefined);
    assert.equal(canonicalGoal(SIMILAR, "has total"), undefined);
    assert.equal(canonicalGoal(SIMILAR, "nope"), undefined);
    assert.equal(canonicalGoal([], "speaks"), undefined);
  });

  test("undefined when several goals differ only in case (ambiguous)", () => {
    const both = [goal("Speaks", "Person", "Language"), goal("speaks", "Person", "Language")];
    assert.equal(canonicalGoal(both, "SPEAKS"), undefined);
    assert.equal(canonicalGoal(both, "Speaks"), undefined);
    assert.equal(canonicalGoal(both, "speaks"), undefined);
  });
});

describe("goal filter: highlightMatch", () => {
  test("marks the whole query where it occurs, preferring a word start", () => {
    assert.equal(marked("has total income", "total inc"), "has [total inc]ome");
    assert.equal(marked("has total income", "TOTAL"), "has [total] income");
    assert.equal(marked("has internet access", "net"), "has inter[net] access");
    assert.equal(marked("internet net", "net"), "internet [net]");
    assert.deepEqual(highlightMatch("has total income", "total inc"), [
      { text: "has ", match: false },
      { text: "total inc", match: true },
      { text: "ome", match: false },
    ]);
  });

  test("marks each query word when the words are apart", () => {
    assert.equal(marked("has total household income", "income total"), "has [total] household [income]");
    assert.equal(marked("has income", "applicant income"), "has [income]", "words found elsewhere are skipped");
  });

  test("marks the initials of a subsequence (fallback) match", () => {
    assert.equal(marked("has total income", "hti", "subsequence"), "[h]as [t]otal [i]ncome");
    assert.equal(marked("has total household income", "hti", "subsequence"), "[h]as [t]otal household [i]ncome");
    assert.equal(marked("total amount income", "tai", "subsequence"), "[t]otal [a]mount [i]ncome");
    assert.equal(marked("has net income", "hti", "subsequence"), "has net income", "nothing marked when the initials do not line up");
    assert.equal(marked("has total income", "hti"), "has total income", "without the subsequence hint nothing is marked");
  });

  test("highlights subject / object text the same way, keeping its case", () => {
    assert.equal(marked("Applicant", "app"), "[App]licant");
    assert.equal(marked("Income Source", "income source"), "[Income Source]");
  });

  test("offsets survive characters whose lower case is longer", () => {
    assert.equal(marked("İstanbul office", "office"), "İstanbul [office]");
    assert.equal(marked("İstanbul office", "stan"), "İ[stan]bul office");
  });

  test("empty query → one plain run; empty text → no runs; runs always rebuild the text", () => {
    assert.deepEqual(highlightMatch("speaks", ""), [{ text: "speaks", match: false }]);
    assert.deepEqual(highlightMatch("", "speaks"), []);
    for (const g of [...SIMILAR, ...bigger.slice(0, 60)]) {
      for (const q of ["income", "total inc", "hti", "has t", "a", "case flag", "cbo"]) {
        for (const kind of [undefined, "subsequence"] as const) {
          const runs = highlightMatch(g.name, q, kind);
          assert.equal(runs.map((r) => r.text).join(""), g.name);
          assert.ok(runs.every((r, i) => r.text.length > 0 && (i === 0 || r.match !== runs[i - 1].match)), "runs are non-empty and alternate");
        }
      }
    }
  });
});

describe("goal filter: groupGoals", () => {
  test("splits rule-bearing goals from the rest, each in document order", () => {
    const { inferred, other } = groupGoals(SIMILAR);
    assert.deepEqual(
      inferred.map((g) => g.name),
      ["has income", "has total income", "has total household income", "total income band", "has net income"]
    );
    assert.equal(other.length, SIMILAR.length - inferred.length);
    assert.deepEqual(
      groupGoals(hello).inferred.map((g) => g.name),
      ["speaks"]
    );
  });

  test("covers every goal of bigger_map, not just the first 100", () => {
    const { inferred, other } = groupGoals(bigger);
    assert.equal(inferred.length, 147);
    assert.equal(other.length, 114);
    const position = (g: Goal): number => bigger.indexOf(g);
    assert.equal(inferred.filter((g) => position(g) >= 100).length, 119);
    assert.ok(inferred.every((g, i) => i === 0 || position(inferred[i - 1]) < position(g)), "document order");
  });

  test("goals without a rule count go to other", () => {
    const { inferred, other } = groupGoals([{ name: "a" }, { name: "b", rules: 2 }] as { name: string; rules?: number }[]);
    assert.deepEqual(
      inferred.map((g) => g.name),
      ["b"]
    );
    assert.deepEqual(
      other.map((g) => g.name),
      ["a"]
    );
  });
});

describe("goal filter: GOAL_FILTER_SOURCE (the webview copy)", () => {
  type Api = {
    rankGoals: typeof rankGoals;
    canonicalGoal: typeof canonicalGoal;
    highlightMatch: typeof highlightMatch;
    groupGoals: typeof groupGoals;
  };
  // Sloppy-mode evaluation with no module scope, as in the webview's <script>.
  const inlined = new Function(`${GOAL_FILTER_SOURCE}\nreturn { rankGoals, canonicalGoal, highlightMatch, groupGoals };`)() as Api;

  test("is self-contained, safe to interpolate into the webview script and defines only goal functions", () => {
    assert.doesNotMatch(GOAL_FILTER_SOURCE, /\bexports\b|\brequire\s*\(|\bimport\b/);
    for (const bad of ["`", "${", "</script", "<!--"]) assert.ok(!GOAL_FILTER_SOURCE.includes(bad), `contains ${bad}`);
    assert.deepEqual(
      [...GOAL_FILTER_SOURCE.matchAll(/^function (\w+)\(/gm)].map((m) => m[1]),
      ["goalFold", "goalCollapse", "goalIsWordStart", "goalFind", "goalInitials", "goalSegments", "rankGoals", "canonicalGoal", "highlightMatch", "groupGoals"]
    );
  });

  test("ranks, highlights, corrects and groups exactly like the Node import", () => {
    const queries = [
      "",
      "total inc",
      "TOTAL",
      "hti",
      "ht i",
      "tib",
      "income source",
      "net",
      "Applicant",
      "income total",
      "has t",
      "penalty sub",
      "case",
      "zzz",
      "pst",
      "cbo",
      "lives in",
      "has age",
      "Amount",
      "  has   TOTAL income ",
      "İ",
      "ht",
    ];
    for (const goals of [SIMILAR, hello, bigger]) {
      for (const q of queries) {
        const expected = rankGoals(goals, q);
        assert.deepEqual(inlined.rankGoals(goals, q), expected, `rankGoals(${q})`);
        assert.deepEqual(inlined.rankGoals(goals, q, { limit: 3 }), rankGoals(goals, q, { limit: 3 }));
        for (const m of expected.slice(0, 20)) {
          assert.deepEqual(inlined.highlightMatch(m.goal.name, q, m.matched), highlightMatch(m.goal.name, q, m.matched));
          assert.deepEqual(inlined.highlightMatch(m.goal.subject, q), highlightMatch(m.goal.subject, q));
        }
        assert.equal(inlined.canonicalGoal(goals, q.toUpperCase()), canonicalGoal(goals, q.toUpperCase()));
      }
      assert.deepEqual(inlined.groupGoals(goals), groupGoals(goals));
    }
    assert.deepEqual(names(inlined.rankGoals(SIMILAR, "hti")), ["has total income", "has total household income"]);
    assert.equal(inlined.canonicalGoal(SIMILAR, "HAS TOTAL INCOME"), "has total income");
    assert.equal(inlined.highlightMatch("İstanbul office", "office")[1].text, "office");
  });
});
