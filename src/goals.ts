/**
 * The goal relationships a query can target, read from a map's RBLang: one
 * entry per declared relationship, carrying what the goal pickers show beside
 * its name (subject → object, plural, askable, rule and fact counts).
 *
 * Covers both goal sources: the open .rbl editor and the RBLang the platform
 * returns for a Studio-authored map (GET /analysis/file/{kmID}). No vscode
 * dependency, so it runs under plain node in the tests.
 */
import { buildIndex, MapIndex, relinstCounts, TagOccurrence } from "./mapIndex";

export interface Goal {
  /** The relationship name exactly as declared — the engine matches it case-sensitively. */
  name: string;
  /** Subject concept name. */
  subject: string;
  /** Object concept name. */
  object: string;
  plural: boolean;
  /**
   * The askable setting on this relationship's own <rel> tag: "all" (also when
   * the attribute is omitted, or the legacy "true"), "none" (also the legacy
   * "false"), "secondFormObject" or "secondFormSubject". Any other value is
   * passed through unchanged (the linter reports it) and, like the linter,
   * should be treated as askable: only "none" means "never asked".
   */
  askable: string;
  /** Rules (relinsts with conditions) in this map text that infer the relationship. */
  rules: number;
  /** Facts (relinsts without conditions) of the relationship in this map text. */
  facts: number;
}

export interface GoalList {
  /** One goal per relationship name, in document order. */
  goals: Goal[];
  /**
   * True when the map has both askable relationships and askable="none" ones.
   * Only then does a "not askable" tag tell the author anything: in a headless
   * map (examples/bigger_map.rbl is 100% askable="none") it would sit on every row.
   */
  askableMixed: boolean;
}

/** The goal list of a map, from its RBLang text. */
export function goalsFromMap(text: string): GoalList {
  return goalsFromIndex(buildIndex(text));
}

/**
 * The goal list from an index that has already been built (saves a second
 * parse when the caller needs the index anyway).
 *
 * A relationship declared twice (a lint error) yields one goal, listed where
 * the name first appears, with every attribute — subject, object, plural and
 * askable — taken from the same declaration: the one the index keeps (the
 * last). askable is read from the tag at that declaration's offset rather than
 * from a name → tag map, so attributes from different declarations never mix.
 */
export function goalsFromIndex(index: MapIndex): GoalList {
  const counts = relinstCounts(index);
  const relTagAt = new Map<number, TagOccurrence>();
  for (const tag of index.tags) if (tag.name === "rel" && !tag.closing) relTagAt.set(tag.start, tag);

  const goals: Goal[] = [];
  for (const [name, rel] of index.relationships) {
    const n = counts.get(name);
    goals.push({
      name,
      subject: rel.subject,
      object: rel.object,
      plural: rel.plural,
      askable: normaliseAskable(relTagAt.get(rel.offset)?.attrs.askable),
      rules: n?.rules ?? 0,
      facts: n?.facts ?? 0,
    });
  }
  const askable = goals.filter((g) => g.askable !== "none").length;
  return { goals, askableMixed: askable > 0 && askable < goals.length };
}

/** An askable attribute value with the default and the legacy booleans resolved ("true" = all, "false" = none). */
export function normaliseAskable(value: string | undefined): string {
  if (value === undefined || value === "true") return "all";
  if (value === "false") return "none";
  return value;
}
