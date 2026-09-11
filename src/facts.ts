/**
 * Parse facts to inject into a session, from JSON or CSV text. Pure module so
 * the query panel, tests and assistant tools share one reading of the format.
 */
import { Fact } from "./api";

/**
 * Accepts a JSON array of {subject, relationship, object, certainty?} (or an
 * object with a `facts` array), or CSV lines `subject,relationship,object[,certainty]`.
 * Blank input yields []. Throws with a readable message on malformed input.
 */
export function parseFacts(text: string): Fact[] {
  const trimmed = text.trim();
  if (!trimmed) return [];

  if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch (error) {
      throw new Error(`Facts are not valid JSON: ${(error as Error).message}`);
    }
    const list = Array.isArray(parsed) ? parsed : (parsed as { facts?: unknown })?.facts;
    if (!Array.isArray(list)) throw new Error("Facts JSON must be an array of {subject, relationship, object, certainty?}");
    return list.map((entry, i) => {
      const r = (entry ?? {}) as Record<string, unknown>;
      if (typeof r.subject !== "string" || typeof r.relationship !== "string" || r.object === undefined || r.object === null) {
        throw new Error(`Fact #${i + 1} needs subject, relationship and object`);
      }
      const fact: Fact = { subject: r.subject, relationship: r.relationship, object: r.object as string | number | boolean };
      if (r.certainty !== undefined) fact.certainty = Number(r.certainty);
      else if (r.cf !== undefined) fact.certainty = Number(r.cf);
      return fact;
    });
  }

  const lines = trimmed
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));
  if (/^subject\s*,\s*relationship\s*,\s*object/i.test(lines[0] ?? "")) lines.shift();
  return lines.map((line, i) => {
    const cells = splitCsv(line);
    if (cells.length < 3) throw new Error(`Line ${i + 1}: expected subject,relationship,object[,certainty]`);
    const [subject, relationship, objectRaw, cf] = cells;
    const fact: Fact = { subject, relationship, object: coerce(objectRaw) };
    if (cf !== undefined && cf !== "") fact.certainty = Number(cf);
    return fact;
  });
}

function coerce(value: string): string | number | boolean {
  if (/^-?\d+(\.\d+)?$/.test(value)) return Number(value);
  if (value === "true" || value === "false") return value === "true";
  return value;
}

function splitCsv(line: string): string[] {
  const cells: string[] = [];
  let current = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (quoted && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        quoted = !quoted;
      }
    } else if (ch === "," && !quoted) {
      cells.push(current.trim());
      current = "";
    } else {
      current += ch;
    }
  }
  cells.push(current.trim());
  return cells;
}
