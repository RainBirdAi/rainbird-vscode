/**
 * Lightweight regex-based index of an RBLang document: declared concepts,
 * relationships, instances and the tags in the file with their positions,
 * plus the lexical problems met while tokenising (malformed or duplicate
 * attributes, quotes that run into the next element).
 *
 * Prototype-grade on purpose. The production extension replaces this with a
 * proper incremental XML parser inside a language server; the consumers
 * (diagnostics, completions, query runner) are written against this interface
 * so they carry over unchanged.
 */

export interface TagOccurrence {
  name: string;
  /** Offset of the "<" in the document */
  start: number;
  /** Offset just past the closing ">" */
  end: number;
  /** Raw attribute source text between the tag name and the closing ">" */
  attrSource: string;
  /** Parsed attributes. When an attribute is repeated the first value wins (as in Studio). */
  attrs: Record<string, string>;
  selfClosing: boolean;
  closing: boolean;
  /** Set when the tag's attribute text did not tokenise cleanly; attribute-level checks should be skipped. */
  malformed?: boolean;
}

/** One instance declaration. An instance is identified by name AND concept: "Red" under "Colour" and "Red" under "Team" are different instances. */
export interface InstanceDecl {
  name: string;
  type: string;
  offset: number;
}

/** A problem found while tokenising, with the range it applies to and an optional repair. */
export interface IndexProblem {
  start: number;
  end: number;
  message: string;
  fix?: { title: string; edits: { start: number; end: number; newText: string }[] };
}

export interface MapIndex {
  concepts: Map<string, { type: string; offset: number }>;
  relationships: Map<string, { subject: string; object: string; plural: boolean; offset: number }>;
  /**
   * Instances by name (last declaration wins) — convenient for completions and
   * hovers. Where identity matters use `instanceDecls` / `instanceTypes`.
   */
  instances: Map<string, { type: string; offset: number }>;
  /** Every instance declaration in document order. */
  instanceDecls: InstanceDecl[];
  tags: TagOccurrence[];
  problems: IndexProblem[];
}

const TAG_RE = /<(\/?)([a-zA-Z_][\w:.-]*)((?:[^>"']|"[^"]*"|'[^']*')*?)(\/?)>/g;
/** One well-formed attribute: name="value" (double quotes only, as RBLang is written). Sticky so residue can be located. */
const STRICT_ATTR_RE = /\s*([a-zA-Z_][\w:.-]*)\s*=\s*"([^"]*)"/y;
/** A quoted value that contains a line break followed by the start of another element has swallowed it: a quote is missing. */
const RUNAWAY_VALUE_RE = /\n\s*<[a-zA-Z_/!?]/;

/** Strip comments and CDATA so their contents are not parsed as tags. Offsets are preserved. */
export function maskNonMarkup(text: string): string {
  return text
    .replace(/<!--[\s\S]*?-->/g, (m) => " ".repeat(m.length))
    .replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, (m) => " ".repeat(m.length))
    .replace(/<\?[\s\S]*?\?>/g, (m) => " ".repeat(m.length));
}

const shorten = (s: string, max = 40): string => {
  const flat = s.replace(/\s+/g, " ");
  return flat.length > max ? flat.slice(0, max) + "…" : flat;
};

export function buildIndex(text: string): MapIndex {
  const masked = maskNonMarkup(text);
  const index: MapIndex = {
    concepts: new Map(),
    relationships: new Map(),
    instances: new Map(),
    instanceDecls: [],
    tags: [],
    problems: [],
  };

  let m: RegExpExecArray | null;
  TAG_RE.lastIndex = 0;
  while ((m = TAG_RE.exec(masked)) !== null) {
    const [full, slash, name, attrSource, selfSlash] = m;
    const tag: TagOccurrence = {
      name,
      start: m.index,
      end: m.index + full.length,
      attrSource,
      attrs: {},
      selfClosing: selfSlash === "/",
      closing: slash === "/",
    };
    /** Document offset of attrSource[0]. */
    const attrBase = m.index + 1 + slash.length + name.length;
    tokeniseAttributes(tag, attrBase, index.problems);
    index.tags.push(tag);
    if (tag.closing || tag.malformed) continue; // a malformed tag's attributes are not trustworthy enough to declare anything

    const attrs = tag.attrs;
    if (name === "concept" && attrs.name) {
      index.concepts.set(attrs.name, { type: attrs.type ?? "string", offset: tag.start });
    } else if (name === "rel" && attrs.name) {
      index.relationships.set(attrs.name, {
        subject: attrs.subject ?? "",
        object: attrs.object ?? "",
        plural: attrs.plural === "true",
        offset: tag.start,
      });
    } else if (name === "concinst" && attrs.name) {
      index.instances.set(attrs.name, { type: attrs.type ?? "", offset: tag.start });
      index.instanceDecls.push({ name: attrs.name, type: attrs.type ?? "", offset: tag.start });
    }
  }
  return index;
}

/**
 * Parse `tag.attrSource` strictly. Well-formed attributes land in `tag.attrs`;
 * anything else — text that is not name="value", a repeated attribute, a
 * value that swallowed the following element because a quote is missing —
 * becomes a problem. Quote trouble marks the tag malformed and is reported
 * alone: the duplicates it produces are artefacts of the broken parse and a
 * fix that removed them would delete real content.
 */
function tokeniseAttributes(tag: TagOccurrence, attrBase: number, problems: IndexProblem[]): void {
  const src = tag.attrSource;
  const label = `<${tag.closing ? "/" : ""}${tag.name}>`;

  if (tag.closing) {
    if (src.trim()) {
      const at = attrBase + src.search(/\S/);
      problems.push({ start: at, end: attrBase + src.trimEnd().length, message: `Closing tag ${label} cannot have attributes or text` });
      tag.malformed = true;
    }
    return;
  }

  const duplicates: IndexProblem[] = [];
  let residueProblem: IndexProblem | undefined;
  let runaway: IndexProblem | undefined;
  let pos = 0;
  let residueStart = -1;

  const flushResidue = (end: number) => {
    if (residueStart < 0) return;
    const residue = src.slice(residueStart, end).trimEnd();
    if (residue && !residueProblem) {
      const start = attrBase + residueStart;
      residueProblem = {
        start,
        end: start + residue.length,
        message: residue.includes('"')
          ? `Unbalanced double quotes in ${label} near "${shorten(residue)}"`
          : `Malformed attribute in ${label}: "${shorten(residue)}" (expected name="value")`,
      };
    }
    residueStart = -1;
  };

  while (pos < src.length) {
    STRICT_ATTR_RE.lastIndex = pos;
    const a = STRICT_ATTR_RE.exec(src);
    if (!a) {
      if (residueStart < 0 && !/\s/.test(src[pos])) residueStart = pos;
      pos++;
      continue;
    }
    flushResidue(pos);
    const [whole, attr, value] = a;
    const start = attrBase + a.index;
    const end = attrBase + STRICT_ATTR_RE.lastIndex;
    if (attr in tag.attrs) {
      duplicates.push({
        start: start + whole.search(/\S/),
        end,
        message: `Duplicate attribute ${attr} on ${label}: "${shorten(tag.attrs[attr])}" is already set, this "${shorten(value)}" is ignored`,
        fix: { title: `Remove duplicate ${attr}`, edits: [{ start, end, newText: "" }] },
      });
    } else {
      tag.attrs[attr] = value;
    }
    if (!runaway && RUNAWAY_VALUE_RE.test(value)) {
      const valueStart = start + whole.indexOf('"') + 1;
      runaway = {
        start: valueStart,
        end: valueStart + value.length,
        message: `Unbalanced double quote: the value of ${attr} on ${label} runs into the next element — a closing quote is missing`,
      };
    }
    pos = STRICT_ATTR_RE.lastIndex;
  }
  flushResidue(src.length);

  const quoteTrouble = runaway ?? (residueProblem?.message.startsWith("Unbalanced") ? residueProblem : undefined);
  if (quoteTrouble) {
    problems.push(quoteTrouble);
    tag.malformed = true;
    return;
  }
  if (residueProblem) {
    problems.push(residueProblem);
    tag.malformed = true;
  }
  problems.push(...duplicates);
}

/** Every concept under which an instance of this name is declared (empty when undeclared). */
export function instanceTypes(index: MapIndex, name: string): string[] {
  const types: string[] = [];
  for (const d of index.instanceDecls) if (d.name === name && !types.includes(d.type)) types.push(d.type);
  return types;
}

/** Names of the instances declared for a concept. */
export function instancesOf(index: MapIndex, concept: string): string[] {
  const names: string[] = [];
  for (const d of index.instanceDecls) if (d.type === concept && !names.includes(d.name)) names.push(d.name);
  return names;
}

/** Document-offset range of an attribute's value (inside the quotes), or undefined. */
export function attrValueRange(tag: TagOccurrence, attr: string): { start: number; end: number } | undefined {
  const base = tag.start + 1 + tag.name.length + (tag.closing ? 1 : 0);
  const re = /([a-zA-Z_][\w:.-]*)\s*=\s*"([^"]*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(tag.attrSource)) !== null) {
    if (m[1] !== attr) continue;
    const start = base + m.index + m[0].indexOf('"') + 1;
    return { start, end: start + m[2].length };
  }
  return undefined;
}

/** Document-offset range of a whole attribute (name="value"), including leading whitespace. */
export function attrFullRange(tag: TagOccurrence, attr: string): { start: number; end: number } | undefined {
  const base = tag.start + 1 + tag.name.length + (tag.closing ? 1 : 0);
  const re = /(\s*)([a-zA-Z_][\w:.-]*)\s*=\s*"[^"]*"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(tag.attrSource)) !== null) {
    if (m[2] !== attr) continue;
    return { start: base + m.index, end: base + m.index + m[0].length };
  }
  return undefined;
}

/** Rule/fact counts per relationship (a relinst with conditions is a rule, without is a fact). */
export function relinstCounts(index: MapIndex): Map<string, { rules: number; facts: number }> {
  const counts = new Map<string, { rules: number; facts: number }>();
  for (let i = 0; i < index.tags.length; i++) {
    const tag = index.tags[i];
    if (tag.closing || tag.name !== "relinst" || !tag.attrs.type) continue;
    let hasCondition = false;
    if (!tag.selfClosing) {
      for (let j = i + 1; j < index.tags.length; j++) {
        const inner = index.tags[j];
        if (inner.name === "relinst" && inner.closing) break;
        if (inner.name === "condition" && !inner.closing) {
          hasCondition = true;
          break;
        }
      }
    }
    const entry = counts.get(tag.attrs.type) ?? { rules: 0, facts: 0 };
    if (hasCondition) entry.rules++;
    else entry.facts++;
    counts.set(tag.attrs.type, entry);
  }
  return counts;
}

/**
 * The innermost element still open at `offset` — drives context-aware
 * completions ("what can go here?").
 */
export function enclosingElement(index: MapIndex, offset: number): string | undefined {
  const stack: string[] = [];
  for (const tag of index.tags) {
    if (tag.end > offset) break;
    if (tag.closing) {
      if (stack[stack.length - 1] === tag.name) stack.pop();
    } else if (!tag.selfClosing) {
      stack.push(tag.name);
    }
  }
  return stack[stack.length - 1];
}
