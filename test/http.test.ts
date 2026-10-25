import assert from "node:assert/strict";
import { test } from "node:test";

import { today } from "../src/dates.ts";
import { createHttpHandler, listen } from "../src/http.ts";

const BASE = "https://personal.example.test";
const GOOD_KEY = "good-key-".padEnd(60, "x");
const BAD_KEY = "bad-key-".padEnd(60, "x");

function jwt(): string {
  const part = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${part({ alg: "none" })}.${part({ exp: Date.now() / 1000 + 86_400 })}.sig`;
}

/** A Garmin stand-in that accepts GOOD_KEY and counts token exchanges. */
function fakeGarmin(profile: object = { measurementSystem: "metric", timeZone: "Pacific/Kiritimati" }) {
  const exchanges: string[] = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const auth = new Headers(init?.headers).get("authorization") ?? "";
    if (url.endsWith("/personal-api-key/token")) {
      exchanges.push(auth);
      return auth === `ApiKey ${GOOD_KEY}` ? new Response(jwt()) : new Response("", { status: 401 });
    }
    if (!auth.startsWith("Bearer ")) return new Response("", { status: 401 });
    if (url.endsWith("/userprofile-service/userprofile/settings")) return Response.json(profile);
    if (url.includes("/usersummary-service/stats/steps/daily/")) return Response.json([]);
    return new Response("", { status: 404 });
  }) as typeof fetch;
  return { impl, exchanges };
}

function rpc(method: string, params: object = {}, headers: Record<string, string> = { Authorization: `ApiKey ${GOOD_KEY}` }, path = "/mcp") {
  return new Request(`https://garmin.example.test${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...headers },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
}

const initialize = { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } };

async function toolText(response: Response): Promise<string> {
  const body = (await response.json()) as { result: { content: { text: string }[] } };
  return body.result.content[0]!.text;
}

test("requests without a usable key never reach Garmin", async () => {
  const garmin = fakeGarmin();
  const serve = createHttpHandler({ baseUrl: BASE, fetchImpl: garmin.impl });
  for (const headers of [{}, { Authorization: "ApiKey short" }, { Authorization: `Basic ${GOOD_KEY}` }, { Authorization: GOOD_KEY }]) {
    const response = await serve(rpc("initialize", initialize, headers));
    assert.equal(response.status, 401, JSON.stringify(headers));
    // A Bearer challenge would send MCP clients looking for OAuth.
    assert.equal(response.headers.get("www-authenticate"), 'ApiKey realm="garmin-mcp"');
  }
  assert.equal(garmin.exchanges.length, 0);
});

test("the key is read from ApiKey, Bearer (legacy), x-api-key or X-Garmin-Api-Key", async () => {
  for (const headers of [
    { Authorization: `ApiKey ${GOOD_KEY}` },
    { Authorization: `apikey ${GOOD_KEY}` },
    { Authorization: `Bearer ${GOOD_KEY}` },
    { "x-api-key": GOOD_KEY },
    { "X-Garmin-Api-Key": GOOD_KEY },
  ]) {
    const serve = createHttpHandler({ baseUrl: BASE, fetchImpl: fakeGarmin().impl });
    const response = await serve(rpc("initialize", initialize, headers));
    assert.equal(response.status, 200, JSON.stringify(Object.keys(headers)));
  }
});

test("a key Garmin rejects gets 401 and is not retried for a while", async () => {
  const garmin = fakeGarmin();
  const serve = createHttpHandler({ baseUrl: BASE, fetchImpl: garmin.impl });
  for (let i = 0; i < 3; i++) {
    const response = await serve(rpc("initialize", initialize, { Authorization: `ApiKey ${BAD_KEY}` }));
    assert.equal(response.status, 401);
    assert.match(await response.text(), /Garmin rejected this Personal API key/);
  }
  assert.equal(garmin.exchanges.length, 1);
});

test("one token exchange per key, reused across requests", async () => {
  const garmin = fakeGarmin();
  const serve = createHttpHandler({ baseUrl: BASE, fetchImpl: garmin.impl });

  const init = await serve(rpc("initialize", initialize));
  assert.equal(init.status, 200);
  assert.equal(((await init.json()) as { result: { serverInfo: { name: string } } }).result.serverInfo.name, "garmin-mcp");

  // Vercel rewrites /mcp to /api/mcp; both paths work. The key may also come in X-Garmin-Api-Key.
  const list = await serve(rpc("tools/list", {}, { "X-Garmin-Api-Key": GOOD_KEY }, "/api/mcp"));
  const tools = ((await list.json()) as { result: { tools: { name: string }[] } }).result.tools.map((t) => t.name);
  assert.ok(tools.includes("garmin_get_sleep"));
  assert.ok(!tools.includes("garmin_download_activity_file"), "no file writes on a remote host");

  const profile = await serve(rpc("tools/call", { name: "garmin_get_profile", arguments: {} }));
  assert.equal(JSON.parse(await toolText(profile)).measurementSystem, "metric");
  assert.deepEqual(garmin.exchanges, [`ApiKey ${GOOD_KEY}`]);
});

test('"today" follows the time zone in the Garmin profile, or X-Garmin-Timezone', async () => {
  const fromProfile = createHttpHandler({ baseUrl: BASE, fetchImpl: fakeGarmin().impl });
  const steps = await fromProfile(rpc("tools/call", { name: "garmin_get_steps", arguments: {} }));
  const range = JSON.parse(await toolText(steps)).range as { end: string };
  assert.equal(range.end, today(new Date(), "Pacific/Kiritimati"));

  const fromHeader = createHttpHandler({ baseUrl: BASE, fetchImpl: fakeGarmin().impl });
  const headers = { Authorization: `ApiKey ${GOOD_KEY}`, "X-Garmin-Timezone": "Pacific/Pago_Pago" };
  const steps2 = await fromHeader(rpc("tools/call", { name: "garmin_get_steps", arguments: {} }, headers));
  assert.equal((JSON.parse(await toolText(steps2)).range as { end: string }).end, today(new Date(), "Pacific/Pago_Pago"));
});

test("health check is open, unknown paths 404, GET on /mcp is 405", async () => {
  const serve = createHttpHandler({ baseUrl: BASE, fetchImpl: fakeGarmin().impl });
  assert.equal((await serve(new Request("https://x.test/healthz"))).status, 200);
  assert.equal((await serve(new Request("https://x.test/other"))).status, 404);
  const get = await serve(new Request("https://x.test/mcp", { headers: { Authorization: `ApiKey ${GOOD_KEY}` } }));
  assert.equal(get.status, 405);
});

test("listen() bridges node:http to the fetch handler", async () => {
  const server = await listen(createHttpHandler({ baseUrl: BASE, fetchImpl: fakeGarmin().impl }), 0, "127.0.0.1");
  try {
    const { port } = server.address() as { port: number };
    const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers: {
        Authorization: `ApiKey ${GOOD_KEY}`,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 7, method: "initialize", params: initialize }),
    });
    assert.equal(response.status, 200);
    assert.equal(((await response.json()) as { id: number }).id, 7);
  } finally {
    server.close();
  }
});
