/**
 * Knowledge reference, part 2: the RBLang language — document structure,
 * concepts, relationships, instances, facts, naming and limits. Clean-room
 * prose derived from Rainbird's public RBLang reference.
 */

export const STRUCTURE_SECTION = `## 2. RBLang document structure

RBLang is an XML dialect. Every document is:

\`\`\`rblang
<?xml version="1.0" encoding="utf-8"?>
<rbl:kb xmlns:rbl="http://rbl.io/schema/RBLang">
  <!-- content -->
</rbl:kb>
\`\`\`

- The XML declaration, the \`<rbl:kb>\` root and the exact namespace \`xmlns:rbl="http://rbl.io/schema/RBLang"\` are all required. The namespace URI is only an identifier (nothing is served there).
- Direct children of the root, in the recommended order: \`<concept>\`, \`<rel>\`, \`<concinst>\`, \`<relinst>\` (facts, then rules), plus the rarer \`<import>\` and \`<compound>\`. Nothing else may appear at the top level; \`<condition>\` only lives inside a \`<relinst>\`, \`<datasource>\` only inside a \`<concept>\`.
- Attribute values use double quotes. Inside them, escape \`&\` as \`&amp;\`, \`"\` as \`&quot;\` and \`<\` as \`&lt;\` (relevant in expressions such as \`%AGE &lt; 18\`; prefer the natural-language operators to avoid the issue). Apostrophes are fine in names and text.
- XML comments \`<!-- … -->\` are allowed anywhere and are ignored by the engine. CDATA is used for datasource request bodies and markdown metadata.
- Indentation is free-form; keep the file's existing style (this extension's formatter re-indents by nesting depth using the file's indent unit).
- File extensions: .rbl (preferred) or .rblang. Studio exports are .rbird.

Recommended authoring order — concepts → relationships → instances of string concepts → facts → rules. It is not enforced by the engine but avoids forward-reference mistakes, matches Studio's output and is what the linter's quick-insert commands assume.`;

export const CONCEPTS_SECTION = `## 3. Concepts

\`<concept name="Person" type="string"/>\`

- \`name\` (required, unique among concepts): a class of things, written as a title-case noun phrase ("Person", "Product Category", "Date Of Birth"). Never a value ("Two", "London").
- \`type\` (required): exactly one of \`string\`, \`number\`, \`date\`, \`truth\`. \`truth\` is the boolean type (the legacy spelling \`boolean\` is still accepted but should be \`truth\`).
- Only **string** concepts can be the *subject* of a relationship and only string concepts can have declared instances (\`<concinst>\`). number, date and truth concepts appear only as relationship *objects* and their values are written directly in facts and answers.
- \`behaviour="mutually-exclusive"\` (string concepts only; \`mutex\` and \`mx\` are accepted synonyms): the concept must declare exactly two instances and asserting one precludes the other — a custom yes/no ("Eligible" / "Not Eligible", "Approved" / "Declined"). Use it for decision outcomes so a query returns one answer.
- \`scope="context"\` marks a concept as session-context scoped (rare; leave it out unless the existing map uses it).
- A concept may contain a \`<datasource>\` child (see section 11); attach it to the concept that is the *subject* of the facts the datasource produces.
- Every concept should take part in at least one relationship; an unconnected concept is dead weight and the linter reports it.
- Changing a concept's type after instances, facts or rules use it breaks them; decide types up front.`;

export const RELATIONSHIPS_SECTION = `## 4. Relationships

\`<rel name="lives in" subject="Person" object="Country" plural="false" askable="all" allowCF="true" allowUnknown="false" canAdd="none" group="Person basics">\` … \`</rel>\`

Attributes:
- \`name\` (required, unique across the whole map, including against other relationships with different subjects): a lowercase verb phrase read subject-first ("has age", "lives in", "is eligible for"). Two relationships can never share a name.
- \`subject\` (required): a **string** concept. \`object\` (required): any concept.
- \`plural\` (default false): true when one subject may have several objects at once ("speaks" many languages, "has account flag" many flags). Plural changes engine behaviour: it keeps looking for *all* matching facts (running every applicable rule pass and asking multi-select questions) rather than stopping at the first. Use plural whenever list functions will aggregate the relationship.
- \`askable\`: which questions the engine may ask a user when it lacks a fact. \`all\` (second-form questions in both directions plus first-form yes/no confirmation), \`secondFormObject\` (only "given the subject, what is the object?" — the most common), \`secondFormSubject\` (only "given the object, who is the subject?"), \`none\` (never ask: the fact must come from the map, a rule, an injection, an import or a datasource). Legacy values \`true\` (= all) and \`false\` (= none) are still accepted. When the attribute is omitted the relationship is askable in every form (the same as \`all\`), so set \`askable="none"\` explicitly on relationships that rules or systems supply.
- \`allowCF\` (default true): the user may attach a certainty to an answer.
- \`allowUnknown\` (default false): the user may skip the question; the query continues without that fact.
- \`canAdd\` (\`all\` | \`subject\` | \`object\` | \`subject,object\` | \`none\`): whether a user answering may type an instance that is not in the map.
- \`group\`: a question-group name (comma-separated for several). Relationships in the same group **and with the same subject concept** are asked together on one screen. A group should contain at least two relationships.
- \`scope="context"\`: rare; keep if present.

Question wording (child elements, each at most once, plain text or markdown):
- \`<firstForm>Does %S live in %O?</firstForm>\` — yes/no confirmation when both sides are known. Must mention both \`%S\` and \`%O\`.
- \`<secondFormObject>Which country does %S live in?</secondFormObject>\` — asks for the object given the subject. Must mention \`%S\` and must **not** mention \`%O\`.
- \`<secondFormSubject>Who lives in %O?</secondFormSubject>\` — asks for the subject given the object. Must mention \`%O\` and must **not** mention \`%S\`.
- \`%S\` and \`%O\` are replaced by the instance names at question time. There is **no** \`firstFormObject\` or \`firstFormSubject\` element — only the three above exist.
- Provide wording for every form the \`askable\` setting allows; the engine falls back to a generic question otherwise, which reads badly to end users. With \`askable="none"\` no wording is needed.

Which askable to choose: outcomes and derived values that rules compute → \`none\`; inputs a user supplies → usually \`secondFormObject\`; reverse look-ups ("who has licence type X?") → \`secondFormSubject\`; \`all\` only when both directions and yes/no confirmation genuinely make sense.

A relationship that is \`askable="none"\`, has no facts, no rule inferring it and no datasource can only ever be satisfied by facts injected through the API. The linter flags this, and flags rules whose mandatory conditions depend on such a relationship as "can never fire without injected facts". That is fine for integration-fed maps and a bug for interactive ones.`;

export const INSTANCES_SECTION = `## 5. Concept instances

\`<concinst name="Julio" type="Person"/>\`

- \`name\`: the instance value; \`type\`: the concept it belongs to, which must be a **string** concept. Never declare instances of number, date or truth concepts (\`<concinst name="25" type="Age"/>\` is invalid) — those values are written directly in facts.
- An instance's identity is its name *plus* its concept: "Red" under "Colour" and "Red" under "Team" are two different instances. Declaring the same name twice under the same concept is a duplicate.
- Instances are what users pick from when answering a question about that concept (unless \`canAdd\` lets them add their own), what rule headers may fix as a literal subject or object, and what facts refer to.
- Optional markdown metadata shown to users: \`<concinst name="HR" type="Department"><meta type="md">Human Resources — people, payroll and policy</meta></concinst>\` (wrap in CDATA if it contains markup).
- Facts and rule headers may reference instance names that were not declared; the linter warns, because undeclared instances cannot be offered as answers. Declare the ones users should be able to choose.`;

export const FACTS_SECTION = `## 6. Facts

A fact is a \`<relinst>\` with **no** \`<condition>\` children:

\`\`\`rblang
<relinst type="national language" subject="France" object="French" cf="100"/>
<relinst type="has age" subject="Julio" object="41"/>
<relinst type="was born on" subject="Julio" object="1984-03-15"/>
<relinst type="is resident" subject="Julio" object="true"/>
\`\`\`

- \`type\` is the relationship name; \`subject\` and \`object\` are both required for a fact.
- \`cf\` (0–100, default 100) is the fact's certainty. Facts hard-coded in the map are the "knowledge map" provenance in evidence trees.
- The object literal must match the object concept's type: string → an instance name; number → a plain number (up to 15 significant digits, magnitude at most 999999999999999, no thousands separators); date → ISO 8601 \`YYYY-MM-DD\` (optionally \`YYYY-MM-DDTHH:MM:SS\`) or an epoch-milliseconds timestamp — long-form dates like "15 March 1984" are rejected; truth → lowercase \`true\` or \`false\` only.
- Declaring the same subject/relationship/object triple twice is a duplicate fact (warning).
- A rule header (see section 7) is also a \`<relinst>\`; the presence of conditions is the only thing that distinguishes a rule from a fact.`;

export const NAMING_SECTION = `## 15. Naming rules and engine limits

- Concept, relationship and instance names cannot contain \`"\`, \`\\\`, \`<\` or \`>\`; the platform also rejects \`'\` in *instance* values. Names are UTF-8 and at most 2000 characters. Keep them natural English: title-case concepts, lowercase relationships, instance names as users would say them.
- Relationship names must be unique map-wide; concept names must be unique; an instance is unique per concept.
- Rule names: optional, at most 170 characters, need not be unique, ignored on facts.
- Numbers: 15 significant digits, magnitude ≤ 999999999999999. Dates: ISO 8601 or epoch milliseconds. Truth: lowercase true/false.
- Queries: depth limit 2,000,000; fact injection 250 facts per request; a session expires after 24 hours of inactivity (each injection, query, answer or undo resets the clock); evidence outlives the session.
- Variables (\`%NAME\`) start with a letter and contain letters, digits and underscores; \`%S\` and \`%O\` are reserved.`;
