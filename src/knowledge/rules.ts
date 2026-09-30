/**
 * Knowledge reference, part 3: rules, conditions, variables and the expression
 * language. Clean-room prose derived from Rainbird's public RBLang reference
 * and rules documentation.
 */

export const RULES_SECTION = `## 7. Rules

A rule is a \`<relinst>\` **with** \`<condition>\` children. The header describes the fact the rule can create; the conditions describe when.

\`\`\`rblang
<relinst type="speaks" cf="75" name="Speaks national language of home country"
         alt="{{%S}} lives in {{%COUNTRY}}, whose national language is {{%O}}">
  <condition rel="lives in" subject="%S" object="%COUNTRY" weight="100" behaviour="mandatory"/>
  <condition rel="national language" subject="%COUNTRY" object="%O" weight="100" behaviour="mandatory"/>
</relinst>
\`\`\`

Header attributes:
- \`type\` (required): the relationship being inferred.
- \`subject\` / \`object\` (optional): fix one side to a **literal instance name**. When omitted, that side is the rule's \`%S\` / \`%O\` variable and is bound by the conditions. Custom variables (\`%PERSON\`) are **never** allowed in the header — only literals, \`%S\` or \`%O\`. The common "outcome rule" fixes the object: \`<relinst type="has eligibility" object="Eligible" …>\` and lets \`%S\` range over subjects.
- \`cf\` (0–100, default 100): the **maximum** certainty of any fact this rule produces. Lower it to express that the rule itself is a heuristic ("probably speaks the national language": cf 75).
- \`minimum-rule-certainty\` (default 20, must be ≤ cf): if the computed certainty falls below this floor no fact is created at all. Note the hyphenated attribute name.
- \`behaviour\`: condition ordering. Omit for the default (the engine orders conditions itself for the best chance of success); \`top-down\` processes conditions in written order, skipping ones it cannot yet meet and retrying them later; \`top-down-strict\` processes in order and fails the rule the moment a mandatory condition cannot be met. Use top-down variants to gate expensive or question-heavy conditions behind cheap ones, or when a later condition depends on a variable an earlier one binds.
- \`name\` (optional, ≤170 chars, not necessarily unique): a human label shown in Studio, evidence and diffs. Name every non-trivial rule.
- \`alt\`: **evidence text** — the sentence shown in the evidence tree instead of the raw triple. Interpolate bindings with double braces: \`{{%S}}\`, \`{{%O}}\`, \`{{%COUNTRY}}\`; follow a relationship from a bound value with dot notation: \`{{%COUNTRY.is in continent}}\`.

Semantics:
- A rule fires for a given subject (and object, if fixed) when every **mandatory** condition is satisfied. It then asserts \`%S type %O\` with certainty computed from the conditions (section 13), capped at \`cf\`, discarded if below \`minimum-rule-certainty\`.
- Several rules may infer the same relationship — write one rule per way of concluding it (one per outcome instance, or one per reasoning path). Keep each rule about one result.
- A rule with only facts, no conditions, is not a rule — that is a fact. A rule must contain at least one condition or expression.
- Rules are re-usable across subjects: they should describe the general case, never hard-code values that only fit one example.
- Recursion (a rule for "is in" that depends on "is in") is legal and sometimes intended (transitive containment) but can loop; the linter reports the cycle so you can confirm it is deliberate.`;

export const CONDITIONS_SECTION = `## 8. Conditions

Three forms, one per \`<condition>\`; a condition is **either** a relationship pattern **or** an expression, never both.

1. **Relationship condition** — \`<condition rel="has age" subject="%S" object="%AGE"/>\`: looks for a fact \`subject has age object\`, binding any variables. Each of subject/object is a literal instance, a typed literal (for number/date/truth objects), \`%S\`, \`%O\` or a custom variable.
2. **Expression test** — \`<condition expression="%AGE is greater than or equal to 18"/>\`: evaluates to true/false using already-bound variables.
3. **Expression assignment** — \`<condition expression="yearsBetween(%DOB, today())" value="%O"/>\`: computes a value and binds it to the variable named in \`value\` (often \`%O\`, the rule's object). The \`value\` attribute is the **only** assignment mechanism; \`=\` inside an expression is always a comparison (\`%O = %X * 2\` is invalid).

Attributes on any condition:
- \`weight\` (integer ≥ 0, default 100): relative importance for the certainty calculation. Weights are relative to each other within the rule (100/100/100 = equal; 10/5/0 = first twice as important as second, third irrelevant to certainty). \`0\` means the condition may still be required but contributes nothing to certainty. The weights of a rule must not all be zero.
- \`behaviour\` (\`mandatory\` default | \`optional\`): all mandatory conditions must be met for the rule to fire; an unmet optional condition does not block the rule — the engine inserts a synthetic fact with 0% certainty so the condition contributes 0 impact and the resulting certainty is lower. Use optional conditions for "nice to have" evidence that raises confidence.
- \`alt\`: evidence text for this condition (same \`{{%VAR}}\` interpolation as on rules).
- \`salience\` and \`funct\` exist in the validator; they are not documented publicly and should not be introduced into maps.

Idioms:
- Bind then test: a relationship condition binds \`%AGE\`; an expression condition tests it.
- Derive a value: bind inputs, then assign the computed result to \`%O\` (with an \`askable="none"\` relationship so the engine never asks for a derived value).
- Absence check: \`<condition expression="countRelationshipInstances(%S, 'has conviction', *) is equal to 0"/>\` — there is no null test in the language.
- Chain a rule through another relationship: bind \`%COUNTRY\` via "lives in", then use \`%COUNTRY\` as the subject of "national language".`;

export const VARIABLES_SECTION = `## 9. Variables

- Variables start with \`%\`: \`%S\` and \`%O\` are reserved for the rule's subject and object; custom variables are written \`%UPPER_SNAKE_CASE\` (\`%AGE\`, \`%DATE_OF_BIRTH\`, \`%RISK_SCORE\`). Studio defaults a variable to the concept name (\`%PERSON\` for a Person), but any name works; two variables of the same concept type may coexist (\`%CUSTOMER\` and \`%ADVISER\` both Persons).
- A variable is *bound* by a relationship condition (as its subject or object) or by an assignment (\`value="%X"\`), and *consumed* by later expressions or relationship conditions. A variable that appears only once binds nothing to anything and is almost always a mistake; make every custom variable appear at least twice across the rule, or use \`*\`-style wildcards inside list functions instead.
- A variable keeps one concept type within a rule: reusing \`%X\` for a Person in one condition and a Country in another is an error ("the variable used is already a different concept").
- Never put a custom variable in the rule header. If you want the header to range over a subject or object, leave the attribute off and use \`%S\` / \`%O\` in the conditions.
- In evidence text, wrap variables in double braces: \`{{%S}}\`, \`{{%AGE}}\`.`;

export const EXPRESSIONS_SECTION = `## 10. Expression language

Expressions appear in \`expression="…"\` on conditions (and \`<input>\` elements). They combine variables, literals, operators and functions.

Literals: numbers (\`18\`, \`2.5\`, negative allowed), strings in **single quotes** (\`'Retired'\`; escape an apostrophe as \`\\'\`), truth \`true\` / \`false\`, and \`*\` as the "all" wildcard inside list functions. Dates are values bound from date concepts or produced by date functions — write date literals as \`'2024-01-31'\` only where a function documents accepting one.

Comparison operators, each with symbol and natural-language aliases (prefer the words; they read better and avoid XML escaping):
- \`=\`, \`equals\`, \`is equal to\` — string, number, truth
- \`!=\`, \`does not equal\`, \`is not equal to\` — string, number, truth
- \`>\` / \`gt\` / \`greater than\` / \`is greater than\`; \`>=\` / \`gte\` / \`is greater than or equal to\`; \`<\` / \`lt\` / \`is less than\`; \`<=\` / \`lte\` / \`is less than or equal to\` — numbers only. **Never compare dates with these**; use \`isBeforeDate\`, \`isAfterDate\`, \`isSameDate\` or \`isWithinRange\`.
- Truth tests: \`%ACTIVE = true\`, \`includes(%NAME, 'Ltd') = false\` (negation of a boolean function is written by comparing with false).

Arithmetic: \`+ - * /\` on numbers; \`+\` also concatenates strings (numbers, dates and truth values convert automatically; dates print as timestamps). **Evaluation is strictly left to right — there is no operator precedence.** \`%A + %B * 2\` means \`(%A + %B) * 2\`. Always parenthesise: \`%A + (%B * 2)\`. When a calculation is long, split it into several assignment conditions.

Logic: \`and\` / \`or\` (case-insensitive) between parenthesised comparisons: \`(%AGE is less than 25) or (%DRIVING_YEARS is less than 3)\`. Parenthesise every operand.

Functions (full signatures in section 20):
- **List functions** over facts, arguments \`(subject, 'relationship name', object)\` where each side is a variable, a literal, or \`*\` for all: \`countRelationshipInstances\`, \`sumObjects\`, \`minObjects\`, \`maxObjects\` (numeric objects), \`joinObjects\` (comma-joined string), and \`isSubset(s1, 'rel1', o1, s2, 'rel2', o2)\` (true when every object of the first pattern is among the objects of the second). Quote the relationship name. Filtering both sides with non-wildcards yields at most one fact, which makes a list function pointless. Most useful with plural relationships.
- **Absence**: \`countRelationshipInstances(%S, 'has conviction', *) is equal to 0\`. There is no null.
- **Strings**: \`includes(str, 'sub')\`, \`startsWith(str, 'pre')\`, \`endsWith(str, 'suf')\` (all case- and whitespace-sensitive, return true/false), \`regexCount(str, '/pattern/flags')\` (JavaScript regex in slashes, e.g. \`'/ltd|plc/gi'\`; returns the match count; negative results are errors: −1 unsafe pattern, −2 evaluation failed, −3 invalid syntax, −4 pattern > 500 chars, −5 input > 10,000 chars, −6 not in /pattern/flags format, −7 safety timeout). Concatenate with \`+\`.
- **Maths**: \`round(x, places)\` (places ≤ 15, default 0), \`ceil\`, \`floor\`, \`abs\`, \`min(a, b, …)\`, \`max(a, b, …)\`, \`mod(a, b)\`, \`pow(base, exp)\`, \`sqrt\`, \`factorial\`, \`tan\`, \`atan2\`, \`sec\`, \`csc\`, \`cot\`.
- **Dates** (inputs must come from date concepts or date functions): \`today()\` (midnight today) and \`now()\` return epoch-millisecond timestamps; \`dayOfWeek\`, \`dayOfMonth\`, \`dayOfYear\`, \`monthOfYear\`, \`year\`; \`addDays/Weeks/Months/Years(date, n)\`, \`subtractDays/Weeks/Months/Years(date, n)\`; \`secondsBetween\`, \`minutesBetween\`, \`hoursBetween\`, \`daysBetween\`, \`weeksBetween\`, \`monthsBetween\`, \`yearsBetween(a, b)\` (always non-negative, order-independent); \`isBeforeDate\`, \`isSameDate\`, \`isAfterDate(a, b)\`; \`isWithinRange(value, min, max)\` for numbers or dates, inclusive, bounds in either order.

Typical expressions:
- Age from date of birth: \`yearsBetween(%DOB, today())\` assigned to \`%O\`.
- Threshold: \`%SCORE is greater than or equal to 70\`.
- Band: \`isWithinRange(%AGE, 18, 65)\`.
- Average of a plural relationship: bind \`%COUNT\` and \`%SUM\` with list functions, guard \`%COUNT is greater than 0\`, then \`%SUM / %COUNT\` → \`%O\`.
- Text classification: \`regexCount(%DESCRIPTION, '/urgent|immediately/i') is greater than 0\`.`;
