/**
 * Lightweight regex-based index of an RBLang document: declared concepts,
 * relationships, instances and the tags in the file with their positions.
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
  attrs: Record<string, string>;
  selfClosing: boolean;
  closing: boolean;
}

export interface MapIndex {
  concepts: Map<string, { type: string; offset: number }>;
  relationships: Map<string, { subject: string; object: string; plural: boolean; offset: number }>;
  instances: Map<string, { type: string; offset: number }>;
  tags: TagOccurrence[];
}

const TAG_RE = /<(\/?)([a-zA-Z_][\w:.-]*)((?:[^>"']|"[^"]*"|'[^']*')*?)(\/?)>/g;
const ATTR_RE = /([a-zA-Z_][\w:.-]*)\s*=\s*"([^"]*)"/g;

/** Strip comments and CDATA so their contents are not parsed as tags. */
function maskNonMarkup(text: string): string {
  return text
    .replace(/<!--[\s\S]*?-->/g, (m) => " ".repeat(m.length))
    .replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, (m) => " ".repeat(m.length))
    .replace(/<\?[\s\S]*?\?>/g, (m) => " ".repeat(m.length));
}

export function buildIndex(text: string): MapIndex {
  const masked = maskNonMarkup(text);
  const index: MapIndex = {
    concepts: new Map(),
    relationships: new Map(),
    instances: new Map(),
    tags: [],
  };

  let m: RegExpExecArray | null;
  TAG_RE.lastIndex = 0;
  while ((m = TAG_RE.exec(masked)) !== null) {
    const [full, slash, name, attrSource, selfSlash] = m;
    const attrs: Record<string, string> = {};
    let a: RegExpExecArray | null;
    ATTR_RE.lastIndex = 0;
    while ((a = ATTR_RE.exec(attrSource)) !== null) {
      attrs[a[1]] = a[2];
    }
    const tag: TagOccurrence = {
      name,
      start: m.index,
      end: m.index + full.length,
      attrSource,
      attrs,
      selfClosing: selfSlash === "/",
      closing: slash === "/",
    };
    index.tags.push(tag);
    if (tag.closing) continue;

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
    }
  }
  return index;
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
