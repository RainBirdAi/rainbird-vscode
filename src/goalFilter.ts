/**
 * Goal relationship search for the query panel's goal picker: ranking,
 * grouping, case correction and match highlighting.
 *
 * INLINING. The webview runs these very functions: GOAL_FILTER_SOURCE is their
 * compiled text, taken with Function.prototype.toString() and inlined into the
 * panel's nonce'd <script>, so the panel and the tests rank identically. That
 * relies on the extension shipping UNBUNDLED, UNMINIFIED tsc output (ES2022
 * CommonJS: a function declaration keeps its name and body verbatim and the
 * export is a separate statement). If a bundler or minifier is ever added,
 * names get mangled and the inlined source breaks — generate the source at
 * build time instead.
 *
 * Rules for every function listed in GOAL_FILTER_SOURCE: a plain function
 * declaration; no imports, no module-level constants, no calls except to the
 * other listed functions; no backticks; nothing that behaves differently in
 * sloppy mode (the webview script is not strict). Helpers are prefixed "goal"
 * because every region of the webview shares one script scope.
 * src/test/goalFilter.test.ts evaluates the source with new Function and
 * checks it ranks exactly like this module.
 */

/** What ranking reads from a goal. Goal (goals.ts) satisfies it. */
export interface GoalLike {
  name: string;
  subject: string;
  object: string;
}

/**
 * Where the query matched: the relationship name, its subject or object
 * concept, or (fallback) the initials of the name's words.
 */
export type GoalMatchKind = "name" | "subject" | "object" | "subsequence";

export interface GoalMatch<T extends GoalLike = GoalLike> {
  goal: T;
  /**
   * Match tier, higher is better. Results are sorted by it, then by document
   * order (never by name length, which would scramble numbered series). Names
   * are compared ignoring case and runs of whitespace.
   *   7  the name equals the query                           matched "name"
   *   6  the name starts with the query                      matched "name"
   *   5  a later word of the name starts with the query      matched "name"
   *   4  the name contains the query                         matched "name"
   *   3  the name contains every query word, in any order    matched "name"
   *   2  every query word is in the name, subject or object,
   *      at least one only in the subject or object          matched "subject" (such a word is
   *                                                          in the subject), else "object"
   *   1  fallback, tried only when nothing scored above and the query is ONE
   *      word of at least 3 characters: its characters start words of the
   *      name, in order — an acronym ("hti" → has total income)
   *                                                          matched "subsequence"
   *   0  empty query: every goal, in document order          matched "name"
   */
  score: number;
  matched: GoalMatchKind;
}

export interface RankOptions {
  /** Keep at most this many matches, after ranking. Default: all of them. */
  limit?: number;
}

/** A run of text to show as is (match false) or emphasised (match true). */
export interface HighlightSegment {
  text: string;
  match: boolean;
}

// ── Inlined into the webview (see GOAL_FILTER_SOURCE) ──

/** Lower-case without changing the length, so offsets into the result are offsets into the input. */
function goalFold(text: string): string {
  const s = String(text ?? "");
  const lower = s.toLowerCase();
  if (lower.length === s.length) return lower;
  // A few capitals lower-case to two characters (Turkish dotted I): keep those as written.
  let out = "";
  for (const ch of s) {
    const l = ch.toLowerCase();
    out += l.length === ch.length ? l : ch;
  }
  return out;
}

/** Trimmed, with every run of whitespace collapsed to one space. */
function goalCollapse(text: string): string {
  return String(text ?? "").trim().replace(/\s+/g, " ");
}

/** True when offset `at` starts a word: the start of the text, or just after a character that is not a letter or digit. */
function goalIsWordStart(folded: string, at: number): boolean {
  return at === 0 || !/[\p{L}\p{N}]/u.test(folded.charAt(at - 1));
}

/** Offset of `needle` in `folded`, preferring an occurrence that starts a word; -1 when absent. */
function goalFind(folded: string, needle: string): number {
  let first = -1;
  for (let at = folded.indexOf(needle); at >= 0; at = folded.indexOf(needle, at + 1)) {
    if (goalIsWordStart(folded, at)) return at;
    if (first < 0) first = at;
  }
  return first;
}

/**
 * Where the characters of `word` start words of `folded`, in order, as
 * [start, end) ranges ("hti" → Has Total Income; words in between may be
 * skipped), or null when they do not. Taking the first suitable word start
 * for each character finds a match whenever there is one.
 */
function goalInitials(folded: string, word: string): [number, number][] | null {
  const ranges: [number, number][] = [];
  let from = 0;
  for (const ch of word) {
    let at = folded.indexOf(ch, from);
    while (at >= 0 && !goalIsWordStart(folded, at)) at = folded.indexOf(ch, at + 1);
    if (at < 0) return null;
    ranges.push([at, at + ch.length]);
    from = at + ch.length;
  }
  return ranges;
}

/** Split `text` into plain and emphasised runs from [start, end) ranges (any order; overlaps merge). */
function goalSegments(text: string, ranges: [number, number][]): HighlightSegment[] {
  const sorted = ranges.filter((r) => r[1] > r[0]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const out: HighlightSegment[] = [];
  const add = (part: string, match: boolean): void => {
    if (!part) return;
    const last = out[out.length - 1];
    if (last && last.match === match) last.text += part;
    else out.push({ text: part, match });
  };
  let at = 0;
  for (const [start, end] of sorted) {
    const from = Math.max(start, at);
    if (end <= from) continue;
    add(text.slice(at, from), false);
    add(text.slice(from, end), true);
    at = end;
  }
  add(text.slice(at), false);
  return out;
}

/**
 * Goals matching `query`, best first (see GoalMatch.score for the tiers).
 * Case-insensitive; surrounding whitespace is ignored and inner runs count as
 * one space, in the query and in the names alike. An empty query returns every
 * goal in document order. Ties keep document order.
 *
 * The acronym fallback ("hti" → "has total income") runs only when nothing
 * else matched and the query is a single word of at least 3 characters.
 * Letters merely scattered through a name are not a match: on a big map they
 * turn a name the map does not declare ("lives in", "has age" or "Amount" in
 * examples/bigger_map.rbl) into a list of unrelated relationships, the first
 * of which a combobox would pick on Enter. So a typo or an undeclared name
 * matches nothing, and the panel can offer to send it as typed.
 */
export function rankGoals<T extends GoalLike>(goals: readonly T[], query: string, opts?: RankOptions): GoalMatch<T>[] {
  const list = goals || [];
  const q = goalFold(goalCollapse(query));
  let out: GoalMatch<T>[];
  if (!q) {
    out = list.map((goal) => ({ goal, score: 0, matched: "name" as GoalMatchKind }));
  } else {
    const words = q.split(" ");
    const names = list.map((goal) => goalFold(goalCollapse(goal.name)));
    const scored: { goal: T; score: number; matched: GoalMatchKind; order: number }[] = [];
    list.forEach((goal, order) => {
      const name = names[order];
      let score = 0;
      let matched: GoalMatchKind = "name";
      if (name === q) score = 7;
      else if (name.startsWith(q)) score = 6;
      else {
        const at = goalFind(name, q);
        if (at >= 0) score = goalIsWordStart(name, at) ? 5 : 4;
        else if (words.every((w) => name.includes(w))) score = 3;
        else {
          const subject = goalFold(goal.subject);
          const object = goalFold(goal.object);
          if (words.every((w) => name.includes(w) || subject.includes(w) || object.includes(w))) {
            score = 2;
            matched = words.some((w) => !name.includes(w) && subject.includes(w)) ? "subject" : "object";
          }
        }
      }
      if (score > 0) scored.push({ goal, score, matched, order });
    });
    if (!scored.length && words.length === 1 && q.length >= 3) {
      list.forEach((goal, order) => {
        if (goalInitials(names[order], q)) scored.push({ goal, score: 1, matched: "subsequence", order });
      });
    }
    scored.sort((a, b) => b.score - a.score || a.order - b.order);
    out = scored.map((m) => ({ goal: m.goal, score: m.score, matched: m.matched }));
  }
  const limit = opts ? opts.limit : undefined;
  return typeof limit === "number" && limit >= 0 ? out.slice(0, limit) : out;
}

/**
 * The declared spelling of the goal `typed` means, when it matches one goal
 * ignoring case (and runs of whitespace) but is not already exact; undefined
 * when it is exact, empty, matches nothing, or matches several goals that
 * differ only in case. The engine matches names case-sensitively (a mismatch
 * is a bare 400), so the panel offers this spelling ("Did you mean …?") and
 * Start query sends it.
 */
export function canonicalGoal(goals: readonly GoalLike[], typed: string): string | undefined {
  const list = goals || [];
  const raw = String(typed ?? "").trim();
  if (!raw || list.some((g) => g.name === raw)) return undefined;
  const key = goalCollapse(raw).toLowerCase();
  const hits = list.filter((g) => goalCollapse(g.name).toLowerCase() === key);
  return hits.length === 1 ? hits[0].name : undefined;
}

/**
 * `text` (a goal name, or its subject or object) split into runs, with the
 * part `query` matched marked match: true — the whole query where it occurs
 * (preferring a word start), else each query word found. Pass the row's
 * `matched` value: for "subsequence" the initials rankGoals matched are
 * marked instead.
 * Runs are raw text; escape them before building HTML. Empty text gives [].
 */
export function highlightMatch(text: string, query: string, matched?: GoalMatchKind): HighlightSegment[] {
  const s = String(text ?? "");
  if (!s) return [];
  const q = goalFold(goalCollapse(query));
  if (!q) return [{ text: s, match: false }];
  const folded = goalFold(s);
  let ranges: [number, number][] = [];
  if (matched === "subsequence") ranges = goalInitials(folded, q) || [];
  else {
    const at = goalFind(folded, q);
    if (at >= 0) ranges.push([at, at + q.length]);
    else {
      for (const w of q.split(" ")) {
        const i = goalFind(folded, w);
        if (i >= 0) ranges.push([i, i + w.length]);
      }
    }
  }
  return goalSegments(s, ranges);
}

/**
 * Goals split into those a rule infers (rules > 0) and the rest, each in
 * document order. Call it on ALL goals, before any display cap: in
 * examples/bigger_map.rbl 119 of the 147 rule-bearing relationships come after
 * the 100th.
 */
export function groupGoals<T extends { rules?: number }>(goals: readonly T[]): { inferred: T[]; other: T[] } {
  const inferred: T[] = [];
  const other: T[] = [];
  for (const goal of goals || []) {
    if ((goal.rules ?? 0) > 0) inferred.push(goal);
    else other.push(goal);
  }
  return { inferred, other };
}

// ── End of inlined functions ──

/**
 * Self-contained browser source defining rankGoals, canonicalGoal,
 * highlightMatch and groupGoals (plus their goal* helpers) as top-level
 * functions, built from the compiled functions above. Interpolate it into the
 * webview's single nonce'd <script>; it contains no backticks, no "${" and no
 * "</script". Relies on unbundled tsc output — see the note at the top.
 */
export const GOAL_FILTER_SOURCE: string = [
  "/* Goal search, inlined from the compiled src/goalFilter.ts with Function.prototype.toString(): relies on unbundled, unminified tsc output. */",
  ...[goalFold, goalCollapse, goalIsWordStart, goalFind, goalInitials, goalSegments, rankGoals, canonicalGoal, highlightMatch, groupGoals].map((fn) =>
    fn.toString()
  ),
].join("\n");
