/**
 * Knowledge Map IDs (kmIDs) as people paste them.
 *
 * Rainbird's API reference documents the kmID as "in GUID format", shown under
 * View Knowledge Map ID in the map's menu and on the map's Publish page in
 * Studio. Users paste it bare, inside a Studio or API URL, as lines copied
 * from the Publish page (which also shows the API key, another GUID), or as a
 * line of JSON. So extraction prefers the GUID that its surroundings mark as a
 * map, and otherwise takes the last one that is not marked as a session ID or
 * a key.
 *
 * GUIDs are case-insensitive (RFC 4122) and the API accepts either case
 * (verified on the public sandbox), so IDs come back in lower case, the form
 * Studio shows. One spelling per map keeps the Maps registry, file bindings,
 * snapshot file names and anything keyed by kmID from splitting by case.
 *
 * VS Code-free so it is unit-tested (src/test/kmId.test.ts).
 */

/** A whole string that is one GUID (8-4-4-4-12 hexadecimal digits), either case. */
export const KM_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Every GUID in a text that is not glued to more hexadecimal digits. */
const GUID_IN_TEXT = /(?<![0-9a-f])[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?![0-9a-f])/gi;

/**
 * Text right before a GUID that says it is a map: a km / map / kb path
 * segment (also in hash routes) or the API's /start/{kmID} and
 * /analysis/file/{kmID}, an id / kmid style query parameter, or a label such
 * as "Knowledge Map ID:", "kmID =" or a JSON key ("kmId": "…",
 * "rainbird.knowledgeMapId": "…"; the optional quote after the label is the
 * key's closing quote).
 */
const MAP_CONTEXT = [
  /(?:^|[/#])(?:km|kms|kb|kbs|maps?|knowledge-?maps?|start|analysis\/file)\/$/i,
  /[?&#;](?:id|kmid|km|km_id|map|mapid|map_id|knowledgemapid)=$/i,
  /(?:\bkm[\s_-]*id|\bknowledge[\s_-]*map[\s_-]*id|\bmap[\s_-]*id)["']?\s*[:=]?\s*["']?$/i,
];

/**
 * Text right before a GUID that says it is something else: a session ID
 * (sid=, /sessions/, "sessionId": …, the API's
 * /analysis/evidence/{factID}/{sessionID}), a version ID (versionId=,
 * /versions/) or a key ("API key:", x-api-key, apiKey, evidenceKey). "key" is
 * a whole word or follows a known prefix, so "monkey" is no hint.
 */
const OTHER_CONTEXT = [
  /[?&#;](?:sid|session|sessionid|session_id|version|versionid|version_id)=$/i,
  /(?:^|[/#])(?:sessions?|versions?)\/$/i,
  /\/evidence\/[^/\s?#]+\/$/i,
  /(?:\b(?:api|evidence|secret|access|auth)[\s_-]*key|\bkey|\bsession(?:[\s_-]*id)?|\bsid|\bversion[\s_-]*id)["']?\s*[:=]?\s*["']?$/i,
];

/** Text right after a GUID that says it is a session ID: the API's /{sessionID}/query and the like. */
const OTHER_AFTER = /^\/(?:inject|query|response|undo)(?![a-z])/i;

/** How much text around a GUID is inspected for the hints above (a fact ID before a session ID is about 70 characters). */
const CONTEXT_CHARS = 120;

/** True when the text, trimmed, is exactly one GUID. */
export function looksLikeKmId(text: string): boolean {
  return KM_ID_RE.test(text.trim());
}

/** Case-insensitive kmID comparison; false when either side is missing. */
export function sameKmId(a: string | undefined, b: string | undefined): boolean {
  return !!a && !!b && a.trim().toLowerCase() === b.trim().toLowerCase();
}

/**
 * A kmID in its one spelling: a GUID trimmed and in lower case; anything else
 * (an ID on a host whose kmIDs are not GUIDs) only trimmed. Use it before
 * storing or keying anything by kmID.
 */
export function normaliseKmId(text: string): string {
  const trimmed = (text ?? "").trim();
  return KM_ID_RE.test(trimmed) ? trimmed.toLowerCase() : trimmed;
}

export interface ExtractKmIdOptions {
  /**
   * Whether a GUID marked as a session ID or a key may be returned when no
   * other GUID is found (default true: the user typed or pasted it as a kmID,
   * and the prompt warns). Pass false for text nobody offered as a kmID, such
   * as the clipboard, so a copied evidence link (…&sid=<session>) or an
   * "x-api-key: …" line is not proposed as a map.
   */
  allowOther?: boolean;
}

/**
 * The kmID in a pasted text, in lower case, or undefined when it holds no
 * GUID. A bare GUID is returned as is. Among several, the last one marked as a
 * map (path segment, query parameter or label) wins; otherwise the last one
 * not marked as a session ID or key; otherwise (unless `allowOther` is false)
 * the last session ID or key.
 */
export function extractKmId(text: string, opts: ExtractKmIdOptions = {}): string | undefined {
  const trimmed = (text ?? "").trim();
  if (!trimmed) return undefined;
  if (KM_ID_RE.test(trimmed)) return trimmed.toLowerCase();
  let map: string | undefined;
  let plain: string | undefined;
  let other: string | undefined;
  for (const match of trimmed.matchAll(GUID_IN_TEXT)) {
    const at = match.index ?? 0;
    const before = trimmed.slice(Math.max(0, at - CONTEXT_CHARS), at);
    const after = trimmed.slice(at + match[0].length, at + match[0].length + CONTEXT_CHARS);
    const id = match[0].toLowerCase();
    if (MAP_CONTEXT.some((re) => re.test(before))) map = id;
    else if (OTHER_CONTEXT.some((re) => re.test(before)) || OTHER_AFTER.test(after)) other = id;
    else plain = id;
  }
  return map ?? plain ?? (opts.allowOther === false ? undefined : other);
}

/**
 * Default file name for a map pulled into the workspace: the first block of
 * the kmID keeps maps apart without a 36-character name ("map-504436fb-draft.rbl",
 * "map-504436fb-v3.rbl"). The API returns no map name to use instead.
 */
export function defaultFileName(kmId: string, ref: "draft" | number): string {
  const stem = normaliseKmId(kmId).slice(0, 8).replace(/[^0-9A-Za-z_-]/g, "_") || "unknown";
  return `map-${stem}-${ref === "draft" ? "draft" : `v${ref}`}.rbl`;
}
