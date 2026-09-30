/**
 * Knowledge reference, part 6: validation (what the linter and the platform
 * reject), authoring patterns and common mistakes.
 */

export const VALIDATION_SECTION = `## 16. Validation

This extension's linter runs on every keystroke and produces the same findings the assistant's diagnostics tools return. It mirrors Studio's validator plus semantic checks. In plain words:

Errors (the platform will reject the map or the rule is broken):
- Structure: missing or duplicated \`<rbl:kb>\` root; unrecognised element; element not allowed inside its parent (e.g. \`<condition>\` at top level); mismatched, unexpected or missing closing tag; text outside an element; malformed or unbalanced attribute quotes; duplicate attribute on a tag (first value wins).
- Attributes: required attribute missing or empty; unknown enum value (\`type="text"\`, \`askable="sometimes"\`); names containing \`" \\ < >\`.
- Declarations: duplicate concept; duplicate relationship name; unknown concept in a rel's subject/object; unknown concept type on an instance; unknown relationship type on a relinst; unknown relationship in a condition or datasource input.
- Types: relationship subject is not a string concept; instance declared for a non-string concept; fact object does not match the object type (non-numeric for number; more than 15 digits; date not ISO/epoch; truth not lowercase true/false).
- Facts and rules: a fact without subject or object; \`cf\` outside 0–100; \`minimum-rule-certainty\` above \`cf\`; custom variable in a rule header; a condition mixing rel/subject/object with expression; negative or non-integer weight; every condition weighted 0.
- Expressions: unknown function name; unbalanced parentheses; unbalanced single quote.
- Datasources: hostname not starting with http(s)://; an input whose variable is the wrong concept for the relationship.

Warnings (accepted but probably wrong):
- Unrecognised attribute; duplicate instance; duplicate fact; a fact or header referencing an instance that is not declared, or declared under a different concept; a mutually-exclusive concept without exactly two instances.
- Question wording: firstForm missing \`%S\` or \`%O\`; secondFormObject missing \`%S\` or containing \`%O\`; secondFormSubject missing \`%O\` or containing \`%S\`.
- Expression evaluates left to right in a way that differs from conventional precedence (add parentheses).
- Relationship can only be satisfied by injected facts (not askable, no facts, rules or datasource); rule can never fire without injected facts.

Information:
- Legacy spelling (\`boolean\` → \`truth\`); concept not used by any relationship; relationship declared but never used; recursive rule (cycle listed).

The platform's own validator (on push) additionally reports one problem per upload with messages like "Relationship X expects a date as its object" or "The concept X is mutually-exclusive and should define 2 instances".

Official validation checklist for generated RBLang: (1) all concepts defined before use; (2) only string, number, date, truth types; (3) relationship names unique; (4) names read naturally; (5) no instances for number/date/truth concepts; (6) concepts at the right level of abstraction; (7) every referenced concept exists; (8) every referenced instance exists; (9) relationships defined before facts and rules use them; (10) relationship subjects are string concepts; (11) primitive object values written directly; (12) rule variables consistent throughout a rule; (13) object values match the relationship's object type; (14) string literals in expressions single-quoted; (15) assignment via the \`value\` attribute; (16) missing facts tested with countRelationshipInstances(); (17) rules work for the general case; (18) expressions use supported syntax only; (19) each required query has a matching relationship; (20) every concept is connected to the graph.`;

export const PATTERNS_SECTION = `## 17. Authoring patterns

- **Decision outcome**: a mutually-exclusive string concept ("Decision": Approve / Decline) with an \`askable="none"\` relationship ("has decision") and one rule per outcome, each fixing \`object="Approve"\` or \`object="Decline"\`. Query the relationship as an object query.
- **Derived value**: a number/date concept, an \`askable="none"\` relationship, and a rule that binds inputs then assigns \`value="%O"\` (age from date of birth; total from a plural relationship).
- **Threshold band**: bind the value, test with \`isWithinRange\` or comparisons; one rule per band.
- **Weighted scoring**: several optional conditions with weights reflecting importance, rule cf as the ceiling, \`minimum-rule-certainty\` as the cut-off; read the result's certainty as the score.
- **Gate then evaluate**: \`behaviour="top-down-strict"\` with a cheap mandatory knock-out condition first, then the expensive or question-heavy conditions.
- **Absence / missing data**: \`countRelationshipInstances(%S, 'relationship', *) is equal to 0\` in an expression condition (there is no null); pair with a positive rule that requires \`is greater than 0\`.
- **Aggregation over a list**: plural relationship; \`countRelationshipInstances\` and \`sumObjects\` bound to variables; guard the count; compute.
- **Lookup through a chain**: bind an intermediate (\`%COUNTRY\` via "lives in"), then use it as the subject of another relationship ("national language").
- **Set containment**: \`isSubset(%O, 'requires skills', *, %S, 'has skills', *)\` for "candidate has every required skill" — both relationships plural.
- **Good questions**: write all applicable forms in the user's words, mention only the placeholders each form allows, group related questions with \`group\`, allow skipping (\`allowUnknown\`) where the data is genuinely optional, and use \`canAdd\` when the instance list cannot be exhaustive.
- **Evidence text**: an \`alt\` on every rule ("{{%S}} qualifies because …") and, where useful, on conditions; use dot-traversal for context ({{%COUNTRY.is in continent}}).
- **Avoid unintended recursion**: a rule for R that depends on R must have a path that terminates (base facts); otherwise restructure with an intermediate relationship.
- **Naming**: title-case concepts, lowercase verb-phrase relationships, natural instance names; reuse the map's existing vocabulary rather than inventing synonyms; name every rule.`;

export const MISTAKES_SECTION = `## 18. Common mistakes

- Custom variable in a rule header (\`<relinst type="…" subject="%PERSON">\`) — only literals, \`%S\` or \`%O\`.
- Assigning with \`=\` (\`expression="%O = %X * 2"\`) — use \`expression="%X * 2" value="%O"\`.
- Assuming operator precedence — \`%A + %B * 2\` is \`(%A + %B) * 2\`; parenthesise.
- Comparing dates with \`<\`/\`>\` or \`is greater than\` — use isBeforeDate/isAfterDate/isSameDate/isWithinRange.
- Testing for null/empty — use countRelationshipInstances(...) is equal to 0.
- Non-string concept as a relationship subject; instance declared for a number/date/truth concept.
- Two relationships with the same name (even with different subjects).
- \`cf\` above 100; \`minimum-rule-certainty\` above \`cf\`; all weights 0.
- \`askable="none"\` on a relationship the user is meant to answer (the query silently gets no result); or, conversely, leaving a derived relationship askable so the engine asks the user for a value a rule should compute.
- Fixed \`object=\` in a rule header that is not a declared instance of the object concept (typo → the outcome is never offered).
- Inventing \`firstFormObject\`/\`firstFormSubject\`; only firstForm, secondFormObject and secondFormSubject exist.
- \`TRUE\`/\`True\`/\`yes\` as truth values — lowercase \`true\`/\`false\` only; long-form dates — ISO YYYY-MM-DD only.
- Double quotes for string literals inside expressions — single quotes only.
- Unquoted relationship names inside list functions — quote them: \`'has score'\`.
- A variable used once — it binds nothing; either use it again or replace with \`*\` in list functions.
- Mutually-exclusive concept with one or three instances.
- Forgetting question wording for the forms \`askable\` permits, or writing \`%O\` inside secondFormObject.
- "Fixing" unknown-name diagnostics that actually refer to names from an \`<import>\`ed map.`;
