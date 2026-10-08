/**
 * Minimal Rainbird Decisions API client (documented surface only).
 *
 * Session lifecycle: GET /start/{kmID} → POST /{sid}/inject → POST /{sid}/query
 * → loop POST /{sid}/response (or /undo to step back) until a result arrives. Evidence via
 * GET /analysis/evidence/{factID}/{sessionID}.
 */

import { normaliseErrMessages } from "./platformErrors";
import { expandEvidence, ExpandOptions, ExpandedEvidence } from "./evidenceModel";

export interface Question {
  relationship: string;
  subject?: string;
  object?: string;
  prompt: string;
  type: "First Form" | "Second Form Subject" | "Second Form Object";
  dataType: "string" | "number" | "truth" | "date";
  plural: boolean;
  allowCF: boolean;
  allowUnknown: boolean;
  /**
   * Whether the user may type a value that is not offered. A boolean on the
   * wire (OpenAPI, and `true` live); the RBLang string form (all | subject |
   * object | subject,object | none) is tolerated — read it with canAddHere().
   */
  canAdd: boolean | string;
  /**
   * Facts the engine already holds for this question (injected, from the map, a
   * datasource or a rule). Verified live: populated from injected facts, and a
   * question that has them may be skipped with `unanswered: true` even when
   * allowUnknown is false. Read it with readKnownAnswers().
   */
  knownAnswers?: KnownAnswer[];
  /** Values to offer: instances for string objects, known values for number/date objects (possibly repeated, dates as epoch milliseconds). */
  concepts?: QuestionConcept[];
}

/**
 * One entry of `Question.knownAnswers` as the live API sends it, e.g.
 * {"subject":"Tom","relationship":{"name":"lives in","plural":false,…},"object":"France","cf":90}.
 */
export interface KnownAnswer {
  subject?: string;
  /** The relationship object ({name, plural, askable, …}) live; a bare name is tolerated. */
  relationship?: string | { name?: string; [field: string]: unknown };
  object?: string | number | boolean;
  /** Certainty as sent live. */
  cf?: number;
  /** Certainty under its documented name, tolerated as an alias of cf. */
  certainty?: number;
}

export interface QuestionConcept {
  conceptType?: string;
  name: string;
  type?: string;
  value?: string | number | boolean;
  invalidResponse?: boolean;
}

export interface ResultItem {
  subject: string;
  relationship: string;
  object: string | number | boolean;
  certainty: number;
  factID: string;
}

export type EngineResponse =
  | { kind: "question"; question: Question; extraQuestions?: Question[] }
  | { kind: "result"; result: ResultItem[] };

export interface Fact {
  subject: string;
  relationship: string;
  object: string | number | boolean;
  certainty?: number;
}

/**
 * One answer in a POST /response batch. A question group (question +
 * extraQuestions) is answered in ONE batch; a plural question takes one entry
 * per value. Build them with answerFor() / skipAnswer().
 */
export interface Answer extends Partial<Fact> {
  answer?: "yes" | "no";
  /**
   * Skip the question. Accepted only when it has allowUnknown or non-empty
   * knownAnswers (verified live; otherwise 400 "Please provide an expected
   * boolean value for unanswered."). Send the triple that identifies the
   * question, omit the asked value, and send no certainty. With knownAnswers
   * the skip means "no more": the known facts are kept.
   */
  unanswered?: true;
  /** Engine-accepted alias for certainty — mutually exclusive with it. */
  cf?: number;
}

/** Which version of a map a session runs against. */
export type StartTarget = { kind: "draft" } | { kind: "live" } | { kind: "version"; version: number };

/** Query-string options for GET /start: draft → useDraft=true, live → nothing (the engine default), version → version=N. */
export function startOptions(target: StartTarget | undefined): { useDraft?: boolean; version?: number } {
  if (!target || target.kind === "draft") return { useDraft: true };
  if (target.kind === "live") return {};
  return { version: target.version };
}

export function describeTarget(target: StartTarget | undefined): string {
  if (!target || target.kind === "draft") return "draft";
  if (target.kind === "live") return "live";
  return `version ${target.version}`;
}

/**
 * Where an evidence fact came from. The live API sends "km" for knowledge-map
 * facts although the OpenAPI enum says "knowledgemap" (verified on the public
 * sandbox, 2026-10-07), so compare through normaliseSource() in evidenceModel.ts.
 */
export type EvidenceSource = "rule" | "answer" | "injection" | "datasource" | "knowledgemap" | "km" | "synthesis";

/** One fact a list function used: an entry of expression.functions[call].facts. */
export interface EvidenceFunctionFact {
  subject?: string;
  relationship?: string;
  object?: string | number | boolean;
  certainty?: number;
  factID?: string;
  factKey?: string;
  /** The value's data type: string, number, date (epoch ms) or truth. */
  objectType?: string;
}

/** One list-function call, keyed by the call as evaluated, e.g. "sumObjects( 'Tom', 'has income', *)". */
export interface EvidenceFunctionCall {
  facts?: EvidenceFunctionFact[];
  /** null when the function had nothing to work on (minObjects / maxObjects over an empty list). */
  result?: { type?: string; value?: string | number | boolean | null };
}

export interface EvidenceExpression {
  /** The expression as written in the rule, e.g. "sumObjects(%S, 'has income', *)" or "%TOTAL > 3000". */
  text?: string;
  /**
   * The variable the expression's result was stored in ("%RELS", "%O"), NOT the
   * result: the OpenAPI example sends value "%O" for the test "%RELS is less
   * than 10". Never display it as a value.
   */
  value?: unknown;
  /** List functions used by the expression, with their result and contributing facts. */
  functions?: Record<string, EvidenceFunctionCall>;
}

/** A rule condition: a relationship condition (subject/relationship/object + factID) or an expression. */
export interface EvidenceCondition {
  subject?: string;
  relationship?: string;
  object?: string | number | boolean;
  /** The value's data type: string, number, date (epoch ms) or truth. */
  objectType?: string;
  /** Certainty of the fact that satisfied the condition (0 for an unmet optional condition). */
  certainty?: number;
  /** Contribution to the inferred fact's certainty, in percentage points (two decimals). */
  impact?: number;
  /** The condition's weight (0 = "zero salience": no effect on the certainty). */
  salience?: number;
  /**
   * The fact that satisfied the condition. "WA:XX" marks the engine's 0%
   * stand-in for an unmet optional condition: it is never stored, so GET
   * /analysis/evidence answers 404 for it (see isSynthesisFactId).
   */
  factID?: string;
  factKey?: string;
  /** Evidence text for the condition. The engine fills its {{%VAR}} placeholders before sending it. */
  alt?: string;
  expression?: EvidenceExpression;
  /** Expressions only: whether the test was true (always true when assigned to a variable). */
  wasMet?: boolean;
}

/**
 * A rule variable's value: plain for untyped variables, {value, type} for
 * typed ones (e.g. {"value": 5, "type": "number"} from sumObjects, or
 * {"value": 655516800000, "type": "date"}). Read it through bindingValue() or
 * bindingText() in evidenceModel.ts.
 */
export type EvidenceBinding = string | number | boolean | null | { value?: unknown; type?: string };

export interface EvidenceRule {
  bindings?: Record<string, EvidenceBinding>;
  /**
   * In the order the engine reports them: it walks the rule's conditions in
   * order. An optional condition it skipped (its object was never bound) is left out.
   */
  conditions?: EvidenceCondition[];
  /**
   * The rule's cf. A condition's maximum possible impact is ruleMaxCertainty ×
   * its weight ÷ the total weight of all the rule's conditions, expressions
   * included (see impactScale in evidenceModel.ts).
   */
  ruleMaxCertainty?: number;
  /** Rule-level evidence text (the rule's alt attribute), already filled in by the engine. */
  alt?: string;
}

/** One node as returned by GET /analysis/evidence/{factID}/{sessionID}. */
export interface EvidenceNode {
  factID: string;
  source: EvidenceSource;
  /** Creation time, epoch ms. */
  time?: number;
  fact: {
    subject: { value: string; type?: string; dataType?: string };
    relationship: { type: string };
    object: { value: string | number | boolean; type?: string; dataType?: string };
    certainty: number;
  };
  rule?: EvidenceRule;
}

/** A map as served by GET /analysis/file: RBLang plus Studio's structured model. */
export interface MapFile {
  concepts: unknown[];
  rels: unknown[];
  rblang: string;
}

/** HTTP failure with the status and raw body preserved so callers can branch on error *shape*. */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: string
  ) {
    super(message);
    this.name = "ApiError";
  }

  /** Validation failures arrive as {"err": ["message", …]} (occasionally a string or objects); other errors are plain text. */
  errMessages(): string[] | undefined {
    try {
      const parsed = JSON.parse(this.body) as { err?: unknown };
      const messages = normaliseErrMessages(parsed.err);
      return messages.length ? messages : undefined;
    } catch {
      return undefined;
    }
  }
}

/**
 * Why a map cannot be found: the Knowledge Map ID is unknown, malformed, or
 * belongs to another environment than the API key. Shared by the panel, the
 * runners and Open Map / Pull, so the copy lives in one place.
 */
export function unknownMapMessage(kmId: string, apiUrl: string): string {
  return `No map with Knowledge Map ID ${kmId} is visible to this API key on ${apiUrl}. Check the ID on the map's Publish page in Studio, and that the key belongs to the same environment.`;
}

export interface CreateMapResult {
  kmId?: string;
  /**
   * Validation messages the platform attached to a *successful* upload.
   * Verified live 2026-09-10: POST /maps answers 201 with
   * {"kmID": "…", "id": "…", "error": "Line: 35 - Datasource hostname must start with …"}
   * — the map is created and the draft stored as-is, and only the first
   * problem is reported, so a second push may reveal the next one.
   */
  validation: string[];
  raw: unknown;
}

/** Read the kmID and any validation messages out of a POST /maps body. Pure, so it is unit-tested against captured responses. */
export function parseCreateMapResponse(raw: Record<string, unknown>): CreateMapResult {
  // The response shape is not publicly documented; look in the usual places.
  const nested = (raw.map ?? raw.data ?? {}) as Record<string, unknown>;
  const kmId = [raw.kmID, raw.kmId, nested.kmID, nested.kmId].find((v): v is string => typeof v === "string" && v.length > 0);
  const validation = [raw.error, raw.errors, raw.err, raw.warnings, raw.validation, nested.error, nested.errors]
    .flatMap((v) => normaliseErrMessages(v))
    .filter((m, i, all) => all.indexOf(m) === i);
  return { kmId, validation, raw };
}

export class RainbirdClient {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string
  ) {}

  private async request<T>(path: string, init?: RequestInit & { evidenceKey?: string }): Promise<T> {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (init?.evidenceKey) headers["x-evidence-key"] = init.evidenceKey;
    const response = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers: { ...headers, ...(init?.headers as Record<string, string>) },
    });
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new ApiError(`Rainbird API ${response.status} on ${path}: ${body.slice(0, 300)}`, response.status, body);
    }
    return (await response.json()) as T;
  }

  /**
   * GET /start/{kmID} — the only call that needs the API key; the session ID is the credential afterwards.
   * Verified live: an unknown or malformed kmID, or one from another environment, answers a bare
   * `400 Bad request!` on draft and live alike, so that 400 is reported as an unknown map. A 400 with
   * {"err": [...]} and every other failure (such as the 404 for a missing live version or version) are
   * rethrown as they are.
   */
  async start(kmId: string, opts?: { useDraft?: boolean; version?: number }): Promise<string> {
    const params = new URLSearchParams();
    if (opts?.version !== undefined) params.set("version", String(opts.version));
    else if (opts?.useDraft) params.set("useDraft", "true");
    const query = params.size ? `?${params}` : "";
    try {
      const data = await this.request<{ id: string }>(`/start/${kmId}${query}`, {
        headers: { "X-API-Key": this.apiKey },
      });
      return data.id;
    } catch (error) {
      if (error instanceof ApiError && error.status === 400 && !error.errMessages()) {
        throw new ApiError(unknownMapMessage(kmId, this.baseUrl), 400, error.body);
      }
      throw error;
    }
  }

  async inject(sessionId: string, facts: Fact[]): Promise<void> {
    // Documented cap: 250 facts per inject request.
    for (let i = 0; i < facts.length; i += 250) {
      await this.request(`/${sessionId}/inject`, { method: "POST", body: JSON.stringify(facts.slice(i, i + 250)) });
    }
  }

  async query(
    sessionId: string,
    goal: { relationship: string; subject?: string; object?: string }
  ): Promise<EngineResponse> {
    return normalise(await this.request(`/${sessionId}/query`, { method: "POST", body: JSON.stringify(goal) }));
  }

  /** POST /{sid}/response — one call per question group; a 400 leaves the session on the same question. */
  async respond(sessionId: string, answers: Answer[]): Promise<EngineResponse> {
    // Verified live: certainty is REQUIRED on answered questions (400 without
    // it), and 'cf'/'certainty' are exclusive aliases — never send both. A skip
    // (unanswered: true) goes without certainty.
    const normalised = answers.map((a) =>
      a.unanswered || a.certainty !== undefined || a.cf !== undefined ? a : { ...a, certainty: 100 }
    );
    return normalise(
      await this.request(`/${sessionId}/response`, { method: "POST", body: JSON.stringify({ answers: normalised }) })
    );
  }

  /** POST /{sid}/undo — step back one answer; the engine re-asks the previous question (or re-decides). */
  async undo(sessionId: string): Promise<EngineResponse> {
    return normalise(await this.request(`/${sessionId}/undo`, { method: "POST", body: "{}" }));
  }

  async evidence(factId: string, sessionId: string, evidenceKey?: string): Promise<EvidenceNode> {
    return this.request(`/analysis/evidence/${factId}/${sessionId}`, { evidenceKey });
  }

  /**
   * GET /maps — capability probe. This endpoint does NOT exist on the public
   * Community API today (verified 404 "Cannot GET /maps"); it is platform
   * ask #8 in the proposal. We try anyway so the Maps view upgrades itself
   * the day the endpoint ships (and on enterprise hosts that may differ).
   */
  async listMaps(): Promise<{ available: boolean; maps: { id: string; name?: string }[] }> {
    try {
      const raw = await this.request<unknown>(`/maps`, {
        headers: { "X-API-Key": this.apiKey, Version: "v1" },
      });
      const list = Array.isArray(raw) ? raw : ((raw as Record<string, unknown>)?.maps as unknown[]) ?? [];
      const maps: { id: string; name?: string }[] = [];
      for (const entry of list) {
        const r = entry as Record<string, unknown>;
        const id = [r.kmID, r.kmId, r.id].find((v): v is string => typeof v === "string");
        if (id) maps.push({ id, ...(typeof r.name === "string" ? { name: r.name } : {}) });
      }
      return { available: true, maps };
    } catch (error) {
      if (/ 40[45] /.test(` ${(error as Error).message} `) || (error as Error).message.includes("404")) {
        return { available: false, maps: [] };
      }
      throw error;
    }
  }

  /**
   * POST /nl/interact — Rainbird's beta natural-language endpoint. Documented
   * contract: headers X-API-Key + Version: v1, body {sessionID, userPrompt}
   * against a session from GET /start. Responds with responseType
   * question|result|error, questions[], Pascal-case results[], and
   * facts{injected, invalid, unmatched}.
   */
  async nlInteract(sessionId: string, userPrompt: string): Promise<Record<string, unknown>> {
    // NL errors arrive as 4xx WITH a structured envelope (responseType,
    // error.suggestedChatResponse, …) — return it instead of throwing so the
    // UI can render the chat-friendly message.
    const response = await fetch(`${this.baseUrl}/nl/interact`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-API-Key": this.apiKey, Version: "v1" },
      body: JSON.stringify({ sessionID: sessionId, userPrompt }),
    });
    const body = await response.text();
    try {
      return JSON.parse(body) as Record<string, unknown>;
    } catch {
      throw new Error(`Rainbird API ${response.status} on /nl/interact: ${body.slice(0, 300)}`);
    }
  }

  /** GET /analysis/session/{sid}?filter=version — KM name/version metadata for a session. */
  async sessionInfo(sessionId: string): Promise<Record<string, unknown>> {
    return this.request<Record<string, unknown>>(`/analysis/session/${sessionId}?filter=version`, {
      headers: { "X-API-Key": this.apiKey },
    });
  }

  /**
   * POST /maps — the (undocumented, verified) graph upload endpoint used by
   * Rainbird's own Claude Skill and RAKE. Create-only: every call makes a new
   * map with a new kmID. Contract: X-API-Key + Version: v1, body
   * {rblang, name, description}.
   */
  async createMap(rblang: string, name: string, description: string): Promise<CreateMapResult> {
    const raw = await this.request<Record<string, unknown>>(`/maps`, {
      method: "POST",
      headers: { "X-API-Key": this.apiKey, Version: "v1" },
      body: JSON.stringify({ rblang, name, description }),
    });
    return parseCreateMapResponse(raw);
  }

  /**
   * GET /analysis/file/{kmID}[?version=N] — the map's RBLang source plus
   * Studio's structured model arrays (concepts, rels). Without `version` it
   * returns the draft. Verified live 2026-09-03; not in the public OpenAPI
   * spec, so treat the shape defensively.
   */
  async getFile(kmId: string, version?: number): Promise<MapFile> {
    const query = version !== undefined ? `?version=${version}` : "";
    const raw = await this.request<Record<string, unknown>>(`/analysis/file/${kmId}${query}`, {
      headers: { "X-API-Key": this.apiKey },
    });
    if (typeof raw.rblang !== "string") {
      throw new Error(`Unexpected /analysis/file response (no rblang field): ${JSON.stringify(raw).slice(0, 200)}`);
    }
    return {
      concepts: Array.isArray(raw.concepts) ? raw.concepts : [],
      rels: Array.isArray(raw.rels) ? raw.rels : [],
      rblang: raw.rblang,
    };
  }

  /**
   * Highest saved version number, or undefined when the map has none. There is
   * no list-versions API; versions auto-increment from 1, so probe
   * /analysis/file with a doubling search then bisect (a handful of small GETs).
   */
  async latestVersion(kmId: string): Promise<number | undefined> {
    const exists = async (n: number): Promise<boolean> => {
      try {
        await this.getFile(kmId, n);
        return true;
      } catch (error) {
        if (error instanceof ApiError && error.status === 404) return false;
        throw error;
      }
    };
    if (!(await exists(1))) return undefined;
    let lo = 1;
    let hi = 2;
    while (hi <= 4096 && (await exists(hi))) {
      lo = hi;
      hi *= 2;
    }
    while (hi - lo > 1) {
      const mid = Math.floor((lo + hi) / 2);
      if (await exists(mid)) lo = mid;
      else hi = mid;
    }
    return lo;
  }

  /**
   * The whole evidence tree for a fact: each relationship condition carries the
   * fact that satisfied it (`evidence`), list-function facts carry theirs, and
   * the root carries `meta` ({nodes, truncated, errors}). Child GETs run in
   * parallel under a node budget; a failed child becomes `fetchError` on its
   * condition, while a failed root GET rejects with the original ApiError so
   * callers can branch on `status` (401/403 = evidence locked). An unmet
   * optional condition ("WA:XX", never stored) gets a local synthesis node
   * instead of a GET. See expandEvidence in evidenceModel.ts.
   */
  async fullEvidence(factId: string, sessionId: string, evidenceKey?: string, opts?: ExpandOptions): Promise<ExpandedEvidence> {
    return expandEvidence((id) => this.evidence(id, sessionId, evidenceKey), factId, opts);
  }
}

function normalise(raw: any): EngineResponse {
  if (raw.question) {
    return { kind: "question", question: raw.question, extraQuestions: raw.extraQuestions };
  }
  return { kind: "result", result: raw.result ?? [] };
}
