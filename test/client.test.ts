import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { jwtExpiration, TokenProvider } from "../src/auth.ts";
import { GarminClient } from "../src/garmin-client.ts";

const BASE = "https://personal.example.test";
const dir = await mkdtemp(join(tmpdir(), "garmin-mcp-test-"));
after(() => rm(dir, { recursive: true, force: true }));

function jwt(expSeconds: number, id = "t"): string {
  const part = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${part({ alg: "none" })}.${part({ exp: expSeconds, id })}.sig`;
}

interface Call {
  url: string;
  method: string;
  auth: string | null;
}

/** A fetch stub that answers with the queued handlers in order and records each call. */
function fakeFetch(...handlers: ((call: Call) => Response)[]) {
  const calls: Call[] = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    const call = { url: String(input), method: init?.method ?? "GET", auth: headers.get("authorization") };
    calls.push(call);
    const handler = handlers.shift();
    if (!handler) throw new Error(`unexpected request ${call.method} ${call.url}`);
    return handler(call);
  }) as typeof fetch;
  return { impl, calls };
}

test("jwtExpiration reads exp in milliseconds", () => {
  assert.equal(jwtExpiration(jwt(1_800_000_000)), 1_800_000_000_000);
  assert.throws(() => jwtExpiration("not-a-jwt"));
});

test("token is exchanged once, cached on disk with 0600, and reused", async () => {
  const cacheFile = join(dir, "cache-a.json");
  const now = Date.UTC(2026, 9, 25);
  const token = jwt(now / 1000 + 24 * 3600);
  const fetch1 = fakeFetch(() => new Response(token));
  const provider = new TokenProvider({ baseUrl: BASE, cacheFile, keySource: async () => "KEY", fetchImpl: fetch1.impl, now: () => now });

  assert.equal((await provider.getToken()).accessToken, token);
  assert.equal((await provider.getToken()).accessToken, token);
  assert.equal(fetch1.calls.length, 1);
  assert.equal(fetch1.calls[0]?.method, "POST");
  assert.equal(fetch1.calls[0]?.auth, "ApiKey KEY");
  assert.equal((await stat(cacheFile)).mode & 0o777, 0o600);

  // A new process with the same key reads the disk cache instead of exchanging again.
  const fetch2 = fakeFetch();
  const second = new TokenProvider({ baseUrl: BASE, cacheFile, keySource: async () => "KEY", fetchImpl: fetch2.impl, now: () => now });
  assert.equal((await second.getToken()).accessToken, token);

  // A different key does not reuse the cached token.
  const fetch3 = fakeFetch(() => new Response(jwt(now / 1000 + 3600 * 24, "other")));
  const third = new TokenProvider({ baseUrl: BASE, cacheFile, keySource: async () => "OTHER", fetchImpl: fetch3.impl, now: () => now });
  await third.getToken();
  assert.equal(fetch3.calls.length, 1);
  assert.equal(JSON.parse(await readFile(cacheFile, "utf8")).expires_at, now / 1000 + 3600 * 24);
});

test("token close to expiry is renewed", async () => {
  const now = Date.UTC(2026, 9, 25);
  const fetch = fakeFetch(
    () => new Response(jwt(now / 1000 + 30 * 60, "old")),
    () => new Response(jwt(now / 1000 + 24 * 3600, "new")),
  );
  const provider = new TokenProvider({ baseUrl: BASE, cacheFile: join(dir, "cache-b.json"), keySource: async () => "KEY", fetchImpl: fetch.impl, now: () => now });
  await provider.getToken();
  await provider.getToken();
  assert.equal(fetch.calls.length, 2);
});

test("client renews the token once on 401 and builds repeated query params", async () => {
  const now = Date.UTC(2026, 9, 25);
  const fetch = fakeFetch(
    () => new Response(jwt(now / 1000 + 24 * 3600, "first")),
    () => new Response("", { status: 401 }),
    () => new Response(jwt(now / 1000 + 24 * 3600, "second")),
    () => Response.json([{ activityId: 1 }]),
  );
  const tokens = new TokenProvider({ baseUrl: BASE, cacheFile: join(dir, "cache-c.json"), keySource: async () => "KEY", fetchImpl: fetch.impl, now: () => now });
  const client = new GarminClient({ baseUrl: BASE, tokens, fetchImpl: fetch.impl });

  const data = await client.getJson("/activitylist-service/activities/search/activities", {
    limit: 3,
    requiredField: ["avgPower", "averageHR"],
    activityType: undefined,
  });
  assert.deepEqual(data, [{ activityId: 1 }]);
  const last = fetch.calls.at(-1)!;
  assert.equal(last.url, `${BASE}/activitylist-service/activities/search/activities?limit=3&requiredField=avgPower&requiredField=averageHR`);
  assert.notEqual(fetch.calls[1]?.auth, last.auth);
});

test("client returns null for 204 and refuses paths that could leave the host", async () => {
  const now = Date.UTC(2026, 9, 25);
  const fetch = fakeFetch(
    () => new Response(jwt(now / 1000 + 24 * 3600)),
    () => new Response(null, { status: 204 }),
  );
  const tokens = new TokenProvider({ baseUrl: BASE, cacheFile: join(dir, "cache-d.json"), keySource: async () => "KEY", fetchImpl: fetch.impl, now: () => now });
  const client = new GarminClient({ baseUrl: BASE, tokens, fetchImpl: fetch.impl });

  assert.equal(await client.getJson("/hrv-service/hrv/2026-10-25"), null);
  for (const bad of ["//evil.example/x", "https://evil.example/x", "/a/../b", "/a?x=1", "relative/path", "/a/%2e%2e/b"]) {
    await assert.rejects(client.getJson(bad), /unsafe path/, bad);
  }
});
