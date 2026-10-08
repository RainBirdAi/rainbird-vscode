/**
 * The evidence model every evidence surface reads: the query panel's inline
 * tree, the standalone evidence view, the graph overlay, the promotion diff and
 * the assistant's get_evidence tool.
 *
 * GET /analysis/evidence returns one node per call. expandEvidence() follows
 * the factIDs it names and attaches each fetched node to the reference that
 * named it, so a condition carries the fact that satisfied it (`evidence`) and a
 * list-function fact carries its own node. Nothing here imports vscode, so the
 * model is unit-tested in Node (src/test/evidenceModel.test.ts).
 *
 * Fetching is breadth-first, one level at a time. Within a level the node
 * budget is reserved synchronously in declared order (relationship conditions
 * first, then list-function facts) before any GET starts, so the same session
 * always expands to the same tree whatever order the responses arrive in. That
 * matters to the promotion diff, which compares two trees fetched in parallel.
 *
 * The payload rules below come from the engine itself (ruleEvidenceBuilder,
 * inferRule and factSynthesizer in the Rainbird engine) and from the public
 * sandbox: an unmet optional condition carries the never-stored factID "WA:XX",
 * typed rule variables arrive as {value, type}, and impacts are shares of the
 * total weight of all the rule's conditions.
 */
import type {
  EvidenceBinding,
  EvidenceCondition,
  EvidenceExpression,
  EvidenceFunctionCall,
  EvidenceFunctionFact,
  EvidenceNode,
  EvidenceRule,
} from "./api";

/** Flags shared by the two kinds of reference that can point at another fact. */
export interface EvidenceRefState {
  /**
   * The node behind this reference. For `repeat` and `cyclic` references it is
   * a header-only copy (factID, source, time, fact; no `rule`) flagged the same
   * way, so the tree stays a tree and serialises without duplicated subtrees.
   * For an unmet optional condition ("WA:XX") it is a synthesis node built from
   * the condition itself: the engine never stores those facts, so they are not
   * fetched.
   */
  evidence?: ExpandedNode;
  /** The GET for this factID failed; the message says why. */
  fetchError?: string;
  /** Not fetched: the node budget (maxNodes) or the depth limit (maxDepth) was reached. */
  truncated?: boolean;
  /** The factID is already on this branch (a rule that depends on itself); not expanded again. */
  cyclic?: boolean;
  /** The factID is expanded elsewhere in this tree (its first occurrence, breadth-first). */
  repeat?: boolean;
}

export interface ExpandedFunctionFact extends EvidenceFunctionFact, EvidenceRefState {}

export interface ExpandedFunctionCall extends EvidenceFunctionCall {
  facts?: ExpandedFunctionFact[];
}

export interface ExpandedExpression extends EvidenceExpression {
  functions?: Record<string, ExpandedFunctionCall>;
}

export interface ExpandedCondition extends EvidenceCondition, EvidenceRefState {
  expression?: ExpandedExpression;
}

export interface ExpandedRule extends EvidenceRule {
  conditions?: ExpandedCondition[];
}

export interface ExpandedNode extends EvidenceNode {
  rule?: ExpandedRule;
  /** Header-only copy standing for a fact expanded elsewhere in the tree. */
  repeat?: boolean;
  /** Header-only copy standing for a fact further up the same branch. */
  cyclic?: boolean;
}

export interface EvidenceMeta {
  /**
   * Nodes loaded, the root included. Failed GETs (counted in `errors`) and the
   * synthesis nodes built locally for unmet optional conditions are not counted.
   */
  nodes: number;
  /** Some references were not fetched because a limit was reached. */
  truncated: boolean;
  /** Child GETs that failed (each failing reference carries `fetchError`). */
  errors: number;
}

/** The expanded root: an ExpandedNode with `meta`. */
export interface ExpandedEvidence extends ExpandedNode {
  meta: EvidenceMeta;
}

export interface ExpandOptions {
  /** Most GETs to make, the root included (default 200). Failed GETs count. */
  maxNodes?: number;
  /** Deepest level to fetch; the root is level 0 (default 10, as before 0.0.14). */
  maxDepth?: number;
  /** Most GETs in flight at once (default 6). */
  concurrency?: number;
}

export const EXPAND_DEFAULTS = { maxNodes: 200, maxDepth: 10, concurrency: 6 } as const;

/** The normalised source of a fact. "km" and "knowledgemap" are one kind. */
export type SourceKind = "rule" | "answer" | "injection" | "datasource" | "knowledgemap" | "synthesis" | "unknown";

type Ref = ExpandedCondition | ExpandedFunctionFact;

interface Slot {
  node?: ExpandedNode;
  error?: string;
}

interface Pending {
  node: ExpandedNode;
  depth: number;
  /** factIDs from the root down to this node, itself included. */
  ancestors: Set<string>;
}

/**
 * Fetch `rootFactId` and everything its conditions and list functions point
 * at, up to the limits. The root GET's error is rethrown unchanged (so callers
 * can test `error instanceof ApiError && error.status === 403`); every later
 * failure is recorded on the reference that needed it and counted in
 * `meta.errors`. Synthesis placeholders ("WA:XX") are never requested.
 */
export async function expandEvidence(
  fetch: (factId: string) => Promise<EvidenceNode>,
  rootFactId: string,
  opts: ExpandOptions = {}
): Promise<ExpandedEvidence> {
  const maxNodes = Math.max(1, Math.floor(opts.maxNodes ?? EXPAND_DEFAULTS.maxNodes));
  const maxDepth = Math.max(0, Math.floor(opts.maxDepth ?? EXPAND_DEFAULTS.maxDepth));
  const concurrency = Math.max(1, Math.floor(opts.concurrency ?? EXPAND_DEFAULTS.concurrency));
  const meta: EvidenceMeta = { nodes: 1, truncated: false, errors: 0 };
  let requested = 1; // GETs reserved, the root included: what maxNodes limits

  const root = toExpanded(await fetch(rootFactId), rootFactId) as ExpandedEvidence;
  root.meta = meta;

  // factID → the node fetched for it. Claimed synchronously, filled once its GET settles.
  // The root is known by the ID asked for and the ID it reports (normally the same).
  const rootSlot: Slot = { node: root };
  const slots = new Map<string, Slot>([
    [rootFactId, rootSlot],
    [root.factID, rootSlot],
  ]);
  let level: Pending[] = [{ node: root, depth: 0, ancestors: new Set([rootFactId, root.factID]) }];

  while (level.length) {
    const jobs: { ref: Ref; id: string; slot: Slot; from: Pending }[] = [];
    const repeats: { ref: Ref; id: string }[] = [];

    const reserve = (ref: Ref, from: Pending) => {
      const id = typeof ref.factID === "string" ? ref.factID.trim() : "";
      if (!id) return;
      // An unmet optional condition: the engine's 0% stand-in is never stored, so
      // GET would 404. Studio does not fetch it either; build it from the reference.
      if (isSynthesisFactId(id)) {
        ref.evidence = synthesisNode(ref, id);
        return;
      }
      // The ancestor check comes before the memo: A → B → A is a cycle, not a repeat.
      if (from.ancestors.has(id)) {
        ref.cyclic = true;
        const ancestor = slots.get(id)?.node;
        if (ancestor) ref.evidence = headerCopy(ancestor, "cyclic");
        return;
      }
      if (slots.has(id)) {
        repeats.push({ ref, id });
        return;
      }
      if (from.depth + 1 > maxDepth || requested >= maxNodes) {
        ref.truncated = true;
        meta.truncated = true;
        return;
      }
      const slot: Slot = {};
      slots.set(id, slot);
      requested++;
      jobs.push({ ref, id, slot, from });
    };

    // Relationship conditions claim the budget before list-function inputs.
    for (const pending of level) {
      for (const condition of conditionsOf(pending.node)) if (!condition.expression) reserve(condition, pending);
    }
    for (const pending of level) {
      for (const condition of conditionsOf(pending.node)) {
        for (const fact of functionFactsOf(condition)) reserve(fact, pending);
      }
    }

    await forEachLimited(jobs, concurrency, async (job) => {
      try {
        job.slot.node = toExpanded(await fetch(job.id), job.id);
        meta.nodes++;
      } catch (error) {
        job.slot.error = errorText(error);
        meta.errors++;
      }
    });

    const next: Pending[] = [];
    for (const job of jobs) {
      if (job.slot.node) {
        job.ref.evidence = job.slot.node;
        next.push({ node: job.slot.node, depth: job.from.depth + 1, ancestors: new Set([...job.from.ancestors, job.id]) });
      } else {
        job.ref.fetchError = job.slot.error ?? "Unknown error";
      }
    }
    for (const { ref, id } of repeats) {
      const slot = slots.get(id);
      if (slot?.node) {
        ref.repeat = true;
        ref.evidence = headerCopy(slot.node, "repeat");
      } else {
        ref.fetchError = slot?.error ?? "Unknown error";
      }
    }
    level = next;
  }
  return root;
}

/**
 * Visit every node depth-first in document order: a node, then, for each of
 * its conditions in order, the node behind it (relationship conditions) or the
 * nodes behind each list-function fact (expressions). Return `false` from
 * `visit` to skip a node's descendants. Header-only copies (repeat / cyclic)
 * and synthesis nodes are visited but have nothing below them.
 */
export function walkEvidence(
  tree: ExpandedNode | undefined | null,
  visit: (node: ExpandedNode, context: WalkContext) => void | boolean
): void {
  if (!tree || typeof tree !== "object") return;
  const seen = new Set<ExpandedNode>();
  const walk = (node: ExpandedNode, context: WalkContext) => {
    if (seen.has(node)) return; // defensive: hand-built trees might share or loop
    seen.add(node);
    if (visit(node, context) === false) return;
    for (const condition of conditionsOf(node)) {
      if (condition.expression) {
        for (const fact of functionFactsOf(condition)) {
          if (fact.evidence) walk(fact.evidence, { depth: context.depth + 1, parent: node, via: fact, condition });
        }
      } else if (condition.evidence) {
        walk(condition.evidence, { depth: context.depth + 1, parent: node, via: condition, condition });
      }
    }
  };
  walk(tree, { depth: 0 });
}

export interface WalkContext {
  /** 0 for the root. */
  depth: number;
  /** The rule node whose condition led here. */
  parent?: ExpandedNode;
  /** The condition or list-function fact that led here. */
  via?: ExpandedCondition | ExpandedFunctionFact;
  /** The condition that led here (for a list-function fact, the expression holding it). */
  condition?: ExpandedCondition;
}

/** One input fact behind a result, as listed under "Inputs used by this result". */
export interface LeafFact {
  subject: string;
  relationship: string;
  object: string | number | boolean;
  certainty?: number;
  /** Normalised source; "unknown" when the fact's own node could not be loaded. */
  kind: SourceKind;
  /** The source string the API sent (e.g. "km"), when the node was loaded. */
  source?: string;
  factID?: string;
  /** The value's data type (string, number, date, truth), when known. */
  objectType?: string;
}

/**
 * Every non-rule input fact behind the tree: answers, injected facts,
 * datasource facts and knowledge-map facts, including the facts list functions
 * read (from the inline triple, because one factID can stand for several values
 * of a plural answer), also when their expression turned out false. Synthesis
 * placeholders are excluded: an unmet optional condition had no fact. A fact
 * that could not be loaded is listed as kind "unknown" unless the same triple
 * is known from elsewhere. Deduplicated by triple and kind, in document order.
 */
export function leafFacts(tree: ExpandedNode | undefined | null): LeafFact[] {
  const out: LeafFact[] = [];
  const seen = new Set<string>();
  const add = (fact: LeafFact) => {
    const key = `${tripleKey(fact.subject, fact.relationship, fact.object)}\u0001${fact.kind}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(fact);
  };
  const visited = new Set<ExpandedNode>();
  // Document order: a node, then its conditions in order (list-function facts where they are used).
  const visit = (node: ExpandedNode) => {
    if (visited.has(node)) return;
    visited.add(node);
    const kind = normaliseSource(node.source);
    if (kind !== "rule" && kind !== "synthesis" && node.fact) {
      add({
        subject: String(node.fact.subject?.value ?? ""),
        relationship: String(node.fact.relationship?.type ?? ""),
        object: node.fact.object?.value ?? "",
        certainty: node.fact.certainty,
        kind,
        source: node.source,
        factID: node.factID,
        // Only the data type: fact.object.type is the concept name ("language"), not a type.
        objectType: node.fact.object?.dataType,
      });
    }
    for (const condition of conditionsOf(node)) {
      if (condition.expression) {
        for (const fact of functionFactsOf(condition)) {
          if (isSynthesisFactId(fact.factID)) continue;
          const factKind = fact.evidence ? normaliseSource(fact.evidence.source) : "unknown";
          if (factKind === "synthesis") continue;
          if (factKind === "rule") {
            visit(fact.evidence as ExpandedNode); // a rule's own inputs
            continue;
          }
          add({
            subject: String(fact.subject ?? ""),
            relationship: String(fact.relationship ?? ""),
            object: fact.object ?? "",
            certainty: fact.certainty ?? fact.evidence?.fact?.certainty,
            kind: factKind,
            source: fact.evidence?.source,
            factID: fact.factID,
            objectType: fact.objectType,
          });
        }
      } else if (condition.evidence) {
        visit(condition.evidence);
      } else if (condition.factID && !isUnmet(condition)) {
        // Named but not loaded (budget, depth or a failed GET): still an input we know of.
        add({
          subject: String(condition.subject ?? ""),
          relationship: String(condition.relationship ?? ""),
          object: condition.object ?? "",
          certainty: condition.certainty,
          kind: "unknown",
          factID: condition.factID,
          objectType: condition.objectType,
        });
      }
    }
  };
  if (tree && typeof tree === "object") visit(tree);
  const known = new Set(out.filter((f) => f.kind !== "unknown").map((f) => tripleKey(f.subject, f.relationship, f.object)));
  return out.filter((f) => f.kind !== "unknown" || !known.has(tripleKey(f.subject, f.relationship, f.object)));
}

/**
 * True for an unmet condition and for a synthesis node. A condition is unmet
 * when `wasMet` is false (expressions: the engine sets wasMet only on them), or
 * when it rests on a synthesis placeholder: the engine's 0% stand-in for an
 * optional relationship condition that was not met, factID "WA:XX".
 */
export function isUnmet(item: EvidenceCondition | ExpandedCondition | EvidenceNode | ExpandedNode | undefined | null): boolean {
  if (!item || typeof item !== "object") return false;
  if ("source" in item) return normaliseSource(item.source) === "synthesis";
  const condition = item as ExpandedCondition;
  if (condition.wasMet === false) return true;
  if (isSynthesisFactId(condition.factID)) return true;
  return condition.evidence ? normaliseSource(condition.evidence.source) === "synthesis" : false;
}

/**
 * True for the factID of a synthesised placeholder fact. The engine gives an
 * unmet optional condition's 0% fact the literal ID "WA:XX" and never stores it
 * (GET /analysis/evidence answers 404); facts synthesised for an unbound side
 * get "WA:XX:<hash>". Studio does not fetch either.
 */
export function isSynthesisFactId(factId: unknown): boolean {
  return typeof factId === "string" && /^[^:\s]+:XX(?::|$)/i.test(factId.trim());
}

/**
 * Fill {{%VAR}} (or {{VAR}}) placeholders in evidence text from the rule's
 * bindings. The engine normally sends the text already filled in, so this is
 * usually a no-op. Typed bindings ({value, type}) are unwrapped and dates shown
 * as YYYY-MM-DD; unknown or empty variables and dot traversals such as
 * {{%COUNTRY.is in continent}} are left as written.
 */
export function substituteAlt(alt: string | undefined | null, bindings?: Record<string, unknown> | null): string {
  const text = typeof alt === "string" ? alt : "";
  if (!bindings || typeof bindings !== "object") return text;
  return text.replace(/\{\{\s*%?([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g, (whole: string, name: string) => {
    const raw = lookupBinding(bindings, name);
    const { value, type } = bindingValue(raw);
    return typeof value === "string" || typeof value === "number" || typeof value === "boolean" ? formatValue(value, type) : whole;
  });
}

/**
 * A rule variable as the engine sends it: a plain value, or {value, type} for
 * a typed variable (numbers, dates and truths computed by expressions and list
 * functions, dates bound by relationship conditions). Returns the bare value
 * and its type.
 */
export function bindingValue(binding: EvidenceBinding | unknown): { value: unknown; type?: string } {
  if (binding && typeof binding === "object" && !Array.isArray(binding)) {
    const typed = binding as { value?: unknown; type?: unknown };
    return { value: typed.value, type: typeof typed.type === "string" ? typed.type : undefined };
  }
  return { value: binding };
}

/** A rule variable's value as text: dates as YYYY-MM-DD, no value as "–". */
export function bindingText(binding: EvidenceBinding | unknown): string {
  const { value, type } = bindingValue(binding);
  return value === undefined || value === null ? "–" : formatValue(value, type);
}

/**
 * A value from the evidence payload as text. `type` is a data type (string,
 * number, date, truth; list-function results also say boolean), never a concept
 * name: dates arrive as epoch milliseconds and are shown as YYYY-MM-DD in UTC,
 * as the engine formats them. A missing value is "?".
 */
export function formatValue(value: unknown, type?: string): string {
  if (value === undefined || value === null) return "?";
  if (Array.isArray(value)) return value.map((item) => formatValue(item, type)).join(", ");
  if (typeof type === "string" && /^date$/i.test(type.trim())) {
    const n = typeof value === "number" ? value : typeof value === "string" && /^-?\d+$/.test(value.trim()) ? Number(value) : NaN;
    if (Number.isFinite(n)) {
      const date = new Date(n);
      if (!Number.isNaN(date.getTime())) return date.toISOString().slice(0, 10);
    }
  }
  return typeof value === "object" ? JSON.stringify(value) : String(value);
}

/** Map an API source string to one kind; "km" and "knowledgemap" are both the knowledge map. */
export function normaliseSource(source: unknown): SourceKind {
  const s = String(source ?? "").toLowerCase().replace(/[^a-z]/g, "");
  switch (s) {
    case "rule":
      return "rule";
    case "answer":
    case "answered":
      return "answer";
    case "injection":
    case "injected":
    case "inject":
      return "injection";
    case "datasource":
      return "datasource";
    case "km":
    case "knowledgemap":
      return "knowledgemap";
    case "synthesis":
    case "synthetic":
    case "synthesised":
    case "synthesized":
      return "synthesis";
    default:
      return "unknown";
  }
}

/** Display names, in Rainbird Studio's vocabulary. */
export const SOURCE_LABELS: Record<SourceKind, string> = {
  rule: "rule",
  answer: "answer",
  injection: "injected",
  datasource: "datasource",
  knowledgemap: "knowledge map",
  synthesis: "not met",
  unknown: "fact",
};

/** Short label for a source as the API sent it ("km" → "knowledge map"); an unrecognised string is shown as sent. */
export function sourceLabel(source: unknown): string {
  const kind = normaliseSource(source);
  if (kind !== "unknown") return SOURCE_LABELS[kind];
  const raw = typeof source === "string" ? source.trim() : "";
  return raw || SOURCE_LABELS.unknown;
}

/** How a rule's conditions share its certainty: what a condition's maximum possible impact is measured against. */
export interface ImpactScale {
  /** The rule's certainty cap: ruleMaxCertainty, or 100 when the payload has none. */
  cap: number;
  /** The total weight the engine divided by. */
  total: number;
  /**
   * True when `total` was worked out from the reported impacts because the
   * reported weights do not account for them. The engine still counts an
   * optional condition it skipped (one whose object was never bound) but leaves
   * it out of the payload. Accurate to the impacts' two decimals.
   */
  fromImpacts: boolean;
}

/**
 * The engine's formula (ruleEvidenceBuilder, verified on the sandbox): impact =
 * weight ÷ total weight × certainty × ruleMaxCertainty ÷ 100, rounded to two
 * decimals, where the total runs over ALL the rule's conditions, expressions
 * included, and a met expression counts as certainty 100 (an unmet one as 0).
 * The reported weights make up the total unless the reported impacts say
 * otherwise; then the total is worked out from the largest impact.
 */
export function impactScale(rule: EvidenceRule | undefined | null): ImpactScale | undefined {
  if (!rule || typeof rule !== "object") return undefined;
  const conditions = (Array.isArray(rule.conditions) ? rule.conditions : []).filter(
    (c): c is EvidenceCondition => !!c && typeof c === "object"
  );
  const cap = finiteNumber(rule.ruleMaxCertainty) ?? 100;
  const reported = conditions.reduce((sum, c) => sum + weightOf(c), 0);
  // Conditions whose impact can check a total: positive impact, weight and certainty.
  const probes = conditions.filter((c) => (finiteNumber(c.impact) ?? 0) > 0 && weightOf(c) > 0 && impactCertainty(c) > 0);
  const explains = (total: number) =>
    probes.every((c) => Math.abs(round2(((weightOf(c) / total) * impactCertainty(c) * cap) / 100) - (c.impact as number)) <= 0.011);
  if (reported > 0 && explains(reported)) return { cap, total: reported, fromImpacts: false };
  if (!probes.length) return reported > 0 ? { cap, total: reported, fromImpacts: false } : undefined;
  // The largest impact carries the smallest rounding error.
  const best = probes.reduce((a, b) => ((b.impact as number) > (a.impact as number) ? b : a));
  return { cap, total: (weightOf(best) * impactCertainty(best) * cap) / (100 * (best.impact as number)), fromImpacts: true };
}

/**
 * A condition's maximum possible impact: ruleMaxCertainty × weight ÷ the
 * rule's total weight (see impactScale), the impact the condition would have
 * had at certainty 100. Live: cap 75 and weights 100/100 give 37.5 each, and a
 * 90% fact then has impact 33.75. Weight 0 gives 0; a missing weight counts as
 * RBLang's default, 100. Pass `scale` when drawing several rows of one rule.
 */
export function maxImpact(
  rule: EvidenceRule | undefined | null,
  condition: EvidenceCondition,
  scale: ImpactScale | undefined = impactScale(rule)
): number | undefined {
  if (!rule || !condition || typeof condition !== "object") return undefined;
  const weight = weightOf(condition);
  if (weight === 0) return 0;
  if (!scale || !(scale.total > 0)) return undefined;
  return Math.min(scale.cap, (scale.cap * weight) / scale.total);
}

/** What the graph overlay highlights for one result: relationships (with their highest certainty) and instances. */
export interface EvidenceOverlayData {
  rels: { name: string; certainty: number }[];
  instances: string[];
}

/**
 * Relationships and instances that appear anywhere in the tree, including the
 * facts list functions used (the logic QueryPanel.overlay() had inline). Values
 * 0 and false are instances too; condition ends that are still variables
 * (%COUNTRY) are not, and an optional relationship condition that was not met
 * (a 0% synthesis placeholder: no fact was found) adds nothing.
 */
export function overlayFromEvidence(tree: ExpandedNode | undefined | null): EvidenceOverlayData {
  const rels = new Map<string, number>();
  const instances = new Set<string>();
  const addRel = (name: unknown, certainty: unknown) => {
    if (typeof name !== "string" || !name) return;
    const value = typeof certainty === "number" && Number.isFinite(certainty) ? certainty : 0;
    rels.set(name, Math.max(rels.get(name) ?? 0, value));
  };
  const addInstance = (value: unknown, allowVariables = false) => {
    if (value === undefined || value === null || typeof value === "object") return;
    const text = String(value);
    if (!text || (!allowVariables && text.startsWith("%"))) return;
    instances.add(text);
  };
  walkEvidence(tree, (node) => {
    // A synthesis node is a 0% placeholder for an unmet condition, not a fact to highlight.
    if (node.fact && normaliseSource(node.source) !== "synthesis") {
      addRel(node.fact.relationship?.type, node.fact.certainty);
      addInstance(node.fact.subject?.value, true);
      addInstance(node.fact.object?.value, true);
    }
    for (const condition of conditionsOf(node)) {
      if (!condition.expression && isUnmet(condition)) continue;
      if (condition.relationship) addRel(condition.relationship, condition.certainty);
      addInstance(condition.subject);
      addInstance(condition.object);
      for (const fact of functionFactsOf(condition)) {
        if (isSynthesisFactId(fact.factID)) continue;
        addRel(fact.relationship, fact.certainty);
        addInstance(fact.subject);
        addInstance(fact.object);
      }
    }
  });
  return { rels: [...rels.entries()].map(([name, certainty]) => ({ name, certainty })), instances: [...instances] };
}

/** The list-function calls of an expression condition, in payload order. */
export function functionCallsOf(condition: ExpandedCondition | EvidenceCondition | undefined): [string, ExpandedFunctionCall][] {
  const functions = condition?.expression?.functions;
  if (!functions || typeof functions !== "object") return [];
  return Object.entries(functions).filter((entry): entry is [string, ExpandedFunctionCall] => !!entry[1] && typeof entry[1] === "object");
}

/** Stable key for a fact triple. */
export function tripleKey(subject: unknown, relationship: unknown, object: unknown): string {
  return `${String(subject ?? "")} ${String(relationship ?? "")} ${String(object ?? "")}`;
}

// ── internals ──

function conditionsOf(node: ExpandedNode): ExpandedCondition[] {
  const conditions = node.rule?.conditions;
  return Array.isArray(conditions) ? conditions.filter((c): c is ExpandedCondition => !!c && typeof c === "object") : [];
}

function functionFactsOf(condition: ExpandedCondition): ExpandedFunctionFact[] {
  const facts: ExpandedFunctionFact[] = [];
  for (const [, call] of functionCallsOf(condition)) {
    if (Array.isArray(call.facts)) facts.push(...call.facts.filter((f): f is ExpandedFunctionFact => !!f && typeof f === "object"));
  }
  return facts;
}

function lookupBinding(bindings: Record<string, unknown>, name: string): unknown {
  for (const key of [name, `%${name}`, name.toUpperCase()]) {
    if (Object.prototype.hasOwnProperty.call(bindings, key) && bindings[key] !== undefined) return bindings[key];
  }
  return undefined;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** A condition's weight (salience); RBLang's default is 100. */
function weightOf(condition: EvidenceCondition): number {
  const weight = finiteNumber(condition.salience);
  return weight === undefined ? 100 : Math.max(0, weight);
}

/** The certainty the engine multiplied by: the fact's for a relationship condition, 100 or 0 for an expression. */
function impactCertainty(condition: EvidenceCondition): number {
  if (condition.expression) return condition.wasMet === false ? 0 : 100;
  return finiteNumber(condition.certainty) ?? 100;
}

/** The engine's rounding: two decimals. */
function round2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

/** Copy a fetched node so flags and attached evidence never write into the caller's objects. */
function toExpanded(raw: EvidenceNode, requestedId: string): ExpandedNode {
  const source = (raw && typeof raw === "object" ? raw : {}) as EvidenceNode;
  const node: ExpandedNode = { ...source };
  if (typeof node.factID !== "string" || !node.factID) node.factID = requestedId;
  if (source.rule && typeof source.rule === "object") {
    node.rule = { ...source.rule };
    if (Array.isArray(source.rule.conditions)) {
      node.rule.conditions = source.rule.conditions.map((c) => (c && typeof c === "object" ? copyCondition(c) : c));
    }
  }
  return node;
}

function copyCondition(condition: EvidenceCondition): ExpandedCondition {
  const copy: ExpandedCondition = { ...condition };
  const expression = condition.expression;
  if (expression && typeof expression === "object") {
    copy.expression = { ...expression };
    if (expression.functions && typeof expression.functions === "object") {
      const functions: Record<string, ExpandedFunctionCall> = {};
      for (const [call, fn] of Object.entries(expression.functions)) {
        functions[call] =
          fn && typeof fn === "object"
            ? { ...fn, ...(Array.isArray(fn.facts) ? { facts: fn.facts.map((f) => (f && typeof f === "object" ? { ...f } : f)) } : {}) }
            : fn;
      }
      copy.expression.functions = functions;
    }
  }
  return copy;
}

function headerCopy(node: ExpandedNode, flag: "repeat" | "cyclic"): ExpandedNode {
  const copy: ExpandedNode = { factID: node.factID, source: node.source, fact: node.fact };
  if (node.time !== undefined) copy.time = node.time;
  copy[flag] = true;
  return copy;
}

/** The synthesis node for an unmet optional condition, built from the reference (the engine's own fact is never stored). */
function synthesisNode(ref: Ref, factID: string): ExpandedNode {
  return {
    factID,
    source: "synthesis",
    fact: {
      subject: { value: String(ref.subject ?? "") },
      relationship: { type: String(ref.relationship ?? "") },
      object: { value: ref.object ?? "", ...(ref.objectType ? { dataType: ref.objectType } : {}) },
      certainty: finiteNumber(ref.certainty) ?? 0,
    },
  };
}

async function forEachLimited<T>(items: T[], limit: number, run: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const item = items[next++];
      await run(item);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message || error.name;
  return String(error);
}
