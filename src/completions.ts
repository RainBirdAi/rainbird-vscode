/**
 * Context-aware completions for RBLang, modelled on Studio's code-panel
 * completer: element completions based on the enclosing element, attribute
 * completions filtered by what's already present, enum value completions,
 * map-local name completions (concepts / relationships / instances), and
 * expression-language functions inside expression="..." attributes.
 */
import * as vscode from "vscode";
import { EXPRESSION_FUNCTIONS, SCHEMA } from "./schema";
import { buildIndex, enclosingElement } from "./mapIndex";

export function registerCompletions(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.languages.registerCompletionItemProvider(
      "rblang",
      { provideCompletionItems: provide },
      "<", " ", "\"", "%", "("
    ),
    vscode.languages.registerHoverProvider("rblang", { provideHover })
  );
}

function provide(
  doc: vscode.TextDocument,
  position: vscode.Position
): vscode.CompletionItem[] | undefined {
  const text = doc.getText();
  const offset = doc.offsetAt(position);
  const index = buildIndex(text);
  const lineBefore = doc.lineAt(position.line).text.slice(0, position.character);

  // Inside an expression="..." (or value="...") attribute value → expression language
  const exprMatch = /\b(expression|value)\s*=\s*"[^"]*$/.exec(lineBefore);
  if (exprMatch) {
    return expressionCompletions(text);
  }

  // Inside another attribute value → name completions from the map index
  const attrValueMatch = /\b([\w:.-]+)\s*=\s*"[^"]*$/.exec(lineBefore);
  const openTagMatch = /<([a-zA-Z_][\w:.-]*)\b[^>]*$/.exec(lineBefore);
  if (attrValueMatch && openTagMatch) {
    return attributeValueCompletions(openTagMatch[1], attrValueMatch[1], index);
  }

  // Inside an open tag but not in a value → attribute name completions
  if (openTagMatch) {
    return attributeNameCompletions(openTagMatch[1], openTagMatch[0]);
  }

  // Otherwise → child element completions for the enclosing element
  const parent = enclosingElement(index, offset) ?? "rbl:kb";
  return elementCompletions(parent);
}

function elementCompletions(parent: string): vscode.CompletionItem[] {
  const spec = SCHEMA[parent];
  const children = spec ? spec.children : Object.keys(SCHEMA);
  return children.map((name) => {
    const item = new vscode.CompletionItem(name, vscode.CompletionItemKind.Class);
    item.documentation = SCHEMA[name]?.doc;
    const childSpec = SCHEMA[name];
    const requiredAttrs = childSpec.required
      .filter((a) => a !== "xmlns:rbl")
      .map((a, i) => ` ${a}="\${${i + 1}}"`)
      .join("");
    item.insertText = new vscode.SnippetString(
      childSpec.children.length || childSpec.text
        ? `<${name}${requiredAttrs}>\n\t$0\n</${name}>`
        : `<${name}${requiredAttrs} />$0`
    );
    return item;
  });
}

function attributeNameCompletions(element: string, tagSource: string): vscode.CompletionItem[] | undefined {
  const spec = SCHEMA[element];
  if (!spec) return undefined;
  return [...spec.required, ...spec.optional]
    .filter((attr) => !new RegExp(`\\b${attr.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*=`).test(tagSource))
    .map((attr) => {
      const item = new vscode.CompletionItem(attr, vscode.CompletionItemKind.Property);
      const values = spec.enums?.[attr];
      item.insertText = new vscode.SnippetString(
        values ? `${attr}="\${1|${values.join(",")}|}"` : `${attr}="$1"`
      );
      if (spec.required.includes(attr)) item.sortText = `0${attr}`;
      return item;
    });
}

function attributeValueCompletions(
  element: string,
  attr: string,
  index: ReturnType<typeof buildIndex>
): vscode.CompletionItem[] | undefined {
  const spec = SCHEMA[element];
  const enums = spec?.enums?.[attr];
  if (enums) {
    return enums.map((v) => new vscode.CompletionItem(v, vscode.CompletionItemKind.EnumMember));
  }

  const conceptNames = () =>
    [...index.concepts.keys()].map((n) => new vscode.CompletionItem(n, vscode.CompletionItemKind.Class));
  const relationshipNames = () =>
    [...index.relationships.keys()].map((n) => new vscode.CompletionItem(n, vscode.CompletionItemKind.Interface));
  const instanceNames = () =>
    [...index.instances.keys()].map((n) => new vscode.CompletionItem(n, vscode.CompletionItemKind.Value));

  if (element === "rel" && (attr === "subject" || attr === "object")) return conceptNames();
  if (element === "concinst" && attr === "type") return conceptNames();
  if ((element === "relinst" || element === "compound") && attr === "type") return relationshipNames();
  if (element === "condition" && attr === "rel") return relationshipNames();
  if (element === "input" && attr === "rel") return relationshipNames();
  if ((element === "relinst" || element === "condition") && (attr === "subject" || attr === "object")) {
    const placeholders = ["%S", "%O"].map(
      (v) => new vscode.CompletionItem(v, vscode.CompletionItemKind.Variable)
    );
    return [...placeholders, ...instanceNames()];
  }
  return undefined;
}

function expressionCompletions(text: string): vscode.CompletionItem[] {
  const items: vscode.CompletionItem[] = EXPRESSION_FUNCTIONS.map((fn) => {
    const item = new vscode.CompletionItem(fn.name, vscode.CompletionItemKind.Function);
    item.detail = fn.signature;
    item.documentation = fn.doc;
    item.insertText = new vscode.SnippetString(`${fn.name}($1)`);
    return item;
  });

  for (const alias of [
    "is equal to", "is not equal to", "is greater than", "is greater than or equal to",
    "is less than", "is less than or equal to", "equals", "does not equal", "and", "or",
  ]) {
    items.push(new vscode.CompletionItem(alias, vscode.CompletionItemKind.Operator));
  }

  // Variables already used anywhere in the document
  const seen = new Set<string>(["%S", "%O"]);
  for (const m of text.matchAll(/%[A-Z][A-Z0-9_]*/g)) seen.add(m[0]);
  for (const variable of seen) {
    items.push(new vscode.CompletionItem(variable, vscode.CompletionItemKind.Variable));
  }
  return items;
}

function provideHover(doc: vscode.TextDocument, position: vscode.Position): vscode.Hover | undefined {
  const wordRange = doc.getWordRangeAtPosition(position, /[\w:-]+/);
  if (!wordRange) return undefined;
  const word = doc.getText(wordRange);

  const fn = EXPRESSION_FUNCTIONS.find((f) => f.name === word);
  if (fn) {
    return new vscode.Hover(new vscode.MarkdownString(`\`${fn.signature}\`\n\n${fn.doc}`), wordRange);
  }
  const spec = SCHEMA[word];
  if (spec && doc.lineAt(position.line).text.includes(`<${word}`)) {
    return new vscode.Hover(new vscode.MarkdownString(`**\`<${word}>\`** — ${spec.doc}`), wordRange);
  }
  return undefined;
}
