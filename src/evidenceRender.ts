/**
 * The Studio-style evidence tree, rendered once in the extension host and
 * shared by the query panel's inline tree and the standalone evidence view
 * (plus a plain-text outline for the assistant's get_evidence tool).
 *
 * Studio's model: a fact card per fact (source colour, triple, certainty); a
 * rule card lists its conditions, each with the fact that satisfied it; a list
 * function shows the call, its result and every contributing fact; unmet
 * optional conditions are struck through at 0%; zero-weight conditions sit
 * under "Zero salience conditions"; the salience chart draws each condition's
 * impact against its maximum possible impact on a 0-100 scale.
 *
 * Everything dynamic goes through esc(). No vscode import: unit-tested in Node.
 */
import {
  ExpandedCondition,
  ExpandedEvidence,
  ExpandedFunctionCall,
  ExpandedFunctionFact,
  ExpandedNode,
  EvidenceMeta,
  ImpactScale,
  LeafFact,
  SOURCE_LABELS,
  SourceKind,
  bindingText,
  formatValue,
  functionCallsOf,
  impactScale,
  isUnmet,
  leafFacts,
  maxImpact,
  normaliseSource,
  sourceLabel,
  substituteAlt,
  walkEvidence,
} from "./evidenceModel";
import type { EvidenceRule } from "./api";

/** Badge kinds: every fact source plus Studio's light-blue list-function card. */
export type BadgeKind = SourceKind | "listFunction";

export interface BadgeStyle {
  /** Badge background (Studio's colour for the source). */
  bg: string;
  /** Text colour on the badge, chosen for at least 4.5:1 contrast. */
  fg: string;
  label: string;
  /** Tooltip and legend text. */
  description: string;
}

/**
 * Studio's evidence colours: rule dark blue, list function light blue,
 * injected light green, answer red, datasource dark green, knowledge map
 * orange. Light badges get dark text so they stay readable in every theme.
 */
export const SOURCE_STYLE: Record<BadgeKind, BadgeStyle> = {
  rule: { bg: "#2f4fb5", fg: "#ffffff", label: SOURCE_LABELS.rule, description: "Inferred by a rule" },
  listFunction: { bg: "#74c0fc", fg: "#1b1b1b", label: "list function", description: "Computed by a list function from several facts" },
  injection: { bg: "#8ce99a", fg: "#1b1b1b", label: SOURCE_LABELS.injection, description: "Injected into the session" },
  answer: { bg: "#c92a2a", fg: "#ffffff", label: SOURCE_LABELS.answer, description: "Answered in this session" },
  datasource: { bg: "#237032", fg: "#ffffff", label: SOURCE_LABELS.datasource, description: "Fetched from a datasource" },
  knowledgemap: { bg: "#f76707", fg: "#1b1b1b", label: SOURCE_LABELS.knowledgemap, description: "Stored in the knowledge map" },
  synthesis: {
    bg: "#adb5bd",
    fg: "#1b1b1b",
    label: SOURCE_LABELS.synthesis,
    description: "Optional condition that was not met: the engine used a 0% placeholder",
  },
  unknown: { bg: "#495057", fg: "#ffffff", label: SOURCE_LABELS.unknown, description: "Source not loaded" },
};

const LEGEND_ORDER: BadgeKind[] = ["rule", "listFunction", "injection", "answer", "datasource", "knowledgemap", "synthesis", "unknown"];
const INPUT_ORDER: SourceKind[] = ["answer", "injection", "datasource", "knowledgemap", "unknown", "rule", "synthesis"];
const COUNT_LABELS: Record<SourceKind, string> = {
  answer: "answered",
  injection: "injected",
  datasource: "from datasources",
  knowledgemap: "from the knowledge map",
  unknown: "not loaded",
  rule: "inferred",
  synthesis: "not met",
};

export interface RenderOptions {
  /** Rule cards nested this deep or deeper start collapsed; the root is depth 0 (default 1: only the root is open). */
  collapseDepth?: number;
  /**
   * Prefix for element ids. The default is "evt-" plus a short hash of the root
   * factID, so trees for different results can share one page; pass one only to
   * override it.
   */
  idPrefix?: string;
  /** Optional toolbar buttons; Expand all / Collapse all are always there. */
  toolbar?: { studio?: boolean; copyLink?: boolean; openPanel?: boolean };
}

/**
 * The tree as an HTML fragment: `<div class="evt" data-fact="{root factID}">`
 * holding the toolbar, the legend, the root card, "Inputs used by this result"
 * and footnotes. Interactive parts are `data-*` attributes handled by
 * EVIDENCE_SCRIPT: `data-evt-act="expand|collapse|openStudio|copyLink|openPanel"`
 * (with `data-fact`) and `data-evt-goto="{element id}"`.
 */
export function renderEvidenceHtml(tree: ExpandedNode | ExpandedEvidence | undefined | null, opts: RenderOptions = {}): string {
  if (!tree || typeof tree !== "object") return `<div class="evt"><p class="evt-note">No evidence to show.</p></div>`;
  const prefix = String(opts.idPrefix ?? defaultIdPrefix(tree.factID)).replace(/[^A-Za-z0-9_-]/g, "-");
  const collapseDepth = typeof opts.collapseDepth === "number" && Number.isFinite(opts.collapseDepth) ? opts.collapseDepth : 1;

  // First pass: an id for each expanded fact (repeat / cyclic rows link to it) and the kinds present (the legend).
  const ids = new Map<string, string>();
  const kinds = new Set<BadgeKind>();
  walkEvidence(tree, (node) => {
    const kind = normaliseSource(node.source);
    if (!node.repeat && !node.cyclic && kind !== "synthesis" && typeof node.factID === "string" && !ids.has(node.factID)) {
      ids.set(node.factID, `${prefix}f${ids.size}`);
    }
    kinds.add(kind);
    for (const condition of conditionsOf(node)) {
      if (!condition.expression && condition.factID && !condition.evidence) kinds.add("unknown");
      for (const [, call] of functionCallsOf(condition)) {
        kinds.add("listFunction");
        for (const fact of factsOf(call)) if (!fact.evidence) kinds.add("unknown");
      }
    }
  });

  // Rule cards on the current path: expandEvidence never loops, but a hand-built tree could.
  const drawing = new Set<ExpandedNode>();
  const ruleCard = (node: ExpandedNode, depth: number, isRoot: boolean): string => {
    if (drawing.has(node)) return note("Depends on a fact further up this branch, so it is not expanded again.");
    drawing.add(node);
    try {
      return ruleCardBody(node, depth, isRoot);
    } finally {
      drawing.delete(node);
    }
  };
  const ruleCardBody = (node: ExpandedNode, depth: number, isRoot: boolean): string => {
    const rule = node.rule ?? {};
    const conditions = conditionsOf(node);
    const scale = impactScale(rule);
    const id = ids.get(node.factID);
    const open = depth < collapseDepth ? " open" : "";
    const summary = isRoot
      ? factHead(node)
      : `${badge("rule")} <span class="evt-why">How this was inferred (${plural(conditions.length, "condition")})</span>`;
    const main: string[] = [];
    const zero: string[] = [];
    conditions.forEach((condition, i) => (condition.salience === 0 ? zero : main).push(conditionRow(node, condition, i, depth, scale)));
    const cap = typeof rule.ruleMaxCertainty === "number" ? ` · certainty cap ${fmtNum(rule.ruleMaxCertainty)}%` : "";
    const body = [
      rule.alt ? `<div class="evt-alt evt-rule-alt">${esc(substituteAlt(rule.alt, rule.bindings))}</div>` : "",
      conditions.length
        ? `<div class="evt-rulehead">Conditions, in the order the engine reports them${cap}</div>`
        : `<div class="evt-rulehead">The engine reported no conditions for this rule${cap}.</div>`,
      bindingsHtml(rule.bindings),
      main.length ? `<ol class="evt-conds">${main.join("")}</ol>` : "",
      zero.length
        ? `<details class="evt-zero"${open}><summary>Zero salience conditions (${zero.length})</summary>` +
          `<div class="evt-note">Weight 0: these conditions had to hold but do not change the certainty.</div><ol class="evt-conds">${zero.join("")}</ol></details>`
        : "",
    ].join("");
    return (
      `<details class="evt-card evt-rulecard${isRoot ? " evt-root" : ""}"${open}${id ? ` id="${esc(id)}"` : ""} data-fact="${esc(node.factID)}" style="${borderStyle("rule")}">` +
      `<summary class="evt-head">${summary}</summary><div class="evt-body">${body}</div></details>`
    );
  };

  const conditionRow = (node: ExpandedNode, condition: ExpandedCondition, index: number, depth: number, scale: ImpactScale | undefined): string => {
    const unmet = isUnmet(condition);
    const zero = condition.salience === 0;
    const calls = functionCallsOf(condition);
    const shape = condition.expression ? (calls.length ? "evt-fn-cond" : "evt-expr-cond") : "evt-rel-cond";
    const classes = ["evt-cond", shape, unmet ? "evt-unmet" : "", zero ? "evt-zero-cond" : ""].filter(Boolean).join(" ");
    let what: string;
    let below = "";
    if (condition.expression) {
      const text = String(condition.expression.text ?? "");
      const tick = metMark(condition.wasMet);
      if (calls.length === 1 && isJustTheCall(calls[0][0], text)) {
        what = `${badge("listFunction")} ${callHtml(calls[0], text)}${tick}`;
        below = factList(calls[0][1], depth);
      } else {
        // Studio fills the variables in; here they are a tooltip, so the rule's own text stays visible.
        // (Not for list-function expressions: each call's result is listed under the row instead.)
        const filled = calls.length ? text : fillVariables(text, node.rule?.bindings);
        const title = filled !== text ? ` title="${esc(`With values: ${filled}`)}"` : "";
        what = `${calls.length ? badge("listFunction") : `<span class="evt-tag">expression</span>`} <code${title}>${esc(text)}</code>${tick}`;
        below = calls.map((call) => `<div class="evt-fn">${callHtml(call)}</div>${factList(call[1], depth)}`).join("");
      }
      if (unmet) what += ` <span class="evt-tag evt-tag-unmet">not met</span>`;
    } else {
      const support = condition.evidence;
      const kind: SourceKind = support ? normaliseSource(support.source) : "unknown";
      const showBadge = !!support || !!condition.factID;
      what =
        `${tripleHtml(condition.subject, condition.relationship, condition.object, condition.objectType)}` +
        (showBadge ? ` ${badge(kind, support?.source)}` : "") +
        ` <span class="evt-cf">${fmtPct(condition.certainty ?? support?.fact?.certainty)}</span>` +
        (unmet && kind !== "synthesis" ? ` <span class="evt-tag evt-tag-unmet">not met</span>` : "");
      below = supportHtml(condition, depth);
    }
    const alt = condition.alt ? `<div class="evt-alt">${esc(substituteAlt(condition.alt, node.rule?.bindings))}</div>` : "";
    return (
      `<li class="${classes}"><div class="evt-row"><span class="evt-n">${index + 1}</span>` +
      `<span class="evt-what">${what}</span>${impactHtml(node.rule, condition, unmet, zero, scale)}</div>${alt}${below}</li>`
    );
  };

  const factList = (call: ExpandedFunctionCall, depth: number): string => {
    const facts = factsOf(call);
    if (!facts.length) return "";
    const items = facts.map((fact) => {
      const kind: SourceKind = fact.evidence ? normaliseSource(fact.evidence.source) : "unknown";
      return (
        `<li>${badge(kind, fact.evidence?.source)} ${tripleHtml(fact.subject, fact.relationship, fact.object, fact.objectType)}` +
        ` <span class="evt-cf">${fmtPct(fact.certainty ?? fact.evidence?.fact?.certainty)}</span>${supportHtml(fact, depth)}</li>`
      );
    });
    return `<ul class="evt-fn-facts">${items.join("")}</ul>`;
  };

  // What sits under a row: nothing for a fact from an answer, injection, datasource or the
  // map (its badge and certainty are already on the row); a nested card for a rule; a note
  // when the fact was not loaded or is shown elsewhere.
  const supportHtml = (ref: ExpandedCondition | ExpandedFunctionFact, depth: number): string => {
    if (ref.fetchError) return note(`Could not load this fact: ${esc(shorten(ref.fetchError, 200))}`, "evt-warn");
    if (ref.truncated) return note("Not loaded: the evidence tree reached its size limit.");
    const support = ref.evidence;
    if (ref.cyclic) return note(`Depends on a fact further up this branch, so it is not expanded again.${gotoButton(support && ids.get(support.factID))}`);
    if (!support || normaliseSource(support.source) !== "rule") return "";
    if (ref.repeat || support.repeat) return note(`Shown in full elsewhere in this tree.${gotoButton(ids.get(support.factID))}`);
    return ruleCard(support, depth + 1, false);
  };

  const rootCard =
    tree.rule || normaliseSource(tree.source) === "rule"
      ? ruleCard(tree, 0, true)
      : `<div class="evt-card evt-leafcard evt-root" id="${esc(ids.get(tree.factID) ?? `${prefix}f0`)}" data-fact="${esc(tree.factID)}" style="${borderStyle(normaliseSource(tree.source))}"><div class="evt-head">${factHead(tree)}</div></div>`;

  const meta = (tree as Partial<ExpandedEvidence>).meta;
  return (
    `<div class="evt" data-fact="${esc(tree.factID)}">` +
    toolbarHtml(tree.factID, opts.toolbar) +
    legendHtml(kinds) +
    rootCard +
    inputsHtml(leafFacts(tree)) +
    footnotes(meta, !!opts.toolbar?.studio) +
    `</div>`
  );
}

/**
 * A complete webview document for one tree (the standalone evidence view):
 * nonce CSP, no external resources, the shared stylesheet and EVIDENCE_SCRIPT.
 */
export function renderEvidencePage(
  tree: ExpandedNode | ExpandedEvidence | undefined | null,
  opts: { nonce: string; heading?: string; subheading?: string; render?: RenderOptions }
): string {
  const nonce = String(opts.nonce).replace(/[^A-Za-z0-9+/=_-]/g, "");
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>${PAGE_CSS}${EVIDENCE_CSS}</style>
</head>
<body>
<h1>${esc(opts.heading ?? "Evidence tree")}</h1>
${opts.subheading ? `<div class="page-sub">${esc(opts.subheading)}</div>` : ""}
${renderEvidenceHtml(tree, opts.render)}
<script nonce="${nonce}">const vscode = acquireVsCodeApi();${EVIDENCE_SCRIPT}</script>
</body>
</html>`;
}

const PAGE_CSS = /* css */ `
* { box-sizing: border-box; }
body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); padding: 1rem 1.25rem; max-width: 980px; }
h1 { font-size: 1.1em; font-weight: 600; margin: 0 0 .2rem; }
.page-sub { font-size: .8em; opacity: .7; margin-bottom: .5rem; overflow-wrap: anywhere; }
button { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); border: none; border-radius: 4px; padding: .3rem .7rem; cursor: pointer; }
button:hover { background: var(--vscode-button-secondaryHoverBackground); }
`;

/**
 * The tree as an indented plain-text outline for a language model: each fact
 * with certainty and source, rule conditions in the order the engine reports
 * them with impact, maximum possible impact and weight, evidence text,
 * list-function results with every contributing fact, unmet and zero-salience
 * conditions, the inputs used, and what could not be loaded.
 */
export function describeEvidence(tree: ExpandedNode | ExpandedEvidence | undefined | null, opts: { maxChars?: number } = {}): string {
  if (!tree || typeof tree !== "object") return "No evidence.";
  const lines: string[] = [];
  const head = (node: ExpandedNode) =>
    `${tripleText(node.fact?.subject?.value, node.fact?.relationship?.type, node.fact?.object?.value, node.fact?.object?.dataType)} — ${fmtPct(node.fact?.certainty)} [${textSource(node.source)}]`;

  const describing = new Set<ExpandedNode>(); // see renderEvidenceHtml: guards hand-built loops
  const describeRule = (node: ExpandedNode, pad: string) => {
    if (describing.has(node)) {
      lines.push(`${pad}(depends on a fact further up this branch; not expanded again)`);
      return;
    }
    describing.add(node);
    try {
      describeRuleBody(node, pad);
    } finally {
      describing.delete(node);
    }
  };
  const describeRuleBody = (node: ExpandedNode, pad: string) => {
    const rule = node.rule ?? {};
    const conditions = conditionsOf(node);
    const scale = impactScale(rule);
    const cap = typeof rule.ruleMaxCertainty === "number" ? ` (certainty cap ${fmtNum(rule.ruleMaxCertainty)}%)` : "";
    const vars = Object.entries(rule.bindings && typeof rule.bindings === "object" ? rule.bindings : {})
      .map(([name, value]) => `${name.startsWith("%") ? name : `%${name}`} = ${bindingText(value)}`)
      .join(", ");
    if (rule.alt) lines.push(`${pad}Evidence text: "${substituteAlt(rule.alt, rule.bindings)}"`);
    lines.push(`${pad}Rule${cap}${vars ? `; variables ${vars}` : ""}; ${conditions.length ? "conditions in the order the engine reports them:" : "no conditions reported."}`);
    conditions.forEach((condition, i) => {
      const n = `${pad}${i + 1}. `;
      const sub = `${pad}   `;
      const flags = [
        isUnmet(condition) ? "NOT MET (optional condition; 0% impact)" : "",
        condition.salience === 0 ? "zero salience (weight 0: no effect on the certainty)" : "",
      ].filter(Boolean);
      const impact = impactText(rule, condition, scale);
      if (condition.expression) {
        const text = String(condition.expression.text ?? "");
        const calls = functionCallsOf(condition);
        const tail = `${impact}${flags.length ? ` · ${flags.join(" · ")}` : ""}`;
        const callLine = ([call, fn]: [string, ExpandedFunctionCall]) => `list function ${call} = ${resultText(fn)} (${plural(factsOf(fn).length, "fact")})`;
        const folded = calls.length === 1 && isJustTheCall(calls[0][0], text);
        if (folded) {
          lines.push(`${n}${callLine(calls[0])}${tail}`);
        } else {
          const was = condition.wasMet === true ? " was true" : condition.wasMet === false ? " was false" : "";
          const filled = calls.length ? text : fillVariables(text, rule.bindings);
          lines.push(`${n}expression "${text}"${filled !== text ? ` (with values: ${filled})` : ""}${was}${tail}`);
        }
        for (const call of calls) {
          const facts = factsOf(call[1]);
          if (!folded) lines.push(`${sub}${callLine(call)}${facts.length ? ":" : ""}`);
          for (const fact of facts) {
            const source = fact.evidence ? textSource(fact.evidence.source) : "source not loaded";
            lines.push(`${sub}  - ${tripleText(fact.subject, fact.relationship, fact.object, fact.objectType)} — ${fmtPct(fact.certainty)} [${source}]${refText(fact)}`);
            if (expandable(fact)) describeRule(fact.evidence as ExpandedNode, `${sub}    `);
          }
        }
      } else {
        const support = condition.evidence ? textSource(condition.evidence.source) : condition.factID ? "source not loaded" : "no fact";
        lines.push(
          `${n}${tripleText(condition.subject, condition.relationship, condition.object, condition.objectType)} — ${fmtPct(condition.certainty)} [${support}]${impact}${flags.length ? ` · ${flags.join(" · ")}` : ""}${refText(condition)}`
        );
      }
      if (condition.alt) lines.push(`${sub}evidence text: "${substituteAlt(condition.alt, rule.bindings)}"`);
      if (!condition.expression && expandable(condition)) describeRule(condition.evidence as ExpandedNode, sub);
    });
  };

  lines.push(`${head(tree)} (factID ${tree.factID})`);
  if (tree.rule || normaliseSource(tree.source) === "rule") describeRule(tree, "  ");
  const inputs = leafFacts(tree);
  lines.push("", `Inputs used by this result (${inputs.length}):`);
  for (const fact of sortInputs(inputs)) {
    lines.push(`  - ${tripleText(fact.subject, fact.relationship, fact.object, fact.objectType)} — ${fmtPct(fact.certainty)} [${fact.kind === "unknown" ? "source not loaded" : textSource(fact.source ?? fact.kind)}]`);
  }
  const meta = (tree as Partial<ExpandedEvidence>).meta;
  if (meta?.truncated) lines.push("", `Note: the tree was cut short after ${plural(meta.nodes, "fact")}; parts marked "not loaded" were not fetched.`);
  if (meta?.errors) lines.push("", `Note: ${plural(meta.errors, "fact")} could not be loaded (marked "could not load").`);

  const text = lines.join("\n");
  const max = opts.maxChars ?? 30000;
  if (text.length <= max) return text;
  const cut = text.lastIndexOf("\n", max);
  return `${text.slice(0, cut > 0 ? cut : max)}\n… (outline truncated at ${max} characters)`;
}

/** A fact triple as plain text, with dates as YYYY-MM-DD (for titles and outlines; escape it before putting it in HTML). */
export function tripleText(subject: unknown, relationship: unknown, object: unknown, objectType?: string): string {
  return `${String(subject ?? "?")} ${String(relationship ?? "?")} ${formatValue(object, objectType)}`;
}

/**
 * Every rule is scoped under .evt so the stylesheet can be inlined into any
 * webview without touching the host page. Uses VS Code theme variables, with
 * Studio's source colours applied inline per badge.
 */
export const EVIDENCE_CSS = /* css */ `
.evt { font-size: .92em; line-height: 1.4; margin-top: .4rem; }
.evt .evt-toolbar { display: flex; flex-wrap: wrap; gap: .3rem; align-items: center; margin-bottom: .35rem; }
.evt .evt-toolbar button { font-size: .85em; padding: .2rem .6rem; margin: 0; }
.evt .evt-sp { flex: 1; }
.evt .evt-legend { display: flex; flex-wrap: wrap; gap: .3rem; align-items: center; font-size: .85em; margin: .15rem 0 .45rem; }
.evt .evt-legend-title { opacity: .7; margin-right: .15rem; }
.evt .evt-badge { display: inline-block; border-radius: 3px; padding: 0 .4em; font-size: .78em; line-height: 1.55; white-space: nowrap; vertical-align: middle; }
.evt .evt-tag { display: inline-block; border: 1px solid var(--vscode-panel-border); border-radius: 3px; padding: 0 .35em; font-size: .75em; line-height: 1.45; opacity: .85; white-space: nowrap; vertical-align: middle; }
.evt .evt-card { border: 1px solid var(--vscode-panel-border); border-left-width: 3px; border-radius: 6px; padding: .35rem .55rem; margin: .3rem 0; background: var(--vscode-editorWidget-background); }
.evt .evt-card .evt-card { margin: .3rem 0 .1rem 1.9rem; }
.evt summary { cursor: pointer; list-style: none; }
.evt summary::-webkit-details-marker { display: none; }
.evt summary::before { content: "▸"; display: inline-block; width: 1em; opacity: .6; }
.evt details[open] > summary::before { content: "▾"; }
.evt .evt-head { line-height: 1.6; }
.evt .evt-leafcard .evt-head { padding-left: 1em; }
.evt .evt-why { opacity: .85; }
.evt .evt-triple b { font-weight: 600; }
.evt .evt-rel { font-style: italic; opacity: .9; }
.evt .evt-cf { font-size: .85em; opacity: .75; white-space: nowrap; }
.evt .evt-body { margin-top: .25rem; }
.evt .evt-rulehead { font-size: .8em; opacity: .7; margin: .2rem 0 .1rem; }
.evt .evt-vars { font-size: .8em; opacity: .8; margin: 0 0 .15rem; }
.evt .evt-var { display: inline-block; border: 1px solid var(--vscode-panel-border); border-radius: 8px; padding: 0 .45em; margin: .1rem .25rem 0 0; font-family: var(--vscode-editor-font-family); }
.evt .evt-conds { list-style: none; margin: .1rem 0 0; padding: 0; }
.evt .evt-cond { padding: .3rem 0; border-top: 1px dashed var(--vscode-panel-border); }
.evt .evt-cond:first-child { border-top: none; }
.evt .evt-row { display: flex; align-items: center; gap: .45rem; }
.evt .evt-n { flex: 0 0 auto; min-width: 1.4em; text-align: right; font-size: .8em; opacity: .55; }
.evt .evt-what { flex: 1 1 auto; min-width: 0; overflow-wrap: anywhere; }
.evt .evt-impact { flex: 0 0 auto; display: inline-flex; align-items: center; gap: .35rem; }
.evt .evt-bar { position: relative; display: inline-block; width: 72px; height: 8px; border: 1px solid var(--vscode-panel-border); border-radius: 2px; overflow: hidden; }
.evt .evt-bar-max { position: absolute; left: 0; top: 0; bottom: 0; background: var(--vscode-descriptionForeground, #888); opacity: .4; }
.evt .evt-bar-val { position: absolute; left: 0; top: 0; bottom: 0; background: var(--vscode-charts-blue, #3794ff); }
.evt .evt-pct { min-width: 3.4em; text-align: right; font-size: .8em; opacity: .8; font-variant-numeric: tabular-nums; }
.evt .evt-unmet > .evt-row .evt-what { text-decoration: line-through; opacity: .6; }
.evt .evt-unmet > .evt-row .evt-tag-unmet { text-decoration: none; }
.evt .evt-met { margin-left: .3em; font-weight: 600; color: var(--vscode-testing-iconPassed, #388a34); }
.evt .evt-met.evt-false { color: var(--vscode-testing-iconFailed, #c72e0f); }
.evt code { font-family: var(--vscode-editor-font-family); font-size: .92em; background: var(--vscode-textCodeBlock-background, rgba(128, 128, 128, .15)); border-radius: 3px; padding: 0 .25em; }
.evt .evt-count { font-size: .85em; opacity: .75; }
.evt .evt-none { font-style: italic; opacity: .75; }
.evt .evt-fn { margin: .15rem 0 0 1.9rem; }
.evt .evt-fn-facts { list-style: none; margin: .15rem 0 .05rem 1.9rem; padding: 0; font-size: .95em; }
.evt .evt-fn-facts > li { margin: .12rem 0; }
.evt .evt-alt { margin: .1rem 0 0 1.9rem; font-style: italic; opacity: .85; }
.evt .evt-rule-alt { margin-left: 0; }
.evt .evt-note { margin: .15rem 0 0 1.9rem; font-size: .82em; opacity: .75; }
.evt .evt-warn { color: var(--vscode-editorWarning-foreground, #bf8803); opacity: 1; }
.evt .evt-zero { margin: .3rem 0 0; }
.evt .evt-zero > summary { font-size: .85em; opacity: .85; }
.evt .evt-inputs { margin-top: .5rem; }
.evt .evt-inputs > summary { font-weight: 600; }
.evt .evt-inputs-sum { font-size: .82em; opacity: .75; margin: .15rem 0 0 1em; }
.evt .evt-inputs table { border-collapse: collapse; margin: .3rem 0 0 1em; font-size: .9em; }
.evt .evt-inputs th, .evt .evt-inputs td { text-align: left; vertical-align: top; padding: .12rem .7rem .12rem 0; }
.evt .evt-inputs th { font-weight: 600; opacity: .75; }
.evt .evt-foot { margin-top: .4rem; font-size: .8em; opacity: .75; }
.evt .evt-link, .evt .evt-link:hover { background: none; border: none; margin: 0 0 0 .3em; padding: 0; color: var(--vscode-textLink-foreground); text-decoration: underline; cursor: pointer; font: inherit; }
.evt .evt-flash { outline: 2px solid var(--vscode-focusBorder, #007fd4); outline-offset: 2px; }
.evt .evt-sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
`;

/**
 * Webview script for any page that shows trees from renderEvidenceHtml. It
 * expects `vscode` (from acquireVsCodeApi()) in scope, delegates clicks from
 * the document so trees inserted later work, and installs itself once even if
 * the page includes it twice. Expand all / Collapse all and "Go to it" run in
 * the page; Open in Studio / Copy link / Open in panel post
 * { type: 'evidenceAction', action: 'openStudio' | 'copyLink' | 'openPanel', factId }.
 */
export const EVIDENCE_SCRIPT = /* js */ `
(function () {
  if (window.__rainbirdEvidenceTree) return;
  window.__rainbirdEvidenceTree = true;
  var ACTIONS = { openStudio: true, copyLink: true, openPanel: true };
  function setAll(tree, open) {
    var all = tree.querySelectorAll('details');
    for (var i = 0; i < all.length; i++) {
      if (!open && all[i].classList.contains('evt-root')) continue;
      all[i].open = open;
    }
  }
  function reveal(target) {
    for (var p = target.parentElement; p; p = p.parentElement) if (p.tagName === 'DETAILS') p.open = true;
    if (target.tagName === 'DETAILS') target.open = true;
    if (target.scrollIntoView) target.scrollIntoView({ block: 'center' });
    target.classList.add('evt-flash');
    setTimeout(function () { target.classList.remove('evt-flash'); }, 1500);
  }
  document.addEventListener('click', function (e) {
    var t = e.target;
    var el = t && t.closest ? t.closest('[data-evt-act], [data-evt-goto]') : null;
    if (!el) return;
    var tree = el.closest('.evt');
    if (!tree) return;
    var act = el.getAttribute('data-evt-act');
    if (act === 'expand' || act === 'collapse') {
      e.preventDefault();
      setAll(tree, act === 'expand');
    } else if (act && ACTIONS[act]) {
      e.preventDefault();
      if (typeof vscode !== 'undefined' && vscode) {
        vscode.postMessage({ type: 'evidenceAction', action: act, factId: el.getAttribute('data-fact') || tree.getAttribute('data-fact') || '' });
      }
    } else if (el.hasAttribute('data-evt-goto')) {
      e.preventDefault();
      var target = document.getElementById(el.getAttribute('data-evt-goto'));
      if (target) reveal(target);
    }
  });
})();
`;

// ── helpers ──

function esc(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** "evt-" plus a short FNV-1a hash of the root factID: distinct ids for distinct trees on one page. */
function defaultIdPrefix(factId: unknown): string {
  const text = String(factId ?? "");
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return `evt-${(hash >>> 0).toString(36)}-`;
}

function conditionsOf(node: ExpandedNode): ExpandedCondition[] {
  const conditions = node.rule?.conditions;
  return Array.isArray(conditions) ? conditions.filter((c): c is ExpandedCondition => !!c && typeof c === "object") : [];
}

function factsOf(call: ExpandedFunctionCall): ExpandedFunctionFact[] {
  return Array.isArray(call.facts) ? call.facts.filter((f): f is ExpandedFunctionFact => !!f && typeof f === "object") : [];
}

function badgeKindStyle(kind: BadgeKind): BadgeStyle {
  return SOURCE_STYLE[kind] ?? SOURCE_STYLE.unknown;
}

function badge(kind: BadgeKind, rawSource?: unknown): string {
  const style = badgeKindStyle(kind);
  const label = kind === "unknown" && rawSource !== undefined ? sourceLabel(rawSource) : style.label;
  return `<span class="evt-badge evt-k-${kind}" style="background:${style.bg};color:${style.fg}" title="${esc(style.description)}">${esc(label)}</span>`;
}

function borderStyle(kind: BadgeKind): string {
  return `border-left-color:${badgeKindStyle(kind).bg}`;
}

function factHead(node: ExpandedNode): string {
  const fact = node.fact;
  return (
    `${badge(normaliseSource(node.source), node.source)} ` +
    `${tripleHtml(fact?.subject?.value, fact?.relationship?.type, fact?.object?.value, fact?.object?.dataType)} ` +
    `<span class="evt-cf" title="${esc(`Fact ID ${node.factID}`)}">${fmtPct(fact?.certainty)}</span>`
  );
}

function tripleHtml(subject: unknown, relationship: unknown, object: unknown, objectType?: string): string {
  return (
    `<span class="evt-triple"><b>${esc(subject ?? "?")}</b> <span class="evt-rel">${esc(relationship ?? "?")}</span> ` +
    `<b>${esc(formatValue(object, objectType))}</b></span>`
  );
}

/** "call = result (n facts)". `ruleText` is the expression as written, shown as a tooltip when it differs from the evaluated call. */
function callHtml([call, fn]: [string, ExpandedFunctionCall], ruleText?: string): string {
  const count = factsOf(fn).length;
  const squash = (s: string) => s.replace(/\s+/g, "");
  const title = ruleText && squash(ruleText) !== squash(call) ? ` title="${esc(`In the rule: ${ruleText}`)}"` : "";
  const value = fn.result?.value;
  const result = value === undefined || value === null ? `<span class="evt-none">no value</span>` : `<b>${esc(formatValue(value, fn.result?.type))}</b>`;
  return `<code${title}>${esc(call)}</code> = ${result} <span class="evt-count">(${plural(count, "fact")})</span>`;
}

function resultText(fn: ExpandedFunctionCall): string {
  const value = fn.result?.value;
  return value === undefined || value === null ? "no value" : formatValue(value, fn.result?.type);
}

/**
 * True when the expression is nothing but this list-function call, as in
 * "sumObjects(%S, 'has income', *)" stored in %O. The function key is the call
 * as evaluated ("sumObjects( 'Tom', 'has income', *)"), so the two texts differ
 * in their arguments; the row then shows the evaluated call and its result.
 */
function isJustTheCall(call: string, text: string): boolean {
  const squash = (s: string) => s.replace(/\s+/g, "");
  const t = squash(text);
  const c = squash(call);
  if (!t || t === c) return true;
  const name = /^[A-Za-z_]\w*(?=\()/.exec(c)?.[0];
  if (!name || !t.startsWith(`${name}(`)) return false;
  // The call's closing parenthesis must end the text: not "sumObjects(…) > 120".
  let depth = 0;
  let quote = "";
  for (let i = name.length; i < t.length; i++) {
    const ch = t[i];
    if (quote) {
      if (ch === quote) quote = "";
    } else if (ch === "'" || ch === '"') {
      quote = ch;
    } else if (ch === "(") {
      depth++;
    } else if (ch === ")" && --depth === 0) {
      return i === t.length - 1;
    }
  }
  return false;
}

/** Expression text with its %VARIABLES replaced by their values, as Studio shows it. */
function fillVariables(text: string, bindings: EvidenceRule["bindings"]): string {
  if (!bindings || typeof bindings !== "object") return text;
  return text.replace(/%([A-Za-z0-9_]+)/g, (whole: string, name: string) =>
    Object.prototype.hasOwnProperty.call(bindings, name) ? bindingText(bindings[name]) : whole
  );
}

function metMark(wasMet: unknown): string {
  if (wasMet === true) return ` <span class="evt-met" title="The expression was true">✓</span>`;
  if (wasMet === false) return ` <span class="evt-met evt-false" title="The expression was false">✗</span>`;
  return "";
}

function impactHtml(
  rule: EvidenceRule | undefined,
  condition: ExpandedCondition,
  unmet: boolean,
  zero: boolean,
  scale: ImpactScale | undefined
): string {
  if (zero) return `<span class="evt-impact" title="Weight 0: no effect on the certainty"><span class="evt-pct">weight 0</span></span>`;
  const impact = unmet ? 0 : finite(condition.impact);
  const max = maxImpact(rule, condition, scale);
  if (impact === undefined && max === undefined) return `<span class="evt-impact"><span class="evt-pct">–</span></span>`;
  const parts = [`Impact ${impact === undefined ? "unknown" : `${fmtNum(impact)}%`}`];
  if (max !== undefined) parts.push(`of a possible ${fmtNum(max)}%`);
  if (typeof condition.salience === "number") parts.push(`(weight ${fmtNum(condition.salience)})`);
  // The reported weights did not account for the impacts (the engine counted a condition it left
  // out of the payload), so the maximum was worked out from the impacts themselves.
  if (max !== undefined && scale?.fromImpacts) parts.push("· the maximum is approximate, worked out from the reported impacts");
  const width = (n: number) => fmtNum(Math.max(0, Math.min(100, n)));
  return (
    `<span class="evt-impact" title="${esc(parts.join(" "))}"><span class="evt-bar" aria-hidden="true">` +
    (max !== undefined ? `<span class="evt-bar-max" style="width:${width(max)}%"></span>` : "") +
    (impact !== undefined ? `<span class="evt-bar-val" style="width:${width(impact)}%"></span>` : "") +
    `</span><span class="evt-pct">${fmtPct(impact)}</span></span>`
  );
}

function impactText(rule: EvidenceRule, condition: ExpandedCondition, scale: ImpactScale | undefined): string {
  if (condition.salience === 0) return "";
  const impact = isUnmet(condition) ? 0 : finite(condition.impact);
  const max = maxImpact(rule, condition, scale);
  if (impact === undefined && max === undefined) return "";
  const possible = max !== undefined ? ` of a possible ${fmtPct(max)}${scale?.fromImpacts ? " (approximate)" : ""}` : "";
  return ` · impact ${fmtPct(impact)}${possible}${typeof condition.salience === "number" ? ` (weight ${fmtNum(condition.salience)})` : ""}`;
}

function bindingsHtml(bindings: EvidenceRule["bindings"]): string {
  const entries = Object.entries(bindings && typeof bindings === "object" ? bindings : {});
  if (!entries.length) return "";
  const chips = entries.map(([name, value]) => `<span class="evt-var">${esc(name.startsWith("%") ? name : `%${name}`)} = ${esc(bindingText(value))}</span>`);
  return `<div class="evt-vars">Variables ${chips.join("")}</div>`;
}

function toolbarHtml(factId: string, toolbar: RenderOptions["toolbar"]): string {
  const fact = esc(factId);
  const buttons = [
    `<button type="button" data-evt-act="expand">Expand all</button>`,
    `<button type="button" data-evt-act="collapse">Collapse all</button>`,
    `<span class="evt-sp"></span>`,
  ];
  if (toolbar?.studio) {
    buttons.push(
      `<button type="button" data-evt-act="openStudio" data-fact="${fact}" title="Open this evidence tree in Rainbird Studio. Works while the session is live and the map's Evidence Tree Link is enabled (Publish → API Management → Access Control).">Open in Studio</button>`
    );
  }
  if (toolbar?.copyLink) {
    buttons.push(
      `<button type="button" data-evt-act="copyLink" data-fact="${fact}" title="Copy a Studio link to this evidence tree to share. Needs the map's Evidence Tree Link enabled; sessions expire, so share it soon.">Copy link</button>`
    );
  }
  if (toolbar?.openPanel) {
    buttons.push(`<button type="button" data-evt-act="openPanel" data-fact="${fact}" title="Open this tree in its own editor tab">Open in panel</button>`);
  }
  return `<div class="evt-toolbar" role="toolbar" aria-label="Evidence tree">${buttons.join("")}</div>`;
}

function legendHtml(kinds: Set<BadgeKind>): string {
  const shown = LEGEND_ORDER.filter((kind) => kinds.has(kind));
  if (!shown.length) return "";
  const items = shown.map((kind) => `${badge(kind)}<span class="evt-sr">${esc(SOURCE_STYLE[kind].description)}</span>`);
  return `<div class="evt-legend"><span class="evt-legend-title">Sources:</span>${items.join(" ")}</div>`;
}

function inputsHtml(inputs: LeafFact[]): string {
  const sorted = sortInputs(inputs);
  const counts = INPUT_ORDER.map((kind) => [kind, inputs.filter((f) => f.kind === kind).length] as const)
    .filter(([, n]) => n > 0)
    .map(([kind, n]) => `${n} ${COUNT_LABELS[kind]}`);
  const rows = sorted
    .map(
      (fact) =>
        `<tr><td>${badge(fact.kind, fact.source)}</td><td>${tripleHtml(fact.subject, fact.relationship, fact.object, fact.objectType)}</td><td class="evt-cf">${fmtPct(fact.certainty)}</td></tr>`
    )
    .join("");
  const body = inputs.length
    ? `<div class="evt-inputs-sum">${esc(counts.join(" · "))}</div><table><thead><tr><th>Source</th><th>Fact</th><th>Certainty</th></tr></thead><tbody>${rows}</tbody></table>`
    : `<div class="evt-inputs-sum">No input facts: the result rests on rules and expressions only.</div>`;
  return `<details class="evt-inputs" open><summary>Inputs used by this result (${inputs.length})</summary>${body}</details>`;
}

function footnotes(meta: EvidenceMeta | undefined, studio: boolean): string {
  if (!meta) return "";
  const notes: string[] = [];
  if (meta.truncated) {
    notes.push(
      `This tree was cut short after ${plural(meta.nodes, "fact")} to keep it fast; rows marked "Not loaded" were not fetched.${studio ? " Open in Studio shows the complete tree." : ""}`
    );
  }
  if (meta.errors) notes.push(`${plural(meta.errors, "fact")} could not be loaded; the affected rows say why.`);
  return notes.map((text) => `<div class="evt-foot">${esc(text)}</div>`).join("");
}

/** A short note under a row. `html` is trusted markup: escape anything dynamic before passing it in. */
function note(html: string, extra = ""): string {
  return `<div class="evt-note${extra ? ` ${extra}` : ""}">${html}</div>`;
}

function gotoButton(id: string | undefined): string {
  return id ? ` <button type="button" class="evt-link" data-evt-goto="${esc(id)}">Go to it</button>` : "";
}

function expandable(ref: ExpandedCondition | ExpandedFunctionFact): boolean {
  const support = ref.evidence;
  return !!support && !ref.repeat && !ref.cyclic && !support.repeat && !support.cyclic && normaliseSource(support.source) === "rule";
}

function refText(ref: ExpandedCondition | ExpandedFunctionFact): string {
  if (ref.fetchError) return ` (could not load: ${shorten(ref.fetchError, 160)})`;
  if (ref.truncated) return " (not loaded: tree size limit)";
  if (ref.cyclic) return " (depends on a fact further up this branch; not expanded again)";
  if (ref.repeat && ref.evidence && normaliseSource(ref.evidence.source) === "rule") return " (same rule-derived fact as elsewhere in this outline; not repeated)";
  return "";
}

function sortInputs(inputs: LeafFact[]): LeafFact[] {
  const rank = (fact: LeafFact) => {
    const i = INPUT_ORDER.indexOf(fact.kind);
    return i < 0 ? INPUT_ORDER.length : i;
  };
  return inputs.map((fact, i) => ({ fact, i })).sort((a, b) => rank(a.fact) - rank(b.fact) || a.i - b.i).map((x) => x.fact);
}

function textSource(source: unknown): string {
  switch (normaliseSource(source)) {
    case "rule":
      return "inferred by a rule";
    case "answer":
      return "answered by the user";
    case "injection":
      return "injected";
    case "datasource":
      return "from a datasource";
    case "knowledgemap":
      return "built into the map";
    case "synthesis":
      return "synthesised 0% placeholder: optional condition not met";
    default:
      return sourceLabel(source);
  }
}

function finite(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function fmtNum(value: number): string {
  const rounded = Math.round(value * 100) / 100;
  return String(Object.is(rounded, -0) ? 0 : rounded);
}

function fmtPct(value: unknown): string {
  const n = finite(value);
  return n === undefined ? "–" : `${fmtNum(n)}%`;
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

function shorten(text: string, max: number): string {
  const flat = String(text).replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}
