/**
 * Studio deep links: the Studio host for each documented API host, and the
 * evidence link in the documented format
 * [STUDIO]/evidence?id=<factID>&api=<API URL>&sid=<sessionID>
 * (docs.rainbird.ai, "Building an Evidence Tree URL").
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { deriveStudioUrl, evidenceLink, hostOf, normaliseStudioUrl } from "../studioLinks";
import { HELLO_WORLD_ROOT_ID, HELLO_WORLD_SESSION_ID } from "./fixtures/evidenceFixtures";

describe("deriveStudioUrl", () => {
  test("maps every documented API host to its Studio host", () => {
    assert.equal(deriveStudioUrl("https://api.rainbird.ai"), "https://app.rainbird.ai");
    assert.equal(deriveStudioUrl("https://enterprise-api.rainbird.ai"), "https://enterprise.rainbird.ai");
    assert.equal(deriveStudioUrl("https://sa-enterprise-api.rainbird.ai"), "https://sa-enterprise.rainbird.ai");
    assert.equal(deriveStudioUrl("https://clientname-api.rainbird.ai"), "https://clientname.rainbird.ai");
  });

  test("tolerates trailing slashes, paths, case and a missing scheme", () => {
    assert.equal(deriveStudioUrl("https://api.rainbird.ai/"), "https://app.rainbird.ai");
    assert.equal(deriveStudioUrl("https://API.Rainbird.ai/v1"), "https://app.rainbird.ai");
    assert.equal(deriveStudioUrl("api.rainbird.ai"), "https://app.rainbird.ai");
    assert.equal(deriveStudioUrl("  https://enterprise-api.rainbird.ai  "), "https://enterprise.rainbird.ai");
  });

  test("returns undefined for unknown or look-alike hosts and never throws", () => {
    for (const value of [
      "https://rb.acme.internal",
      "https://api.rainbird.ai.evil.example",
      "https://acme-api.rainbird.ai.evil.example",
      "https://app.rainbird.ai",
      "https://-api.rainbird.ai",
      "not a url",
      "http://",
      "",
      undefined,
      null,
    ]) {
      assert.doesNotThrow(() => deriveStudioUrl(value as string));
      assert.equal(deriveStudioUrl(value as string), undefined, String(value));
    }
  });
});

describe("evidenceLink", () => {
  test("builds the documented link, with the API URL readable as in the docs' example", () => {
    assert.equal(
      evidenceLink({ studioUrl: "https://app.rainbird.ai", apiUrl: "https://api.rainbird.ai", factId: HELLO_WORLD_ROOT_ID, sessionId: HELLO_WORLD_SESSION_ID }),
      `https://app.rainbird.ai/evidence?id=${HELLO_WORLD_ROOT_ID}&api=https://api.rainbird.ai&sid=${HELLO_WORLD_SESSION_ID}`
    );
    // The documented Enterprise example: …/evidence?id=[FACT_ID]&api=https://enterprise-api.rainbird.ai&sid=[SESSION_ID]
    assert.equal(
      evidenceLink({ studioUrl: "https://enterprise.rainbird.ai/", apiUrl: "https://enterprise-api.rainbird.ai/", factId: "WA:RF:1", sessionId: "s-1" }),
      "https://enterprise.rainbird.ai/evidence?id=WA:RF:1&api=https://enterprise-api.rainbird.ai&sid=s-1"
    );
  });

  test("percent-encodes anything that could break the query string", () => {
    const link = evidenceLink({ studioUrl: "https://app.rainbird.ai", apiUrl: "https://api.rainbird.ai", factId: "a&b=c#d+e f%", sessionId: "x?y" });
    assert.equal(link, "https://app.rainbird.ai/evidence?id=a%26b%3Dc%23d%2Be%20f%25&api=https://api.rainbird.ai&sid=x%3Fy");
    const parsed = new URL(link);
    assert.equal(parsed.searchParams.get("id"), "a&b=c#d+e f%");
    assert.equal(parsed.searchParams.get("api"), "https://api.rainbird.ai");
    assert.equal(parsed.searchParams.get("sid"), "x?y");
  });
});

describe("Studio URL helpers", () => {
  test("normaliseStudioUrl accepts http(s) URLs, adds a missing scheme and drops trailing slashes, query and fragment", () => {
    assert.equal(normaliseStudioUrl("https://clientname.rainbird.ai/"), "https://clientname.rainbird.ai");
    assert.equal(normaliseStudioUrl("clientname.rainbird.ai"), "https://clientname.rainbird.ai");
    assert.equal(normaliseStudioUrl("https://studio.acme.internal:8443/rainbird/?x=1#y"), "https://studio.acme.internal:8443/rainbird");
    assert.equal(normaliseStudioUrl("ftp://studio.acme.internal"), undefined);
    assert.equal(normaliseStudioUrl("https://"), undefined);
    assert.equal(normaliseStudioUrl(""), undefined);
    assert.equal(normaliseStudioUrl(undefined), undefined);
  });

  test("hostOf reads the host of a URL or of a bare host name", () => {
    assert.equal(hostOf("https://Enterprise-API.rainbird.ai/x"), "enterprise-api.rainbird.ai");
    assert.equal(hostOf("rb.acme.internal"), "rb.acme.internal");
    assert.equal(hostOf("::"), undefined);
  });
});
