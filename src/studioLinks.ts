/**
 * Links from the extension into Rainbird Studio's evidence tree. Pure (no
 * vscode import) so it is unit-tested in Node; src/evidenceLinks.ts adds the
 * settings, prompts, browser and clipboard on top.
 *
 * Documented format ("Building an Evidence Tree URL", docs.rainbird.ai):
 *   [STUDIO]/evidence?id=[FACT_ID]&api=[API URL]&sid=[SESSION_ID]
 * with the documented example
 *   https://enterprise.rainbird.ai/evidence?id=…&api=https://enterprise-api.rainbird.ai&sid=…
 * Hosts per environment, from the same page: Community app ↔ api, Enterprise
 * enterprise ↔ enterprise-api, South America sa-enterprise ↔ sa-enterprise-api,
 * private clientname ↔ clientname-api (all *.rainbird.ai).
 *
 * Rainbird's own apps build the same link with the full API URL (the stats UI,
 * the unit tester, the natural-language chat), and Studio's evidence page reads
 * `api` with URLSearchParams and fetches `${api}/analysis/evidence/${id}/${sid}`.
 * Those apps pass an evidence key only as a POSTed form field ("key"), so a
 * plain link cannot carry one: for a map that needs a key, the link opens only
 * when the map's Evidence Tree Link is enabled.
 */

/**
 * The Studio base URL for an API URL, or undefined when the host is not a
 * known *.rainbird.ai API host (then the rainbird.studioUrl setting is needed).
 * Never throws: a malformed or schemeless value is handled.
 */
export function deriveStudioUrl(apiUrl: string | undefined | null): string | undefined {
  const host = hostOf(apiUrl);
  if (!host) return undefined;
  if (host === "api.rainbird.ai") return "https://app.rainbird.ai";
  // enterprise-api → enterprise, sa-enterprise-api → sa-enterprise, clientname-api → clientname.
  const match = /^([a-z0-9](?:[a-z0-9-]*[a-z0-9])?)-api\.rainbird\.ai$/.exec(host);
  return match ? `https://${match[1]}.rainbird.ai` : undefined;
}

/**
 * The Studio evidence link for a fact in a session. ":" and "/" stay readable
 * (both are legal in a query string, and the documented example sends the API
 * URL unencoded); anything that could break the query (&, =, #, +, %, spaces…)
 * is percent-encoded. Trailing slashes are dropped from both base URLs.
 */
export function evidenceLink(p: { studioUrl: string; apiUrl: string; factId: string; sessionId: string }): string {
  const studio = String(p.studioUrl ?? "").trim().replace(/\/+$/, "");
  const api = String(p.apiUrl ?? "").trim().replace(/\/+$/, "");
  return `${studio}/evidence?id=${encodeQueryValue(p.factId)}&api=${encodeQueryValue(api)}&sid=${encodeQueryValue(p.sessionId)}`;
}

/**
 * A Studio base URL as typed in the rainbird.studioUrl setting: http(s) only,
 * "https://" added when the scheme is missing, query/fragment and trailing
 * slashes dropped. Undefined when it is not a usable URL.
 */
export function normaliseStudioUrl(value: string | undefined | null): string | undefined {
  const parsed = parseUrl(value);
  if (!parsed || (parsed.protocol !== "https:" && parsed.protocol !== "http:") || !parsed.hostname) return undefined;
  const path = parsed.pathname.replace(/\/+$/, "");
  return `${parsed.protocol}//${parsed.host}${path}`;
}

/** The lower-case host of a URL (or of "host/path" without a scheme); undefined when it cannot be parsed. */
export function hostOf(url: string | undefined | null): string | undefined {
  const parsed = parseUrl(url);
  return parsed?.hostname ? parsed.hostname.toLowerCase() : undefined;
}

function parseUrl(value: string | undefined | null): URL | undefined {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) return undefined;
  for (const candidate of /^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? [text] : [`https://${text}`]) {
    try {
      return new URL(candidate);
    } catch {
      // fall through
    }
  }
  return undefined;
}

function encodeQueryValue(value: unknown): string {
  return encodeURIComponent(String(value ?? "")).replace(/%3A/gi, ":").replace(/%2F/gi, "/");
}
