/**
 * Knowledge reference, part 5: how the Reasoning Engine works — the certainty
 * model, Match → Infer → Ask, query forms and evidence. Also the short system
 * prompt used when narrating an evidence tree to a business user.
 */

export const CERTAINTY_SECTION = `## 13. The certainty model

Certainty is a **confidence score from 0 to 100, not a probability**. Facts carry it; rules propagate and cap it.

How a rule computes the certainty of the fact it infers (as documented and shown in Studio's salience chart):
1. Each condition has a weight (default 100). Its **maximum possible impact** is the rule's \`cf\` shared out in proportion to weight: max impact = cf × weight ÷ (sum of weights).
2. Its **actual impact** scales that maximum by the certainty of the fact that satisfied it: impact = max impact × (fact certainty ÷ 100). An unmet *optional* condition counts as a synthetic fact with certainty 0, so impact 0. A weight-0 condition has impact 0 whatever its certainty ("zero salience").
3. The inferred fact's certainty is the **sum of the impacts**, rounded — so it can never exceed \`cf\`, and it only reaches \`cf\` when every condition is met with 100% facts.
4. If the sum is below \`minimum-rule-certainty\` (default 20) no fact is produced.

Worked example — rule cf 90, three conditions weighted 50, 30, 20:
- max impacts 45, 27, 18.
- facts satisfying them have certainty 100, 80, and the third (optional) is unmet → impacts 45, 21.6, 0 → certainty **67**.
- had all three been 100% → 90; had the rule been cf 100 with equal weights and the same facts → 33.3 + 26.7 + 0 = **60**.

Design levers: use \`cf\` for "how much do I trust this rule as a whole"; use weights for "which evidence matters most"; use optional conditions for evidence that should raise confidence without being required; use \`minimum-rule-certainty\` to suppress weak inferences; give hard-coded facts a cf below 100 when they are themselves uncertain. Users answering questions may attach their own certainty (\`allowCF\`), which then flows through the same arithmetic. When several rules infer the same fact the engine reports the resulting facts with their certainties; the documented arithmetic above is per rule.`;

export const ENGINE_SECTION = `## 14. How the engine reasons

The engine is goal-driven and backward-chaining: a **query** names a relationship and one or both ends, and the engine works out what it needs to answer it.

Three query forms (Hello World: Person speaks Language):
- **Object query** — "Julio speaks ?" (subject given): the most common; returns objects with certainty.
- **Subject query** — "? speaks French" (object given): returns subjects.
- **Certainty / first-form query** — "Julio speaks French ?" (both given): returns how certain that fact is.
Any relationship can be queried, but useful goals are relationships with rules. Querying a relationship that is only askable makes the engine abandon the query rather than ask you the question you asked it.

For each condition it must satisfy, the engine follows **Match → Infer → Ask (MIA)**:
1. **Match** — look for an existing fact: hard-coded in the map, injected into the session, already created earlier in this session (answers, inferences), or obtainable from a datasource.
2. **Infer** — otherwise run every rule whose header could produce such a fact (recursively applying MIA to their conditions).
3. **Ask** — otherwise, if the relationship is askable in a suitable form, ask the user. The answer becomes a session fact and matching is retried. Questions from relationships sharing a \`group\` and subject are presented together. With \`allowUnknown\` the user may skip; with \`allowCF\` they may state confidence; with \`canAdd\` they may type a new instance.

Behaviour notes:
- **Plural** relationships make the engine seek *all* facts: it runs every applicable rule pass and asks multi-select questions. Singular relationships stop at the first satisfying fact.
- Condition ordering is automatic unless the rule says \`top-down\` / \`top-down-strict\` (section 7). Ordering matters when one condition binds a variable another needs, or when a cheap test should short-circuit an expensive or intrusive one.
- Within a session, facts accumulate: a second query reuses everything already known, so multi-decision flows ask fewer questions.
- A query that cannot be answered returns no result (not an error). Common causes: the goal relationship has no rules and no facts; every path needs a fact from an \`askable="none"\` relationship nobody injected; a mandatory condition's relationship has no instances for the user to choose.

Evidence: every result fact has an **evidence tree**. Each node is a fact with its certainty and provenance — inferred by a **rule** (dark blue; expandable to its conditions), computed by a **list function** (light blue), **injected** via API (light green), given as a user **answer** (red), fetched from a **datasource** (dark green), or **hard-coded in the map** (orange). Rule nodes show the rule's evidence text (\`alt\`) when set, and the **salience chart** shows each condition's impact. Evidence is what makes a Rainbird decision auditable; write \`alt\` text with the reader of that tree in mind.`;

/** System prompt for narrating an evidence tree to a business user (query panel "Explain"). */
export const EXPLAIN_SYSTEM_PROMPT = `You explain Rainbird decisions to business users. You are given an evidence tree (JSON) for one inferred fact, and sometimes the RBLang of the map. Write a short plain-English narrative: what was concluded and how certain it is, which facts and rules led there, and why the certainty is what it is (rule certainty cap, condition weights, less-than-certain inputs, unmet optional conditions). Label each contributing fact by where it came from: told to us (answer or injected), inferred by a rule, from a datasource, or built into the map. No code, no XML, no jargon about RBLang attributes; refer to rules by their names or evidence text. Be concise: a short paragraph, then one brief bullet per contributing fact.`;
