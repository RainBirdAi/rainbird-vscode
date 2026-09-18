/**
 * Indent-only formatter for RBLang, editor-agnostic so the unit tests run
 * under plain node. formatting.ts wraps it as a VS Code formatting provider,
 * which is what `editor.formatOnSave` and *Format Document* call.
 *
 * The formatter re-indents each line from the element nesting and trims
 * trailing whitespace. It never joins, splits or reorders lines, so the
 * author's blank lines, comments, attribute wrapping and element order all
 * survive. Lines that continue a construct begun on an earlier line — a
 * wrapped start tag, a multi-line comment — are shifted by the same amount
 * as the construct's first line so hand-aligned attributes stay aligned.
 * Lines that begin inside a quoted attribute value or a CDATA section are
 * left untouched, as their whitespace is content.
 *
 * The scan is tolerant of the half-typed documents a formatter meets: a
 * closing tag with nothing open is ignored, a mismatched one pops back to
 * its opener, and depth never goes negative.
 */

export interface FormatOptions {
  /** Width of one indent level, and the width a tab counts as when measuring existing indentation. */
  tabSize: number;
  /** Indent with spaces (true) or tabs (false). */
  insertSpaces: boolean;
}

/** A single line whose text (excluding the line break) must change. */
export interface LineEdit {
  line: number;
  text: string;
}

type Mode = "text" | "tag" | "quote" | "comment" | "cdata" | "pi";

const NAME_START = /[A-Za-z_:]/;
const NAME_CHAR = /[\w:.-]/;

/** Compute the line edits that bring `text` to canonical indentation. */
export function formatLines(text: string, options: FormatOptions): LineEdit[] {
  const tabSize = Math.max(1, Math.floor(options.tabSize) || 2);
  const lines = text.split("\n");
  const edits: LineEdit[] = [];

  const stack: string[] = [];
  let mode: Mode = "text";
  let quoteChar = "";
  // State of the tag being scanned, carried across wrapped lines.
  let tagName = "";
  let tagClosing = false;
  let tagSelfClosing = false;
  // Column shift applied to the first line of the construct currently open,
  // reused for its continuation lines so relative alignment is preserved.
  let constructDelta = 0;

  for (let lineNo = 0; lineNo < lines.length; lineNo++) {
    const raw = lines[lineNo];
    const hasCr = raw.endsWith("\r");
    const line = hasCr ? raw.slice(0, -1) : raw;
    const startMode = mode;

    const leadingLength = line.length - line.trimStart().length;
    const oldColumn = measureColumns(line.slice(0, leadingLength), tabSize);
    const body = line.slice(leadingLength);

    let newColumn: number;
    if (startMode === "text") {
      // A closing tag sits at the level of the element it closes, which is
      // the top of the stack in a well-formed document and further down when
      // an inner element was left unclosed. A stray closer keeps the depth.
      let depth = stack.length;
      if (body.startsWith("</")) {
        const index = stack.lastIndexOf(closingName(body));
        if (index >= 0) depth = index;
      }
      newColumn = depth * tabSize;
      constructDelta = newColumn - oldColumn;
    } else if (startMode === "quote" || startMode === "cdata") {
      newColumn = -1; // leave as is
    } else {
      newColumn = Math.max(0, oldColumn + constructDelta);
    }

    // Advance the scanner over this line before deciding on trailing whitespace.
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      switch (mode) {
        case "text":
          if (ch !== "<") break;
          if (line.startsWith("<!--", i)) {
            mode = "comment";
            i += 3;
          } else if (line.startsWith("<![CDATA[", i)) {
            mode = "cdata";
            i += 8;
          } else if (line[i + 1] === "?") {
            mode = "pi";
            i += 1;
          } else {
            mode = "tag";
            tagClosing = line[i + 1] === "/";
            tagSelfClosing = false;
            let j = i + (tagClosing ? 2 : 1);
            const nameStart = j;
            if (j < line.length && NAME_START.test(line[j])) {
              j++;
              while (j < line.length && NAME_CHAR.test(line[j])) j++;
            }
            tagName = line.slice(nameStart, j);
            i = j - 1;
          }
          break;
        case "tag":
          if (ch === '"' || ch === "'") {
            mode = "quote";
            quoteChar = ch;
          } else if (ch === ">") {
            mode = "text";
            if (tagClosing) {
              popTo(stack, tagName);
            } else if (!tagSelfClosing && tagName) {
              stack.push(tagName);
            }
          } else if (ch === "/") {
            tagSelfClosing = true;
          } else if (!/\s/.test(ch)) {
            tagSelfClosing = false;
          }
          break;
        case "quote":
          if (ch === quoteChar) mode = "tag";
          break;
        case "comment":
          if (line.startsWith("-->", i)) {
            mode = "text";
            i += 2;
          }
          break;
        case "cdata":
          if (line.startsWith("]]>", i)) {
            mode = "text";
            i += 2;
          }
          break;
        case "pi":
          if (line.startsWith("?>", i)) {
            mode = "text";
            i += 1;
          }
          break;
      }
    }

    if (newColumn < 0) continue;

    // Trailing whitespace is content only when the line ends inside a quoted
    // value or CDATA section; everywhere else it is trimmed.
    const keepTrailing = mode === "quote" || mode === "cdata";
    const content = keepTrailing ? body : body.trimEnd();
    const formatted = content.length === 0 ? "" : renderIndent(newColumn, options.insertSpaces, tabSize) + content;
    if (formatted !== line) edits.push({ line: lineNo, text: formatted });
  }

  return edits;
}

/** Convenience for tests and tools: the fully formatted text. Line breaks are preserved as written. */
export function formatText(text: string, options: FormatOptions): string {
  const edits = new Map(formatLines(text, options).map((e) => [e.line, e.text]));
  if (edits.size === 0) return text;
  return text
    .split("\n")
    .map((raw, i) => {
      const edit = edits.get(i);
      if (edit === undefined) return raw;
      return raw.endsWith("\r") ? edit + "\r" : edit;
    })
    .join("\n");
}

/** Element name of a closing tag at the start of `body` (which begins with `</`). */
function closingName(body: string): string {
  const match = /^<\/([A-Za-z_:][\w:.-]*)/.exec(body);
  return match ? match[1] : "";
}

/** Pop the stack back through the nearest element named `name`; a stray closing tag pops nothing. */
function popTo(stack: string[], name: string): void {
  const index = stack.lastIndexOf(name);
  if (index >= 0) stack.length = index;
}

/** Width of a run of leading whitespace, with tabs advancing to the next tab stop. */
function measureColumns(whitespace: string, tabSize: number): number {
  let column = 0;
  for (const ch of whitespace) {
    column = ch === "\t" ? column + tabSize - (column % tabSize) : column + 1;
  }
  return column;
}

function renderIndent(column: number, insertSpaces: boolean, tabSize: number): string {
  if (insertSpaces) return " ".repeat(column);
  return "\t".repeat(Math.floor(column / tabSize)) + " ".repeat(column % tabSize);
}
