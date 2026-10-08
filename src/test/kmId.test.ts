/**
 * Unit tests for reading Knowledge Map IDs out of what people paste
 * (kmId.ts): bare IDs, Studio and API URLs, lines copied from the Publish
 * page, and text with no ID at all.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { KM_ID_RE, defaultFileName, extractKmId, looksLikeKmId, normaliseKmId, sameKmId } from "../kmId";

const MAP = "504436fb-7fbb-44ea-b36c-bfd977aea8c8";
const OTHER = "2fd1be28-b38d-4fa3-8b9d-b0976821912c";
const SESSION = "4bee7f8f-0b7b-42f1-a738-31b49baa1192";
const KEY = "37582f71-b9b1-4451-b9e6-c130c7fd2412";

describe("kmID recognition", () => {
  test("a bare GUID is a kmID, in either case and with surrounding whitespace", () => {
    assert.ok(KM_ID_RE.test(MAP));
    assert.ok(looksLikeKmId(MAP));
    assert.ok(looksLikeKmId(`  ${MAP.toUpperCase()}\n`));
    assert.equal(looksLikeKmId(`${MAP}x`), false);
    assert.equal(looksLikeKmId("504436fb7fbb44eab36cbfd977aea8c8"), false);
  });

  test("kmIDs compare case-insensitively, and a missing side never matches", () => {
    assert.ok(sameKmId(MAP, MAP.toUpperCase()));
    assert.ok(sameKmId(` ${MAP} `, MAP));
    assert.equal(sameKmId(MAP, OTHER), false);
    assert.equal(sameKmId(undefined, MAP), false);
    assert.equal(sameKmId(MAP, ""), false);
  });

  test("normaliseKmId lower-cases a GUID and only trims anything else", () => {
    assert.equal(normaliseKmId(` ${MAP.toUpperCase()}\n`), MAP);
    assert.equal(normaliseKmId(MAP), MAP);
    assert.equal(normaliseKmId("  Not-An-ID "), "Not-An-ID");
    assert.equal(normaliseKmId(""), "");
  });
});

describe("extractKmId", () => {
  test("a bare GUID comes back trimmed and in lower case", () => {
    assert.equal(extractKmId(MAP), MAP);
    assert.equal(extractKmId(`\t${MAP}  \n`), MAP);
    assert.equal(extractKmId(MAP.toUpperCase()), MAP);
  });

  test("a single GUID inside a URL or a sentence is found", () => {
    assert.equal(extractKmId(`https://app.rainbird.ai/km/${MAP}/publish`), MAP);
    assert.equal(extractKmId(`https://api.rainbird.ai/start/${MAP.toUpperCase()}?useDraft=true`), MAP);
    assert.equal(extractKmId(`The map is {${MAP}}.`), MAP);
  });

  test("the GUID after a km, map or kb path segment beats the others, wherever it sits", () => {
    assert.equal(extractKmId(`https://app.rainbird.ai/workspace/${OTHER}/km/${MAP}/publish`), MAP);
    assert.equal(extractKmId(`https://studio.example.com/maps/${MAP}/versions/${OTHER}`), MAP);
    assert.equal(extractKmId(`https://studio.example.com/#/kb/${MAP}/${OTHER}`), MAP);
    assert.equal(extractKmId(`https://studio.example.com/knowledge-maps/${MAP}?tab=${OTHER}`), MAP);
  });

  test("an id or kmid query parameter marks the map", () => {
    assert.equal(extractKmId(`https://studio.example.com/editor?kmid=${MAP}&sid=${SESSION}`), MAP);
    assert.equal(extractKmId(`https://studio.example.com/editor?id=${MAP}&ref=${OTHER}`), MAP);
    assert.equal(extractKmId(`https://studio.example.com/editor?kmID=${MAP.toUpperCase()}&x=${OTHER}`), MAP);
  });

  test("with no hint the last GUID wins", () => {
    assert.equal(extractKmId(`https://studio.example.com/${OTHER}/${MAP}`), MAP);
    assert.equal(extractKmId(`${OTHER} ${MAP}`), MAP);
    assert.equal(extractKmId(`monkey ${MAP}`, { allowOther: false }), MAP);
  });

  test("API URLs: /start/{kmID} and /analysis/file/{kmID} mark the map; session paths mark a session", () => {
    const factId = "WA:RF:b6f6d1377feeecd7a3430cfdc9b13652fc3cf0a5166395a76c5224421d2aa83f";
    assert.equal(extractKmId(`POST https://api.rainbird.ai/${SESSION}/query`), SESSION);
    assert.equal(extractKmId(`POST https://api.rainbird.ai/${SESSION}/query`, { allowOther: false }), undefined);
    assert.equal(extractKmId(`https://api.rainbird.ai/${SESSION}/response`, { allowOther: false }), undefined);
    assert.equal(extractKmId(`https://api.rainbird.ai/analysis/evidence/${factId}/${SESSION}`, { allowOther: false }), undefined);
    assert.equal(extractKmId(`https://api.rainbird.ai/analysis/file/${MAP}?version=3 then /${SESSION}/undo`), MAP);
    assert.equal(extractKmId(`GET /start/${MAP} → {"id":"${SESSION}"}; POST /${SESSION}/inject`), MAP);
  });

  test("version IDs and session IDs in JSON never win over the map", () => {
    assert.equal(extractKmId(`curl https://api.rainbird.ai/start/${MAP} -d '{"sid":"${SESSION}"}'`), MAP);
    assert.equal(extractKmId(`https://app.rainbird.ai/editor/${MAP}?versionId=${OTHER}`), MAP);
    assert.equal(extractKmId(`https://studio.example.com/${MAP}/versions/${OTHER}`), MAP);
    assert.equal(extractKmId(`{"versionId": "${OTHER}", "id": "${MAP}"}`), MAP);
  });

  test("session IDs and keys lose to any other GUID, but are returned when they are all there is", () => {
    assert.equal(extractKmId(`https://studio.example.com/${MAP}?sid=${SESSION}`), MAP);
    assert.equal(extractKmId(`https://api.rainbird.ai/sessions/${SESSION} ${MAP}`), MAP);
    assert.equal(extractKmId(`https://app.rainbird.ai/evidence?id=WA:RF:1a2b&api=api.rainbird.ai&sid=${SESSION}`), SESSION);
    assert.equal(extractKmId(`x-api-key: ${KEY}`), KEY);
    assert.equal(extractKmId(`Session: ${SESSION}`), SESSION);
  });

  test("with allowOther false, text holding only session IDs or keys yields nothing", () => {
    // An evidence tree's Copy link: the fact ID holds no dashed GUID, the session ID does.
    const evidenceLink =
      "https://app.rainbird.ai/evidence?id=WA:RF:b6f6d1377feeecd7a3430cfdc9b13652fc3cf0a5166395a76c5224421d2aa83f" +
      `&api=https://api.rainbird.ai&sid=${SESSION}`;
    assert.equal(extractKmId(evidenceLink, { allowOther: false }), undefined);
    assert.equal(extractKmId(`x-api-key: ${KEY}`, { allowOther: false }), undefined);
    assert.equal(extractKmId(`{"evidenceKey":"${KEY}"}`, { allowOther: false }), undefined);
    assert.equal(extractKmId(`https://api.rainbird.ai/sessions/${SESSION}`, { allowOther: false }), undefined);
    // Anything else is unaffected: a bare GUID, an unmarked or a map-marked one.
    assert.equal(extractKmId(MAP, { allowOther: false }), MAP);
    assert.equal(extractKmId(`see ${MAP}`, { allowOther: false }), MAP);
    assert.equal(extractKmId(`https://studio.example.com/editor?kmid=${MAP}&sid=${SESSION}`, { allowOther: false }), MAP);
  });

  test("lines copied from the Publish page yield the Knowledge Map ID, not the API key", () => {
    assert.equal(extractKmId(`API key: ${KEY}\nKnowledge Map ID: ${MAP}`), MAP);
    assert.equal(extractKmId(`Knowledge Map ID: ${MAP}\nAPI key: ${KEY}`), MAP);
    assert.equal(extractKmId(`KMID ${MAP}\nAPI Key ${KEY}`), MAP);
    assert.equal(extractKmId(`kmID = "${MAP}"`), MAP);
  });

  test("JSON keys mark the map, a session ID or a key, in camelCase too", () => {
    assert.equal(extractKmId(`{"kmID":"${MAP}","apiKey":"${KEY}"}`), MAP);
    assert.equal(extractKmId(`{"kmId":"${MAP}","sessionId":"${SESSION}"}`), MAP);
    assert.equal(extractKmId(`{"sessionId": "${SESSION}", "mapId": "${MAP}"}`), MAP);
    assert.equal(extractKmId(`{\n  "rainbird.knowledgeMapId": "${MAP}",\n  "rainbird.other": "${OTHER}"\n}`), MAP);
    assert.equal(extractKmId(`{'knowledge_map_id': '${MAP}', 'api_key': '${KEY}'}`), MAP);
  });

  test("text without a whole GUID yields nothing", () => {
    assert.equal(extractKmId(""), undefined);
    assert.equal(extractKmId("   "), undefined);
    assert.equal(extractKmId("abc"), undefined);
    assert.equal(extractKmId("not-an-id"), undefined);
    assert.equal(extractKmId("504436fb-7fbb-44ea-b36c"), undefined);
    assert.equal(extractKmId(`${MAP}a`), undefined);
    assert.equal(extractKmId(`a${MAP}`), undefined);
    assert.equal(extractKmId("504436fb7fbb44eab36cbfd977aea8c8"), undefined);
    assert.equal(extractKmId("504436fb-7fbb-44ea-b36c-bfd977aea8cg"), undefined);
  });
});

describe("defaultFileName", () => {
  test("names a draft and a version by the first block of the kmID", () => {
    assert.equal(defaultFileName(MAP, "draft"), "map-504436fb-draft.rbl");
    assert.equal(defaultFileName(MAP, 3), "map-504436fb-v3.rbl");
    assert.equal(defaultFileName(MAP.toUpperCase(), "draft"), "map-504436fb-draft.rbl");
  });

  test("an ID that is not a GUID still gives a safe file name", () => {
    assert.equal(defaultFileName("ab/c:d", "draft"), "map-ab_c_d-draft.rbl");
    assert.equal(defaultFileName("  ", 1), "map-unknown-v1.rbl");
  });
});
