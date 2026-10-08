/**
 * Unit tests for the parts of the platform client that are pure: reading a
 * POST /maps response, the /response body respond() builds, and how start()
 * reports a Knowledge Map ID the engine does not know (with fetch stubbed).
 * The fixtures are bodies captured from api.rainbird.ai.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { ApiError, parseCreateMapResponse, RainbirdClient, unknownMapMessage } from "../api";

describe("parseCreateMapResponse", () => {
  test("a 201 with an error field: the map exists AND carries a validation message", () => {
    // Captured 2026-09-10 pushing examples/broken/diagnostics-tour.rbl.
    const result = parseCreateMapResponse({
      kmID: "6428f29c-cd76-4537-bd18-7f467a6e3995",
      id: "36167",
      error: "Line: 35 - Datasource hostname must start with 'http://' or 'https://' followed by a valid hostname.",
    });
    assert.equal(result.kmId, "6428f29c-cd76-4537-bd18-7f467a6e3995");
    assert.deepEqual(result.validation, ["Line: 35 - Datasource hostname must start with 'http://' or 'https://' followed by a valid hostname."]);
  });

  test("a clean 201 has no validation messages", () => {
    const result = parseCreateMapResponse({ kmID: "abc", id: "1" });
    assert.equal(result.kmId, "abc");
    assert.deepEqual(result.validation, []);
  });

  test("array-shaped errors and nested payloads are read too", () => {
    const result = parseCreateMapResponse({ map: { kmId: "nested" }, errors: ["one", { message: "two" }] });
    assert.equal(result.kmId, "nested");
    assert.deepEqual(result.validation, ["one", "two"]);
  });

  test("the numeric id is never mistaken for the kmID", () => {
    assert.equal(parseCreateMapResponse({ id: "36167" }).kmId, undefined);
  });
});

/** Run `body` with fetch answering every request with (status, json); returns the requests made. */
async function withFetch(status: number, json: unknown, body: () => Promise<void>): Promise<{ url: string; body: unknown }[]> {
  const requests: { url: string; body: unknown }[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    requests.push({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) : undefined });
    return new Response(JSON.stringify(json), { status, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  try {
    await body();
  } finally {
    globalThis.fetch = realFetch;
  }
  return requests;
}

describe("RainbirdClient.respond", () => {
  const client = new RainbirdClient("https://api.example", "key");

  test("answered questions get certainty 100 when none is given; a skip never gets one; cf is kept as given", async () => {
    // The body of the live skip (2026-10-07): Tom speaks French 71% came back, with the injected fact kept.
    const skipResult = {
      result: [{ subject: "Tom", relationshipType: "speaks", object: "French", certainty: 71, factID: "WA:RF:b6f6d137", relationship: "speaks" }],
      queryProfile: [],
      sid: "134ecd6b-7538-4a25-9316-01cf19629f59",
    };
    let response;
    const requests = await withFetch(200, skipResult, async () => {
      response = await client.respond("sid-1", [
        { relationship: "lives in", subject: "Tom", unanswered: true },
        { relationship: "speaks", subject: "Tom", object: "French" },
        { relationship: "speaks", subject: "Tom", object: "German", cf: 60 },
        { relationship: "speaks", subject: "Tom", object: "Spanish", certainty: 80 },
      ]);
    });
    assert.deepEqual(requests, [
      {
        url: "https://api.example/sid-1/response",
        body: {
          answers: [
            { relationship: "lives in", subject: "Tom", unanswered: true },
            { relationship: "speaks", subject: "Tom", object: "French", certainty: 100 },
            { relationship: "speaks", subject: "Tom", object: "German", cf: 60 },
            { relationship: "speaks", subject: "Tom", object: "Spanish", certainty: 80 },
          ],
        },
      },
    ]);
    assert.deepEqual(response, { kind: "result", result: skipResult.result });
  });

  test("a question comes back with its group and knownAnswers untouched", async () => {
    const live = {
      question: {
        subject: "Tom",
        dataType: "string",
        relationship: "lives in",
        type: "Second Form Object",
        plural: false,
        allowCF: true,
        allowUnknown: false,
        canAdd: true,
        prompt: "Where does Tom live?",
        knownAnswers: [{ subject: "Tom", relationship: { name: "lives in", plural: false }, object: "France", cf: 90 }],
        concepts: [{ conceptType: "country", name: "England", type: "string", value: "England" }],
      },
      extraQuestions: [],
      sid: "f54dc827-071c-4999-9568-35ef621409bc",
    };
    let response;
    await withFetch(200, live, async () => {
      response = await client.respond("sid-1", [{ relationship: "speaks", subject: "Tom", object: "French" }]);
    });
    assert.deepEqual(response, { kind: "question", question: live.question, extraQuestions: [] });
  });

  test("a refused skip is an ApiError carrying the engine's message", async () => {
    await withFetch(400, { err: ["Please provide an expected boolean value for unanswered."] }, async () => {
      await assert.rejects(client.respond("sid-1", [{ relationship: "lives in", subject: "Tom", unanswered: true }]), (error: unknown) => {
        assert.ok(error instanceof ApiError);
        assert.equal(error.status, 400);
        assert.deepEqual(error.errMessages(), ["Please provide an expected boolean value for unanswered."]);
        return true;
      });
    });
  });
});

/** Run `body` with fetch answering every request with (status, a raw body such as plain text); returns the URLs requested. */
async function withFetchText(status: number, text: string, body: () => Promise<void>): Promise<string[]> {
  const urls: string[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request) => {
    urls.push(String(url));
    return new Response(text, { status, headers: { "Content-Type": "text/plain" } });
  }) as typeof fetch;
  try {
    await body();
  } finally {
    globalThis.fetch = realFetch;
  }
  return urls;
}

describe("RainbirdClient.start", () => {
  const client = new RainbirdClient("https://api.example", "key");
  const kmId = "2fd1be28-b38d-4fa3-8b9d-b0976821912d";

  test("a bare 400 “Bad request!” says no map with that Knowledge Map ID is visible to the key", async () => {
    // Verified live 2026-10-07: GET /start/{unknown or malformed kmID} answers 400 "Bad request!" as plain text, on draft and live alike.
    const urls = await withFetchText(400, "Bad request!", async () => {
      await assert.rejects(client.start(kmId, { useDraft: true }), (error: unknown) => {
        assert.ok(error instanceof ApiError);
        assert.equal(error.status, 400);
        assert.equal(error.message, unknownMapMessage(kmId, "https://api.example"));
        assert.equal(error.body, "Bad request!", "the engine's body is kept");
        return true;
      });
    });
    assert.deepEqual(urls, [`https://api.example/start/${kmId}?useDraft=true`]);
    assert.equal(
      unknownMapMessage(kmId, "https://api.example"),
      `No map with Knowledge Map ID ${kmId} is visible to this API key on https://api.example. Check the ID on the map's Publish page in Studio, and that the key belongs to the same environment.`
    );
  });

  test("a 400 with {\"err\": [...]} keeps its original message", async () => {
    const body = { err: ["Please provide a valid version."] };
    await withFetch(400, body, async () => {
      await assert.rejects(client.start(kmId, { version: 3 }), (error: unknown) => {
        assert.ok(error instanceof ApiError);
        assert.equal(error.status, 400);
        assert.equal(error.message, `Rainbird API 400 on /start/${kmId}?version=3: ${JSON.stringify(body)}`);
        assert.deepEqual(error.errMessages(), ["Please provide a valid version."]);
        return true;
      });
    });
  });

  test("other failures, such as the 404 for a map with no live version, are rethrown unchanged", async () => {
    await withFetchText(404, "Not Found", async () => {
      await assert.rejects(client.start(kmId), (error: unknown) => {
        assert.ok(error instanceof ApiError);
        assert.equal(error.status, 404);
        assert.equal(error.message, `Rainbird API 404 on /start/${kmId}: Not Found`);
        return true;
      });
    });
  });

  test("a 200 still returns the session ID", async () => {
    let id: string | undefined;
    const requests = await withFetch(200, { id: "f54dc827-071c-4999-9568-35ef621409bc" }, async () => {
      id = await client.start(kmId);
    });
    assert.equal(id, "f54dc827-071c-4999-9568-35ef621409bc");
    assert.deepEqual(
      requests.map((r) => r.url),
      [`https://api.example/start/${kmId}`]
    );
  });
});
