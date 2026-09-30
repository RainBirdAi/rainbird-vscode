/**
 * The RBLang / Rainbird knowledge reference the assistant carries in its
 * system prompt. Assembled from hand-written topic modules plus tables
 * generated from the same schema the linter and completions use, so the
 * assistant can never learn an attribute the linter would reject.
 *
 * Byte-stable by construction (no dates, no randomness) so the whole block
 * is prompt-cacheable across turns and sessions.
 */
import { SCHEMA, EXPRESSION_FUNCTIONS, LEGACY_VALUES } from "../schema";
import { PLATFORM_SECTION } from "./platform";
import { STRUCTURE_SECTION, CONCEPTS_SECTION, RELATIONSHIPS_SECTION, INSTANCES_SECTION, FACTS_SECTION, NAMING_SECTION } from "./language";
import { RULES_SECTION, CONDITIONS_SECTION, VARIABLES_SECTION, EXPRESSIONS_SECTION } from "./rules";
import { DATASOURCES_SECTION, LINKED_SECTION } from "./integration";
import { CERTAINTY_SECTION, ENGINE_SECTION } from "./engine";
import { VALIDATION_SECTION, PATTERNS_SECTION, MISTAKES_SECTION } from "./authoring";
import { buildExamplesSection } from "./examples";

export { KNOWLEDGE_EXAMPLES } from "./examples";
export type { KnowledgeExample } from "./examples";
export { EXPLAIN_SYSTEM_PROMPT } from "./engine";

/** Section headings in order — the table of contents, also checked by the tests. */
export const KNOWLEDGE_SECTIONS: string[] = [
  "1. What Rainbird is",
  "2. RBLang document structure",
  "3. Concepts",
  "4. Relationships",
  "5. Concept instances",
  "6. Facts",
  "7. Rules",
  "8. Conditions",
  "9. Variables",
  "10. Expression language",
  "11. Datasources",
  "12. Linked maps and compounds",
  "13. The certainty model",
  "14. How the engine reasons",
  "15. Naming rules and engine limits",
  "16. Validation",
  "17. Authoring patterns",
  "18. Common mistakes",
  "19. Worked examples",
  "20. Element reference",
];

/** Every element with its attributes, generated from the schema table. */
export function buildElementReference(): string {
  const elements = Object.entries(SCHEMA)
    .map(([name, spec]) => {
      const parts = [`<${name}> — ${spec.doc}`];
      if (spec.required.length) parts.push(`  required: ${spec.required.join(", ")}`);
      if (spec.optional.length) parts.push(`  optional: ${spec.optional.join(", ")}`);
      if (spec.enums) {
        for (const [attr, values] of Object.entries(spec.enums)) parts.push(`  ${attr} ∈ {${values.join(" | ")}}`);
      }
      if (spec.children.length) parts.push(`  children: ${spec.children.join(", ")}`);
      if (spec.text) parts.push("  text content allowed");
      return parts.join("\n");
    })
    .join("\n\n");

  const legacy = Object.entries(LEGACY_VALUES)
    .flatMap(([el, attrs]) => Object.entries(attrs).flatMap(([attr, map]) => Object.entries(map).map(([from, to]) => `- <${el} ${attr}="${from}"> is legacy for "${to}"`)))
    .join("\n");

  const functions = EXPRESSION_FUNCTIONS.map((f) => `- ${f.signature} — ${f.doc}`).join("\n");

  return `## 20. Element reference

Generated from the extension's schema table — the same one that drives the linter, completions and hovers. Attributes not listed here are reported as unrecognised.

${elements}

Legacy spellings still accepted:
${legacy}

### Expression functions (complete catalogue)

${functions}`;
}

let cached: string | undefined;

/** The complete knowledge reference. Deterministic; computed once per process. */
export function buildKnowledgeReference(): string {
  if (cached) return cached;
  cached = [
    "# Rainbird and RBLang reference",
    "",
    "Everything below is the authoritative reference for this assistant. When the user's map contradicts it (for example uses an attribute not listed), trust the linter's diagnostics and say so.",
    "",
    PLATFORM_SECTION,
    STRUCTURE_SECTION,
    CONCEPTS_SECTION,
    RELATIONSHIPS_SECTION,
    INSTANCES_SECTION,
    FACTS_SECTION,
    RULES_SECTION,
    CONDITIONS_SECTION,
    VARIABLES_SECTION,
    EXPRESSIONS_SECTION,
    DATASOURCES_SECTION,
    LINKED_SECTION,
    CERTAINTY_SECTION,
    ENGINE_SECTION,
    NAMING_SECTION,
    VALIDATION_SECTION,
    PATTERNS_SECTION,
    MISTAKES_SECTION,
    buildExamplesSection(),
    buildElementReference(),
  ].join("\n\n");
  return cached;
}
