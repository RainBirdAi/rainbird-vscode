/**
 * Evidence payloads for the evidence model and renderer tests, as TS modules
 * (tsc emits no JSON).
 *
 * HELLO_WORLD_*: real GET /analysis/evidence responses captured from the public
 * HelloWorld sandbox on 2026-10-07 (inject "Tom lives in France" at 90, query
 * speaks, skip the re-asked question with unanswered: true). Note source "km".
 *
 * The rest follow the engine's evidence builder and its own API tests:
 * impact = weight ÷ (sum of ALL the rule's weights) × certainty × cap ÷ 100,
 * rounded to two decimals; typed variables arrive as {value, type}; an unmet
 * optional condition carries the never-stored factID "WA:XX" and no wasMet;
 * a list-function key is the call as evaluated while expression.text is the
 * rule's own text. INCOME ("has total income" = sumObjects over three incomes:
 * injected, answered, from the map), LOAN (a nested rule, an unmet optional
 * condition, expressions, a zero-weight condition), DATES and EMPTY_LIST
 * (engine API tests "Evidence With Dates" and "Numerical Function Over Empty
 * List"), SKIPPED (the engine counted a condition it did not report), CLAIM (a
 * copy of the OpenAPI example, whose hand-edited impacts do not add up), and a
 * repeat and a cycle.
 */
import type { EvidenceNode } from "../../api";

export type NodeMap = Record<string, EvidenceNode>;

// ── Real captures (HelloWorld sandbox) ──

export const HELLO_WORLD_ROOT_ID = "WA:RF:b6f6d1377feeecd7a3430cfdc9b13652fc3cf0a5166395a76c5224421d2aa83f";
export const HELLO_WORLD_INJECTED_ID = "WA:IF:a51306b4df52b8a191cb6390010d59231d396dde860dea754c6186f681684f44";
export const HELLO_WORLD_KM_ID = "WA:KF:c8e1a2e9e0655568e88e27202fdf21e9002bab427ccdae0219f0d7694205e9b7";
export const HELLO_WORLD_SESSION_ID = "134ecd6b-7538-4a25-9316-01cf19629f59";

export const HELLO_WORLD_ROOT: EvidenceNode = {
  factID: "WA:RF:b6f6d1377feeecd7a3430cfdc9b13652fc3cf0a5166395a76c5224421d2aa83f",
  source: "rule",
  fact: {
    subject: { type: "person", value: "Tom", dataType: "string" },
    relationship: { type: "speaks" },
    object: { type: "language", value: "French", dataType: "string" },
    certainty: 71,
  },
  time: 1791387787319,
  rule: {
    bindings: { COUNTRY: "France", O: "French", S: "Tom" },
    conditions: [
      {
        certainty: 90,
        factID: "WA:IF:a51306b4df52b8a191cb6390010d59231d396dde860dea754c6186f681684f44",
        factKey: "5bc4d50b-95d5-42bf-acba-464e8289f013",
        impact: 33.75,
        object: "France",
        objectType: "string",
        relationship: "lives in",
        salience: 100,
        subject: "Tom",
      },
      {
        certainty: 100,
        factID: "WA:KF:c8e1a2e9e0655568e88e27202fdf21e9002bab427ccdae0219f0d7694205e9b7",
        impact: 37.5,
        object: "French",
        objectType: "string",
        relationship: "national language",
        salience: 100,
        subject: "France",
      },
    ],
    ruleMaxCertainty: 75,
  },
};

export const HELLO_WORLD_INJECTED: EvidenceNode = {
  factID: "WA:IF:a51306b4df52b8a191cb6390010d59231d396dde860dea754c6186f681684f44",
  source: "injection",
  fact: {
    subject: { type: "person", value: "Tom", dataType: "string" },
    relationship: { type: "lives in" },
    object: { type: "country", value: "France", dataType: "string" },
    certainty: 90,
  },
  time: 1791387786934,
};

export const HELLO_WORLD_KM: EvidenceNode = {
  factID: "WA:KF:c8e1a2e9e0655568e88e27202fdf21e9002bab427ccdae0219f0d7694205e9b7",
  source: "km",
  fact: {
    subject: { type: "country", value: "France", dataType: "string" },
    relationship: { type: "national language" },
    object: { type: "language", value: "French", dataType: "string" },
    certainty: 100,
  },
  time: 1791387786776,
};

export const HELLO_WORLD: NodeMap = {
  [HELLO_WORLD_ROOT_ID]: HELLO_WORLD_ROOT,
  [HELLO_WORLD_INJECTED_ID]: HELLO_WORLD_INJECTED,
  [HELLO_WORLD_KM_ID]: HELLO_WORLD_KM,
};

// ── "has total income" = sumObjects over three incomes ──

export const INCOME_ROOT_ID = "WA:RF:7a1c0de5income0total";
export const INCOME_INJECTED_ID = "WA:IF:1f00income0injected";
export const INCOME_ANSWER_ID = "WA:AF:2f00income0answered";
export const INCOME_KM_ID = "WA:KF:3f00income0map";
/** The function key: the call as the engine evaluated it. */
export const INCOME_CALL = "sumObjects( 'Tom', 'has income', *)";
/** The expression as written in the rule. */
export const INCOME_TEXT = "sumObjects(%S, 'has income', *)";

const person = (value: string) => ({ type: "person", value, dataType: "string" });
const money = (value: number) => ({ type: "income", value, dataType: "number" });

export const INCOME: NodeMap = {
  [INCOME_ROOT_ID]: {
    factID: INCOME_ROOT_ID,
    source: "rule",
    fact: { subject: person("Tom"), relationship: { type: "has total income" }, object: { type: "total", value: 4500, dataType: "number" }, certainty: 100 },
    time: 1791387790000,
    rule: {
      bindings: { O: { value: 4500, type: "number" }, S: "Tom" },
      conditions: [
        {
          expression: {
            functions: {
              [INCOME_CALL]: {
                facts: [
                  { certainty: 100, factID: INCOME_INJECTED_ID, factKey: "0a1b", object: 1500, objectType: "number", relationship: "has income", subject: "Tom" },
                  { certainty: 90, factID: INCOME_ANSWER_ID, factKey: "0a1c", object: 2000, objectType: "number", relationship: "has income", subject: "Tom" },
                  { certainty: 100, factID: INCOME_KM_ID, object: 1000, objectType: "number", relationship: "has income", subject: "Tom" },
                ],
                result: { type: "number", value: 4500 },
              },
            },
            text: INCOME_TEXT,
            value: "%O",
          },
          impact: 100,
          salience: 100,
          wasMet: true,
        },
      ],
      ruleMaxCertainty: 100,
    },
  },
  [INCOME_INJECTED_ID]: {
    factID: INCOME_INJECTED_ID,
    source: "injection",
    fact: { subject: person("Tom"), relationship: { type: "has income" }, object: money(1500), certainty: 100 },
  },
  [INCOME_ANSWER_ID]: {
    factID: INCOME_ANSWER_ID,
    source: "answer",
    fact: { subject: person("Tom"), relationship: { type: "has income" }, object: money(2000), certainty: 90 },
  },
  [INCOME_KM_ID]: {
    factID: INCOME_KM_ID,
    source: "km",
    fact: { subject: person("Tom"), relationship: { type: "has income" }, object: money(1000), certainty: 100 },
  },
};

// ── A loan rule: a nested rule, an unmet optional condition, expressions, a zero-weight condition ──
// Weights 100 + 50 + 100 + 0 + 100 = 350 and cap 80, so a full condition of weight 100 is worth 22.86.

export const LOAN_ROOT_ID = "WA:RF:9b2e0loan0premium";
/** The engine's ID for every unmet optional condition's 0% stand-in: never stored, never fetchable. */
export const SYNTHESIS_ID = "WA:XX";
export const LOAN_LIVES_ID = "WA:IF:5d4e0lives0in0france";

export const LOAN: NodeMap = {
  ...INCOME,
  [LOAN_ROOT_ID]: {
    factID: LOAN_ROOT_ID,
    source: "rule",
    fact: { subject: person("Tom"), relationship: { type: "qualifies for" }, object: { type: "product", value: "premium loan", dataType: "string" }, certainty: 46 },
    rule: {
      alt: "Tom qualifies on income",
      bindings: { O: "premium loan", S: "Tom", TOTAL: { value: 4500, type: "number" } },
      conditions: [
        {
          // The engine sends alt filled in; placeholders are kept here to exercise substituteAlt.
          alt: "{{%S}} earns {{%TOTAL}} a year",
          certainty: 100,
          factID: INCOME_ROOT_ID,
          impact: 22.86,
          object: 4500,
          objectType: "number",
          relationship: "has total income",
          salience: 100,
          subject: "Tom",
        },
        // Optional and not met: the engine filled it with a 0% synthesised fact (no wasMet on relationship conditions).
        { certainty: 0, factID: SYNTHESIS_ID, impact: 0, object: "Ann", objectType: "string", relationship: "has guarantor", salience: 50, subject: "Tom" },
        { expression: { text: "%TOTAL > 3000" }, impact: 22.86, salience: 100, wasMet: true },
        {
          certainty: 90,
          factID: LOAN_LIVES_ID,
          impact: 0,
          object: "France",
          objectType: "string",
          relationship: "lives in",
          salience: 0,
          subject: "Tom",
        },
        // Optional and false.
        { expression: { text: "%TOTAL > 10000" }, impact: 0, salience: 100, wasMet: false },
      ],
      ruleMaxCertainty: 80,
    },
  },
  [LOAN_LIVES_ID]: {
    factID: LOAN_LIVES_ID,
    source: "injection",
    fact: { subject: person("Tom"), relationship: { type: "lives in" }, object: { type: "country", value: "France", dataType: "string" }, certainty: 90 },
  },
};

// ── The engine's "Evidence With Dates" test: three date answers, each tested by an expression ──
// Six conditions of weight 100, cap 100: every impact is 100 ÷ 6 = 16.67, expressions included.

export const DATES_ROOT_ID = "WA:RF:d47e0dates0result";
export const DATES_LOWEST_ID = "WA:AF:d47e0lowest";
export const DATES_HIGHEST_ID = "WA:AF:d47e0highest";
export const DATES_MIDDLE_ID = "WA:AF:d47e0middle";
/** 1990-01-01, 1990-10-10 and 1990-05-05 at UTC midnight. */
export const DATE_LOWEST = 631152000000;
export const DATE_HIGHEST = 655516800000;
export const DATE_MIDDLE = 641865600000;

const dateAnswer = (factID: string, relationship: string, concept: string, value: number): EvidenceNode => ({
  factID,
  source: "answer",
  fact: { subject: { type: "person", value: "David", dataType: "string" }, relationship: { type: relationship }, object: { type: concept, value, dataType: "date" }, certainty: 100 },
});
const dateCondition = (factID: string, relationship: string, value: number) => ({
  certainty: 100,
  factID,
  impact: 16.67,
  object: value,
  objectType: "date",
  relationship,
  salience: 100,
  subject: "David",
});
const dateTest = (text: string) => ({ expression: { text }, impact: 16.67, salience: 100, wasMet: true });

export const DATES: NodeMap = {
  [DATES_ROOT_ID]: {
    factID: DATES_ROOT_ID,
    source: "rule",
    fact: { subject: { type: "person", value: "David", dataType: "string" }, relationship: { type: "gets result of" }, object: { type: "result", value: "result a", dataType: "string" }, certainty: 100 },
    rule: {
      bindings: {
        HIGHEST_DATE: { type: "date", value: DATE_HIGHEST },
        LOWEST_DATE: { type: "date", value: DATE_LOWEST },
        MIDDLE_DATE: { type: "date", value: DATE_MIDDLE },
        O: "result a",
        S: "David",
      },
      conditions: [
        dateCondition(DATES_LOWEST_ID, "has lowest date of", DATE_LOWEST),
        dateTest("(%LOWEST_DATE = 1990-01-01)"),
        dateCondition(DATES_HIGHEST_ID, "has highest date of", DATE_HIGHEST),
        dateTest("(%HIGHEST_DATE = 1990-10-10)"),
        dateCondition(DATES_MIDDLE_ID, "has middle date of", DATE_MIDDLE),
        dateTest("(%MIDDLE_DATE = 1990-05-05)"),
      ],
      ruleMaxCertainty: 100,
    },
  },
  [DATES_LOWEST_ID]: dateAnswer(DATES_LOWEST_ID, "has lowest date of", "lowest date", DATE_LOWEST),
  [DATES_HIGHEST_ID]: dateAnswer(DATES_HIGHEST_ID, "has highest date of", "highest date", DATE_HIGHEST),
  [DATES_MIDDLE_ID]: dateAnswer(DATES_MIDDLE_ID, "has middle date of", "middle date", DATE_MIDDLE),
};

// ── The engine's "Numerical Function Over Empty List" test ──
// Four optional weight-10 tests over an empty list are false (min/max return null, sum/count 0);
// "1 = 1" (weight 100) carries the rule: 100 × 100 ÷ 140 = 71.43, each weight-10 maximum 7.14.

export const EMPTY_LIST_ROOT_ID = "WA:RF:e0e0empty0check";

const overEmptyList = (fn: string, text: string, value: number | null) => ({
  expression: { functions: { [`${fn}( 'Nigel', 'always empty', *)`]: { facts: [], result: { type: "number", value } } }, text },
  impact: 0,
  salience: 10,
  wasMet: false,
});

export const EMPTY_LIST: NodeMap = {
  [EMPTY_LIST_ROOT_ID]: {
    factID: EMPTY_LIST_ROOT_ID,
    source: "rule",
    fact: { subject: { type: "Person", value: "Nigel", dataType: "string" }, relationship: { type: "perform empty check" }, object: { type: "Check", value: true, dataType: "truth" }, certainty: 71 },
    rule: {
      bindings: { O: { type: "boolean", value: true }, S: "Nigel" },
      conditions: [
        overEmptyList("minObjects", "minObjects( %S, 'always empty', *) = 1000", null),
        overEmptyList("maxObjects", "maxObjects( %S, 'always empty' , *) = 1000", null),
        overEmptyList("sumObjects", "sumObjects( %S, 'always empty', *) = 2000", 0),
        overEmptyList("countRelationshipInstances", "countRelationshipInstances( %S, 'always empty', *) = 5", 0),
        { expression: { text: "1 = 1", value: "%O" }, impact: 71.43, salience: 100, wasMet: true },
      ],
      ruleMaxCertainty: 100,
    },
  },
};

// ── An optional condition the engine skipped (its object was never bound) ──
// The engine leaves it out of the payload but still counts its weight (40): total 240,
// so each reported condition of weight 100 has impact (and maximum) 41.67, not 50.

export const SKIPPED_ROOT_ID = "WA:RF:5k1p0eligible";
export const SKIPPED_INCOME_ID = "WA:AF:5k1p0income";

export const SKIPPED: NodeMap = {
  [SKIPPED_ROOT_ID]: {
    factID: SKIPPED_ROOT_ID,
    source: "rule",
    fact: { subject: person("Tom"), relationship: { type: "is eligible for" }, object: { type: "scheme", value: "grant", dataType: "string" }, certainty: 83 },
    rule: {
      bindings: { INCOME: { value: 2000, type: "number" }, O: "grant", S: "Tom" },
      conditions: [
        { certainty: 100, factID: SKIPPED_INCOME_ID, impact: 41.67, object: 2000, objectType: "number", relationship: "has income", salience: 100, subject: "Tom" },
        { expression: { text: "%INCOME > 1000" }, impact: 41.67, salience: 100, wasMet: true },
      ],
      ruleMaxCertainty: 100,
    },
  },
  [SKIPPED_INCOME_ID]: {
    factID: SKIPPED_INCOME_ID,
    source: "answer",
    fact: { subject: person("Tom"), relationship: { type: "has income" }, object: money(2000), certainty: 100 },
  },
};

// ── The OpenAPI 200 example (GET /analysis/evidence): seven relationship conditions, a list function whose
//    three facts share one factID (three values of a plural answer), and a test whose value is "%O" ──

export const CLAIM_ROOT_ID = "WA:RF:82a7b990eb2fe491389f37de10b1cd752cbd692b8c2c0d3fb36b354491f68173";
export const CLAIM_HOLDS_ID = "WA:IF:af4d81cc4d1175c0c488d6632599f718520366541ce99e61fc83eff7f640749a";
export const CLAIM_PLURAL_ID = "WA:AF:6ee11124ef7abd40707e1813a4d0b7851d86f1c36e42eaf3e559f02f441668e5";
export const CLAIM_CALL = "countRelationshipInstances( 'Ben', 'has previously claimed', *)";

const CLAIM_CONDITIONS: [string, string, string, string, string?][] = [
  // factID, subject, relationship, object, factKey
  [CLAIM_HOLDS_ID, "Ben", "holds", "Gold", "9c141933-344b-4d36-a3ef-ffdd96fbcb81"],
  ["WA:KF:c2a63a881f856798e2df8999d7b7956bc28dd50e8e99d6728ca46730955263c1", "Gold", "provides", "repair"],
  ["WA:AF:82b2bc07382e0372685aa06e30b1c9db95ccc30051cfc2ea3de4c2e7fc69d0c6", "Ben", "suffered", "water damage", "04b02c60-73c1-436c-b0d3-1ee44df7c14b"],
  ["WA:KF:cb08149770bded892f06d37433c305f4f4667837323167d21580b24de3a9c5dd", "repair", "appropriate for", "water damage"],
  ["WA:KF:ec6e5652be4a48515d68c795b0497e87d6beeb83a384c4ae11ca562c6ba0e499", "Gold", "insures", "mobile phone"],
  ["WA:AF:c6a366105ea7691fffae2e75fe27293bd66b4155d352213cee51368272af07b6", "water damage", "happened to", "mobile phone", "22667649-4df6-4731-9498-e4eb9c25d22c"],
  ["WA:KF:7467c2c1c00149ac477f0246173ef9cb19d08243624b52ddf8a7e05791cd5550", "Gold", "covers", "water damage"],
];

const claimed = (object: string) => ({
  certainty: 100,
  factID: CLAIM_PLURAL_ID,
  factKey: "5a337648-3fa1-46ec-b67e-7f0aa5662863",
  object,
  objectType: "string",
  relationship: "has previously claimed",
  subject: "Ben",
});

/** The source a factID prefix stands for in these captures (the OpenAPI enum spells the map "knowledgemap"). */
const sourceOf = (factId: string): EvidenceNode["source"] =>
  factId.startsWith("WA:IF:") ? "injection" : factId.startsWith("WA:AF:") ? "answer" : "knowledgemap";

export const CLAIM: NodeMap = {
  [CLAIM_ROOT_ID]: {
    factID: CLAIM_ROOT_ID,
    source: "rule",
    fact: {
      subject: { type: "policy holder", value: "Ben", dataType: "string" },
      relationship: { type: "can claim" },
      object: { type: "claim", value: "repair", dataType: "string" },
      certainty: 100,
    },
    time: 1752142054143,
    rule: {
      bindings: { EQUIPMENT: "mobile phone", LOSS: "water damage", O: "repair", POLICY: "Gold", S: "Ben" },
      conditions: [
        ...CLAIM_CONDITIONS.map(([factID, subject, relationship, object, factKey]) => ({
          certainty: 100,
          factID,
          ...(factKey ? { factKey } : {}),
          impact: 14.29,
          object,
          objectType: "string",
          relationship,
          salience: 100,
          subject,
        })),
        {
          expression: {
            functions: { [CLAIM_CALL]: { facts: [claimed("laptop"), claimed("headphones"), claimed("bicycle")], result: { type: "number", value: 3 } } },
            text: CLAIM_CALL,
            value: "%RELS",
          },
          impact: 14.29,
          salience: 100,
          wasMet: true,
        },
        { expression: { text: "%RELS is less than 10", value: "%O" }, impact: 14.29, salience: 100, wasMet: true },
      ],
      ruleMaxCertainty: 100,
    },
  },
  ...Object.fromEntries(
    CLAIM_CONDITIONS.map(([factID, subject, relationship, object]) => [
      factID,
      {
        factID,
        source: sourceOf(factID),
        fact: { subject: { value: subject, dataType: "string" }, relationship: { type: relationship }, object: { value: object, dataType: "string" }, certainty: 100 },
      },
    ])
  ),
  [CLAIM_PLURAL_ID]: {
    factID: CLAIM_PLURAL_ID,
    source: "answer",
    fact: {
      subject: { type: "policy holder", value: "Ben", dataType: "string" },
      relationship: { type: "has previously claimed" },
      object: { type: "item", value: "laptop", dataType: "string" },
      certainty: 100,
    },
  },
};

// ── Repeat: the same rule-derived fact satisfies two conditions ──

export const REPEAT_ROOT_ID = "WA:RF:aa00repeat0root";

export const REPEAT: NodeMap = {
  ...INCOME,
  [REPEAT_ROOT_ID]: {
    factID: REPEAT_ROOT_ID,
    source: "rule",
    fact: { subject: person("Tom"), relationship: { type: "is creditworthy" }, object: { value: "yes" }, certainty: 100 },
    rule: {
      conditions: [
        { certainty: 100, factID: INCOME_ROOT_ID, impact: 50, object: 4500, relationship: "has total income", salience: 100, subject: "Tom" },
        { certainty: 100, factID: INCOME_ROOT_ID, impact: 50, object: 4500, relationship: "has total income", salience: 100, subject: "Tom" },
      ],
      ruleMaxCertainty: 100,
    },
  },
};

// ── Cycle: A depends on B, B depends on A ──

export const CYCLE_A_ID = "WA:RF:cc00cycle0a";
export const CYCLE_B_ID = "WA:RF:cc00cycle0b";

export const CYCLE: NodeMap = {
  [CYCLE_A_ID]: {
    factID: CYCLE_A_ID,
    source: "rule",
    fact: { subject: person("Ann"), relationship: { type: "trusts" }, object: { value: "Bob" }, certainty: 80 },
    rule: { conditions: [{ certainty: 80, factID: CYCLE_B_ID, impact: 80, object: "Ann", relationship: "trusts", salience: 100, subject: "Bob" }], ruleMaxCertainty: 100 },
  },
  [CYCLE_B_ID]: {
    factID: CYCLE_B_ID,
    source: "rule",
    fact: { subject: person("Bob"), relationship: { type: "trusts" }, object: { value: "Ann" }, certainty: 80 },
    rule: { conditions: [{ certainty: 80, factID: CYCLE_A_ID, impact: 80, object: "Bob", relationship: "trusts", salience: 100, subject: "Ann" }], ruleMaxCertainty: 100 },
  },
};

// ── A fake GET /analysis/evidence ──

export interface FakeFetch {
  (factId: string): Promise<EvidenceNode>;
  /** factIDs requested, in call order. */
  calls: string[];
  /** Most requests in flight at once. */
  peak: number;
}

/**
 * A fetcher over a node map. Every response is a fresh JSON copy, like the
 * real API. `delay` (ms, per factID) reorders responses; `fail` rejects the
 * listed factIDs with the given error.
 */
export function fakeFetch(nodes: NodeMap, opts: { delay?: (factId: string) => number; fail?: Record<string, Error> } = {}): FakeFetch {
  let inFlight = 0;
  const fetcher = (async (factId: string) => {
    fetcher.calls.push(factId);
    inFlight++;
    fetcher.peak = Math.max(fetcher.peak, inFlight);
    try {
      const wait = opts.delay?.(factId) ?? 0;
      await new Promise((resolve) => setTimeout(resolve, wait));
      const failure = opts.fail?.[factId];
      if (failure) throw failure;
      const node = nodes[factId];
      if (!node) throw new Error(`Rainbird API 404 on /analysis/evidence/${factId}/session: not found`);
      return JSON.parse(JSON.stringify(node)) as EvidenceNode;
    } finally {
      inFlight--;
    }
  }) as FakeFetch;
  fetcher.calls = [];
  fetcher.peak = 0;
  return fetcher;
}
