/**
 * Expression-language analysis shared by diagnostics and inlay hints.
 *
 * Rainbird evaluates arithmetic strictly left to right — there is no operator
 * precedence — so `%A + %B * 2` means `(%A + %B) * 2`. This module finds the
 * arithmetic chains where that reading differs from conventional precedence
 * and renders both readings, so the editor can warn, hint and offer fixes.
 * Pure TypeScript (no vscode import) so it is unit-testable and reusable.
 */

export interface ArithmeticChain {
  /** Offsets into the expression string: start of the first operand, end of the last. */
  start: number;
  end: number;
  text: string;
  operands: string[];
  ops: string[];
  /** True when a + or - precedes a * or / — the case where left-to-right and PEMDAS disagree. */
  mixed: boolean;
  /** The engine's reading, parenthesised step by step. */
  leftToRight: string;
  /** The conventional (PEMDAS) reading, parenthesised only around the * and / runs. */
  conventional: string;
}

type TokenType = "string" | "number" | "var" | "ident" | "lparen" | "rparen" | "comma" | "op" | "cmp" | "other";

interface Token {
  type: TokenType;
  text: string;
  start: number;
  end: number;
}

const OPERAND_TYPES = new Set<TokenType>(["string", "number", "var", "ident", "rparen"]);

function tokenize(expr: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const push = (type: TokenType, text: string) => {
    tokens.push({ type, text, start: i, end: i + text.length });
    i += text.length;
  };
  const lastIsOperand = () => {
    const last = tokens[tokens.length - 1];
    return !!last && OPERAND_TYPES.has(last.type);
  };
  while (i < expr.length) {
    const ch = expr[i];
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    const rest = expr.slice(i);
    let m: RegExpExecArray | null;
    if (ch === "'") {
      const close = expr.indexOf("'", i + 1);
      push("string", expr.slice(i, close === -1 ? expr.length : close + 1));
    } else if ((m = /^-?\d+(\.\d+)?/.exec(rest)) && (ch !== "-" || !lastIsOperand())) {
      push("number", m[0]);
    } else if ((m = /^%[A-Za-z0-9_]+/.exec(rest))) {
      push("var", m[0]);
    } else if ((m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(rest))) {
      push("ident", m[0]);
    } else if (ch === "(") {
      push("lparen", ch);
    } else if (ch === ")") {
      push("rparen", ch);
    } else if (ch === ",") {
      push("comma", ch);
    } else if ((m = /^(!=|>=|<=|=|>|<)/.exec(rest))) {
      push("cmp", m[0]);
    } else if ("+-*/".includes(ch)) {
      push("op", ch);
    } else {
      push("other", ch);
    }
  }
  return tokens;
}

type Item = { kind: "operand"; start: number; end: number } | { kind: "op"; text: string } | { kind: "break" };

/** Find every arithmetic chain in an expression (including inside parentheses and function arguments). */
export function analyseExpression(expr: string): ArithmeticChain[] {
  const tokens = tokenize(expr);
  const chains: ArithmeticChain[] = [];
  parseSequence(tokens, 0, expr, chains);
  return chains;
}

/** Parse from `i` until an unmatched ")" or a "," (not consumed) or the end; returns the stop index. */
function parseSequence(tokens: Token[], i: number, expr: string, chains: ArithmeticChain[]): number {
  const items: Item[] = [];
  while (i < tokens.length) {
    const t = tokens[i];
    if (t.type === "rparen" || t.type === "comma") break;
    if (t.type === "lparen") {
      const end = parseGroup(tokens, i, expr, chains);
      items.push({ kind: "operand", start: t.start, end: tokens[end - 1]?.end ?? t.end });
      i = end;
    } else if (t.type === "ident" && tokens[i + 1]?.type === "lparen") {
      const end = parseGroup(tokens, i + 1, expr, chains);
      items.push({ kind: "operand", start: t.start, end: tokens[end - 1]?.end ?? t.end });
      i = end;
    } else if (t.type === "string" || t.type === "number" || t.type === "var" || t.type === "ident") {
      items.push({ kind: "operand", start: t.start, end: t.end });
      i++;
    } else if (t.type === "op") {
      items.push({ kind: "op", text: t.text });
      i++;
    } else {
      items.push({ kind: "break" });
      i++;
    }
  }
  collectChains(items, expr, chains);
  return i;
}

/** tokens[i] is "(": parse the group (or argument list); returns the index after the matching ")". */
function parseGroup(tokens: Token[], i: number, expr: string, chains: ArithmeticChain[]): number {
  let j = i + 1;
  while (j < tokens.length) {
    j = parseSequence(tokens, j, expr, chains);
    if (j >= tokens.length) return j;
    if (tokens[j].type === "comma") {
      j++;
      continue;
    }
    return j + 1; // the matching ")"
  }
  return j;
}

function collectChains(items: Item[], expr: string, chains: ArithmeticChain[]): void {
  let operands: { start: number; end: number }[] = [];
  let ops: string[] = [];
  let expectOperand = true;
  const flush = () => {
    if (expectOperand && ops.length) ops.pop(); // dangling trailing operator
    if (ops.length >= 2) chains.push(buildChain(operands, ops, expr));
    operands = [];
    ops = [];
    expectOperand = true;
  };
  for (const item of items) {
    if (item.kind === "operand") {
      if (!expectOperand) flush();
      operands.push(item);
      expectOperand = false;
    } else if (item.kind === "op") {
      if (expectOperand) {
        flush();
      } else {
        ops.push(item.text);
        expectOperand = true;
      }
    } else {
      flush();
    }
  }
  flush();
}

const precedence = (op: string): number => (op === "*" || op === "/" ? 2 : 1);

function buildChain(operands: { start: number; end: number }[], ops: string[], expr: string): ArithmeticChain {
  const texts = operands.map((o) => expr.slice(o.start, o.end));
  const start = operands[0].start;
  const end = operands[operands.length - 1].end;

  let mixed = false;
  for (let i = 0; i < ops.length && !mixed; i++) {
    for (let j = i + 1; j < ops.length; j++) {
      if (precedence(ops[i]) < precedence(ops[j])) {
        mixed = true;
        break;
      }
    }
  }

  let acc = texts[0];
  for (let k = 0; k < ops.length; k++) acc = `(${acc} ${ops[k]} ${texts[k + 1]})`;
  const leftToRight = acc.slice(1, -1);

  const render = (xs: string[], os: string[]) =>
    xs.length === 1 ? xs[0] : `(${xs.map((x, i) => (i ? ` ${os[i - 1]} ${x}` : x)).join("")})`;
  const terms: string[] = [];
  const lowOps: string[] = [];
  let run = [texts[0]];
  let runOps: string[] = [];
  for (let k = 0; k < ops.length; k++) {
    if (precedence(ops[k]) === 2) {
      runOps.push(ops[k]);
      run.push(texts[k + 1]);
    } else {
      terms.push(render(run, runOps));
      lowOps.push(ops[k]);
      run = [texts[k + 1]];
      runOps = [];
    }
  }
  terms.push(render(run, runOps));
  const conventional = terms.map((t, i) => (i ? ` ${lowOps[i - 1]} ${t}` : t)).join("");

  return { start, end, text: expr.slice(start, end), operands: texts, ops, mixed, leftToRight, conventional };
}
