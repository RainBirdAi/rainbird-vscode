/**
 * Editor surface for RBLang: quick-fix code actions (served from the lint
 * engine's own fix data), the document outline (breadcrumbs, Cmd+Shift+O,
 * sticky scroll), and structure-based folding. The outline/folding computations
 * are pure functions over the tag index so they can be tested headlessly.
 */
import * as vscode from "vscode";
import { buildIndex, TagOccurrence, attrValueRange } from "./mapIndex";
import { analyseExpression } from "./expressions";
import { collectIssues, getCachedIssues } from "./diagnostics";

// ---------------------------------------------------------------------------
// Outline

export interface OutlineNode {
  name: string;
  detail: string;
  kind: string;
  start: number;
  end: number;
  selectionStart: number;
  selectionEnd: number;
  children: OutlineNode[];
}

interface ElementNode {
  tag: TagOccurrence;
  close?: TagOccurrence;
  children: ElementNode[];
}

/** Nest tags into an element tree (tolerant of unclosed elements mid-edit). */
function elementTree(tags: TagOccurrence[]): ElementNode[] {
  const roots: ElementNode[] = [];
  const stack: ElementNode[] = [];
  for (const tag of tags) {
    if (tag.name === "xml") continue;
    if (tag.closing) {
      for (let i = stack.length - 1; i >= 0; i--) {
        if (stack[i].tag.name === tag.name) {
          stack[i].close = tag;
          stack.length = i;
          break;
        }
      }
      continue;
    }
    const node: ElementNode = { tag, children: [] };
    (stack.length ? stack[stack.length - 1].children : roots).push(node);
    if (!tag.selfClosing) stack.push(node);
  }
  return roots;
}

const truncate = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

export function computeOutline(text: string): OutlineNode[] {
  const roots = elementTree(buildIndex(text).tags);

  const map = (el: ElementNode): OutlineNode | undefined => {
    const { tag } = el;
    const a = tag.attrs;
    const base = {
      start: tag.start,
      end: el.close ? el.close.end : tag.end,
      selectionStart: tag.start,
      selectionEnd: tag.end,
      children: el.children.map(map).filter((n): n is OutlineNode => !!n),
    };
    switch (tag.name) {
      case "concept":
        return { name: a.name ?? "concept", detail: [a.type, a.behaviour].filter(Boolean).join(" · "), kind: "concept", ...base };
      case "concinst":
        return { name: a.name ?? "instance", detail: a.type ?? "", kind: "instance", ...base };
      case "rel":
        return { name: a.name ?? "rel", detail: `${a.subject ?? "?"} → ${a.object ?? "?"}`, kind: "rel", ...base };
      case "firstForm":
      case "secondFormSubject":
      case "secondFormObject":
        return { name: tag.name, detail: "", kind: "question", ...base };
      case "relinst": {
        const isRule = el.children.some((c) => c.tag.name === "condition");
        if (isRule) {
          return { name: a.name ?? a.type ?? "rule", detail: `rule · cf ${a.cf ?? "100"}`, kind: "rule", ...base };
        }
        return {
          name: `${a.subject ?? "?"} ${a.type ?? "?"} ${a.object ?? "?"}`,
          detail: a.cf ? `cf ${a.cf}` : "",
          kind: "fact",
          ...base,
        };
      }
      case "condition":
        return {
          name: a.expression
            ? `expr: ${truncate(a.expression, 32)}`
            : truncate(`${a.subject ?? ""} ${a.rel ?? ""} ${a.object ?? ""}`.trim(), 48) || "condition",
          detail: a.behaviour === "mandatory" ? "mandatory" : "",
          kind: "condition",
          ...base,
        };
      case "datasource":
        return { name: a.name ?? "datasource", detail: a.hostname ?? "", kind: "datasource", ...base };
      case "import":
        return { name: `import ${a.km ?? "?"}`, detail: a.versionNumber ? `v${a.versionNumber}` : "", kind: "import", ...base };
      case "rbl:kb":
      case "meta":
      case "headers":
      case "header":
      case "action":
      case "input":
      case "compound":
        return undefined; // structural noise — children of rbl:kb are hoisted below
      default:
        return undefined;
    }
  };

  return roots.flatMap((root) =>
    root.tag.name === "rbl:kb"
      ? root.children.map(map).filter((n): n is OutlineNode => !!n)
      : [map(root)].filter((n): n is OutlineNode => !!n)
  );
}

// ---------------------------------------------------------------------------
// Folding

export interface FoldRange {
  start: number;
  end: number;
  kind?: "comment";
}

export function computeFolding(text: string): FoldRange[] {
  const lineStarts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === "\n") lineStarts.push(i + 1);
  const lineOf = (offset: number): number => {
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lineStarts[mid] <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  };

  const ranges: FoldRange[] = [];
  const visit = (el: ElementNode) => {
    if (el.close) {
      const start = lineOf(el.tag.start);
      const end = lineOf(el.close.start) - 1; // keep the closing tag visible
      if (end > start) ranges.push({ start, end });
    }
    el.children.forEach(visit);
  };
  elementTree(buildIndex(text).tags).forEach(visit);

  for (const m of text.matchAll(/<!--[\s\S]*?-->/g)) {
    const start = lineOf(m.index);
    const end = lineOf(m.index + m[0].length - 1);
    if (end > start) ranges.push({ start, end, kind: "comment" });
  }
  return ranges;
}

// ---------------------------------------------------------------------------
// Registration

const SYMBOL_KINDS: Record<string, vscode.SymbolKind> = {
  concept: vscode.SymbolKind.Class,
  instance: vscode.SymbolKind.EnumMember,
  rel: vscode.SymbolKind.Method,
  question: vscode.SymbolKind.String,
  rule: vscode.SymbolKind.Function,
  fact: vscode.SymbolKind.Constant,
  condition: vscode.SymbolKind.Property,
  datasource: vscode.SymbolKind.Interface,
  import: vscode.SymbolKind.Module,
};

export function registerEditorFeatures(context: vscode.ExtensionContext): void {
  const selector: vscode.DocumentSelector = { language: "rblang" };

  context.subscriptions.push(
    vscode.languages.registerCodeActionsProvider(
      selector,
      {
        provideCodeActions(doc, _range, ctx) {
          const issues = getCachedIssues(doc.uri.toString()) ?? collectIssues(doc.getText());
          const actions: vscode.CodeAction[] = [];
          for (const diagnostic of ctx.diagnostics) {
            if (diagnostic.source !== "rblang") continue;
            const startOffset = doc.offsetAt(diagnostic.range.start);
            const issue = issues.find((i) => i.start === startOffset && i.message === diagnostic.message);
            for (const fix of issue?.fixes ?? []) {
              const action = new vscode.CodeAction(fix.title, vscode.CodeActionKind.QuickFix);
              action.diagnostics = [diagnostic];
              action.isPreferred = issue!.fixes!.length === 1;
              action.edit = new vscode.WorkspaceEdit();
              for (const edit of fix.edits) {
                action.edit.replace(doc.uri, new vscode.Range(doc.positionAt(edit.start), doc.positionAt(edit.end)), edit.newText);
              }
              actions.push(action);
            }
          }
          return actions;
        },
      },
      { providedCodeActionKinds: [vscode.CodeActionKind.QuickFix] }
    ),

    vscode.languages.registerDocumentSymbolProvider(selector, {
      provideDocumentSymbols(doc) {
        const toSymbol = (node: OutlineNode): vscode.DocumentSymbol => {
          const symbol = new vscode.DocumentSymbol(
            node.name || "?",
            node.detail,
            SYMBOL_KINDS[node.kind] ?? vscode.SymbolKind.Object,
            new vscode.Range(doc.positionAt(node.start), doc.positionAt(node.end)),
            new vscode.Range(doc.positionAt(node.selectionStart), doc.positionAt(node.selectionEnd))
          );
          symbol.children = node.children.map(toSymbol);
          return symbol;
        };
        return computeOutline(doc.getText()).map(toSymbol);
      },
    }),

    vscode.languages.registerFoldingRangeProvider(selector, {
      provideFoldingRanges(doc) {
        return computeFolding(doc.getText()).map(
          (r) => new vscode.FoldingRange(r.start, r.end, r.kind === "comment" ? vscode.FoldingRangeKind.Comment : undefined)
        );
      },
    })
  );
}

/**
 * Inlay hints showing how the engine actually reads an arithmetic expression.
 * Only chains where left-to-right evaluation differs from conventional
 * precedence get a hint, so quiet maps stay quiet.
 */
export function registerInlayHints(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.languages.registerInlayHintsProvider(
      { language: "rblang" },
      {
        provideInlayHints(doc, range) {
          const index = buildIndex(doc.getText());
          const hints: vscode.InlayHint[] = [];
          for (const tag of index.tags) {
            if (tag.closing || tag.name !== "condition" || !tag.attrs.expression) continue;
            const valueRange = attrValueRange(tag, "expression");
            if (!valueRange) continue;
            const position = doc.positionAt(valueRange.end + 1); // just after the closing quote
            if (!range.contains(position)) continue;
            const chains = analyseExpression(tag.attrs.expression).filter((c) => c.mixed);
            if (!chains.length) continue;
            const hint = new vscode.InlayHint(position, ` ⇢ ${chains.map((c) => c.leftToRight).join(" · ")}`);
            hint.paddingLeft = true;
            hint.tooltip = new vscode.MarkdownString(
              "**How Rainbird evaluates this expression.** The engine applies operators strictly left to right, with no precedence. " +
                chains.map((c) => `\`${c.text}\` → \`${c.leftToRight}\` (conventional maths would read it as \`${c.conventional}\`).`).join(" ") +
                " Use the lightbulb on the warning to insert explicit parentheses."
            );
            hints.push(hint);
          }
          return hints;
        },
      }
    )
  );
}
