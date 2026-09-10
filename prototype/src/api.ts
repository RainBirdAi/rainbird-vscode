/**
 * Minimal Rainbird Decisions API client (documented surface only).
 *
 * Session lifecycle: GET /start/{kmID} → POST /{sid}/inject → POST /{sid}/query
 * → loop POST /{sid}/response (or /undo to step back) until a result arrives. Evidence via
 * GET /analysis/evidence/{factID}/{sessionID}.
 */

import { normaliseErrMessages } from "./platformErrors";

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
  canAdd: string;
  knownAnswers?: unknown[];
  concepts?: { name: string; value?: string }[];
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

export interface Answer extends Partial<Fact> {
  answer?: "yes" | "no";
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

export interface EvidenceNode {
  factID: string;
  source: "knowledgemap" | "rule" | "answer" | "injection" | "datasource" | "synthesis";
  fact: {
    subject: { value: string };
    relationship: { type: string };
    object: { value: string };
    certainty: number;
  };
  rule?: {
    bindings?: Record<string, string>;
    conditions?: Array<{
      factID?: string;
      subject?: string;
      relationship?: string;
      object?: string;
      certainty?: number;
      impact?: number;
      salience?: number;
      expression?: { text?: string; value?: unknown };
      wasMet?: boolean;
      alt?: string;
    }>;
  };
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

  /** GET /start/{kmID} — the only call that needs the API key; the session ID is the credential afterwards. */
  async start(kmId: string, opts?: { useDraft?: boolean; version?: number }): Promise<string> {
    const params = new URLSearchParams();
    if (opts?.version !== undefined) params.set("version", String(opts.version));
    else if (opts?.useDraft) params.set("useDraft", "true");
    const query = params.size ? `?${params}` : "";
    const data = await this.request<{ id: string }>(`/start/${kmId}${query}`, {
      headers: { "X-API-Key": this.apiKey },
    });
    return data.id;
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

  async respond(sessionId: string, answers: Answer[]): Promise<EngineResponse> {
    // Verified live: certainty is REQUIRED on answered questions (400 without
    // it), and 'cf'/'certainty' are exclusive aliases — never send both.
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

  /** Recursively expand an evidence tree by following condition factIDs. */
  async fullEvidence(
    factId: string,
    sessionId: string,
    evidenceKey?: string,
    depth = 0
  ): Promise<EvidenceNode & { children: EvidenceNode[] }> {
    const node = (await this.evidence(factId, sessionId, evidenceKey)) as EvidenceNode & {
      children: (EvidenceNode & { children: EvidenceNode[] })[];
    };
    node.children = [];
    if (depth < 10 && node.rule?.conditions) {
      for (const condition of node.rule.conditions) {
        if (condition.factID) {
          node.children.push(await this.fullEvidence(condition.factID, sessionId, evidenceKey, depth + 1));
        }
      }
    }
    return node;
  }
}

function normalise(raw: any): EngineResponse {
  if (raw.question) {
    return { kind: "question", question: raw.question, extraQuestions: raw.extraQuestions };
  }
  return { kind: "result", result: raw.result ?? [] };
}
