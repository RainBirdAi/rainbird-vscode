/**
 * Knowledge reference, part 4: datasources, linked maps (import) and the
 * legacy compound element. Clean-room prose derived from Rainbird's public
 * datasource reference plus the validator shape observed in Studio.
 */

export const DATASOURCES_SECTION = `## 11. Datasources

A datasource lets the engine fetch facts from a REST API mid-inference, in the *Match* step of Match → Infer → Ask, so the user is not asked for data a system already knows.

\`\`\`rblang
<concept name="Vehicle" type="string">
  <datasource hostname="https://api.example.com" path="/vehicles?reg={{%S}}" method="GET" name="Vehicle lookup">
    <action map="has make=/Response/Vehicle/Make"/>
    <action map="has model=/Response/Vehicle/Model"/>
    <input rel="owns" subject="%PERSON" object="%S"/>
    <headers>
      <header key="x-api-key" value="YOUR_KEY"/>
    </headers>
  </datasource>
</concept>
\`\`\`

- Place the \`<datasource>\` inside the concept that is the **subject** of the facts it will create (the Vehicle whose make we want), not inside the concept being populated (Make). That concept must be a string concept used as a relationship subject.
- \`hostname\` (required, must start with http:// or https://), \`path\` (may be empty), \`method\` (\`GET\` default or \`POST\`), \`name\` (label shown on the graph).
- \`{{%S}}\` in the path, headers or body is replaced by the current subject instance. Extra values come from \`<input rel="…" subject="…" object="…"/>\` elements, which bind variables by walking relationships (here \`%PERSON\` is whoever owns \`%S\`); reference them as \`{{%PERSON}}\`. An input's variable must match the concept type the relationship expects; \`<input>\` also accepts \`value\`/\`expression\` for computed inputs.
- \`<action map="relationship name=/path/in/response"/>\` turns a response value into a fact whose subject is \`%S\` and whose relationship must have the datasource's concept as its subject. Paths are slash-separated (XPath-like, also used for JSON: \`/Response/DataItems/Make\`); dot notation does not work. Path segments can interpolate bound variables (\`/Response/{{%CHOICE}}\`). Actions may nest for repeated structures.
- \`<headers><header key="…" value="…"/></headers>\` for authentication and content type; values may interpolate variables.
- A raw request body (usually for POST) goes as text content, wrapped in CDATA: \`<![CDATA[{"reg": "{{%S}}"}]]>\`.
- The engine only calls the datasource when a query actually needs one of the mapped relationships, so pay-per-call APIs are hit sparingly. Facts created this way carry the "datasource" provenance in evidence trees.`;

export const LINKED_SECTION = `## 12. Linked maps and compounds

\`<import km="<kmID>" versionNumber="<n>"/>\` links a published version of another knowledge map into this one (Studio calls these linked knowledge maps). The importing map can then reference the linked map's concepts and relationships. Consequences for editing here:
- This extension does not resolve imports, so references to names declared only in the linked map appear as "unknown concept/relationship" diagnostics. When a map contains \`<import>\` elements, treat such diagnostics as expected for names you cannot find locally and tell the user rather than "fixing" them.
- Imports are written directly under the root, conventionally after the concepts. The optional \`username\` attribute is tolerated by the validator but never emitted by Studio.

\`<compound subject="…" type="…" object="…">\` containing \`<relinst type="…" object="…" cf="…"/>\` children is a legacy engine construct. Its shape is accepted by the validator but its runtime semantics are not documented anywhere public and current Studio does not model it. Do not generate compounds; if a map contains one, leave it alone and say that its behaviour is undocumented.`;
