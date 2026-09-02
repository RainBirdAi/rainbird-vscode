/**
 * Minimal Rainbird Decisions API client (documented surface only).
 *
 * Session lifecycle: GET /start/{kmID} → POST /{sid}/inject → POST /{sid}/query
 * → loop POST /{sid}/response until a result arrives. Evidence via
 * GET /analysis/evidence/{factID}/{sessionID}.
 */

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

  /** Validation failures arrive as {"err": ["message", …]}; other errors are plain text. */
  errMessages(): string[] | undefined {
    try {
      const parsed = JSON.parse(this.body) as { err?: unknown };
      return Array.isArray(parsed.err) ? parsed.err.map(String) : undefined;
    } catch {
      return undefined;
    }
  }
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
  async createMap(rblang: string, name: string, description: string): Promise<{ kmId?: string; raw: unknown }> {
    const raw = await this.request<Record<string, unknown>>(`/maps`, {
      method: "POST",
      headers: { "X-API-Key": this.apiKey, Version: "v1" },
      body: JSON.stringify({ rblang, name, description }),
    });
    // The response shape is not publicly documented; look in the usual places.
    const nested = (raw.map ?? raw.data ?? {}) as Record<string, unknown>;
    const kmId = [raw.kmID, raw.kmId, raw.id, nested.kmID, nested.kmId, nested.id].find(
      (v): v is string => typeof v === "string" && v.length > 0
    );
    return { kmId, raw };
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
