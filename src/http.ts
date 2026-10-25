import { createHash } from "node:crypto";
import { createServer as createNodeServer, type IncomingMessage, type Server } from "node:http";
import { Readable } from "node:stream";

import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";

import { TokenProvider } from "./auth.ts";
import { baseUrl as defaultBaseUrl, KEY_CREATION_URL, TIMEZONE_ENV_VAR } from "./config.ts";
import { isTimeZone } from "./dates.ts";
import { GarminHttpError } from "./errors.ts";
import { GarminClient } from "./garmin-client.ts";
import { createServer } from "./server.ts";

export type FetchHandler = (request: Request) => Promise<Response>;

// Vercel rewrites /mcp to the function at /api/mcp; accept either.
const MCP_PATHS = new Set(["/mcp", "/api/mcp"]);
// For clients that reserve the Authorization header for something else. claude.ai
// only sends pre-approved header names, and x-api-key is one of them.
const KEY_HEADERS = ["x-api-key", "x-garmin-api-key"];
const TIMEZONE_HEADER = "x-garmin-timezone";
const MAX_SESSIONS = 100;
const REJECTED_KEY_TTL_MS = 5 * 60 * 1000;
const MAX_REJECTED = 1000;

interface Session {
  garmin: GarminClient;
  timeZone?: string;
}

/**
 * Streamable HTTP endpoint for remote MCP clients such as claude.ai custom
 * connectors. The caller sends their own Garmin Personal API key with every
 * request (`Authorization: ApiKey <key>`, the scheme Garmin itself uses for
 * the key), so the server stores no secrets and
 * Garmin itself decides who gets in. Each key gets an in-memory session whose
 * 24h access token is minted from the key and renewed before it expires.
 *
 * Stateless at the MCP level (a fresh MCP server per request, JSON responses,
 * no server-initiated stream), so it runs unchanged on serverless hosts.
 */
export function createHttpHandler(
  options: { baseUrl?: string; fetchImpl?: typeof fetch; defaultTimeZone?: string } = {},
): FetchHandler {
  const url = options.baseUrl ?? defaultBaseUrl();
  // Keyed by a hash of the API key; Map order doubles as least-recently-used order.
  const sessions = new Map<string, Promise<Session>>();
  const rejected = new Map<string, number>();

  async function sessionFor(key: string, requestedZone: string | undefined): Promise<Session> {
    const id = createHash("sha256").update(key).digest("hex");
    const rejectedUntil = rejected.get(id);
    if (rejectedUntil !== undefined && rejectedUntil > Date.now()) throw new KeyRejected();

    let session = sessions.get(id);
    if (session) {
      sessions.delete(id);
    } else {
      session = openSession(key, requestedZone);
      session.catch((error) => {
        sessions.delete(id);
        if (error instanceof KeyRejected) {
          if (rejected.size >= MAX_REJECTED) rejected.delete(rejected.keys().next().value!);
          rejected.set(id, Date.now() + REJECTED_KEY_TTL_MS);
        }
      });
      if (sessions.size >= MAX_SESSIONS) sessions.delete(sessions.keys().next().value!);
    }
    sessions.set(id, session);
    return session;
  }

  async function openSession(key: string, requestedZone: string | undefined): Promise<Session> {
    const tokens = new TokenProvider({ baseUrl: url, cacheFile: null, keySource: async () => key, fetchImpl: options.fetchImpl });
    try {
      // Exchanging the key up front checks it, so a bad key fails at connect time.
      await tokens.getToken();
    } catch (error) {
      if (error instanceof GarminHttpError && (error.status === 400 || error.status === 401 || error.status === 403)) {
        throw new KeyRejected();
      }
      throw error;
    }
    const garmin = new GarminClient({ baseUrl: url, tokens, fetchImpl: options.fetchImpl });
    return { garmin, timeZone: requestedZone ?? (await profileTimeZone(garmin)) ?? options.defaultTimeZone };
  }

  async function handle(request: Request): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (pathname === "/healthz") return Response.json({ ok: true, name: "garmin-mcp" });
    if (!MCP_PATHS.has(pathname)) return plain(404, "Not found. The MCP endpoint is /mcp.");

    const key = apiKeyFrom(request.headers);
    if (!key) {
      return unauthorized("Send your Garmin Personal API key in the header: Authorization: ApiKey <key>.");
    }
    if (request.method !== "POST") return plain(405, "Method not allowed", { Allow: "POST" });

    const zoneHeader = request.headers.get(TIMEZONE_HEADER) ?? undefined;
    let session: Session;
    try {
      session = await sessionFor(key, isTimeZone(zoneHeader) ? zoneHeader : undefined);
    } catch (error) {
      if (error instanceof KeyRejected) {
        return unauthorized(`Garmin rejected this Personal API key (wrong, revoked or expired). Create one at ${KEY_CREATION_URL}.`);
      }
      console.error("garmin-mcp: token exchange failed:", error instanceof Error ? error.message : error);
      return plain(502, "Could not reach Garmin to validate the API key. Try again shortly.");
    }

    const server = createServer(session.garmin, { allowFileWrites: false, timeZone: session.timeZone });
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    try {
      await server.connect(transport);
      return await transport.handleRequest(request);
    } finally {
      await server.close();
    }
  }

  // One line per request for the host's logs. Never the key: only where it came from.
  return async (request) => {
    const started = Date.now();
    const response = await handle(request);
    console.log(
      JSON.stringify({
        method: request.method,
        path: new URL(request.url).pathname,
        status: response.status,
        key: keySource(request.headers),
        ms: Date.now() - started,
        ua: request.headers.get("user-agent")?.slice(0, 60),
      }),
    );
    return response;
  };
}

export function createHttpHandlerFromEnv(): FetchHandler {
  const zone = process.env[TIMEZONE_ENV_VAR];
  return createHttpHandler({ defaultTimeZone: isTimeZone(zone) ? zone : undefined });
}

class KeyRejected extends Error {}

function keySource(headers: Headers): string {
  const scheme = /^(\w+)\s/.exec(headers.get("authorization") ?? "")?.[1]?.toLowerCase();
  if (scheme) return scheme;
  return KEY_HEADERS.find((name) => headers.has(name)) ?? "none";
}

function apiKeyFrom(headers: Headers): string | undefined {
  // ApiKey is the documented scheme; Bearer is still accepted for older connector setups.
  const fromAuthorization = /^(?:ApiKey|Bearer)\s+(\S+)\s*$/i.exec(headers.get("authorization") ?? "")?.[1];
  const fromHeader = KEY_HEADERS.map((name) => headers.get(name)).find(Boolean);
  const key = (fromAuthorization ?? fromHeader ?? "").trim();
  // Personal API keys are long opaque strings; anything else isn't worth a call to Garmin.
  return key.length >= 20 && key.length <= 1024 && !/\s/.test(key) ? key : undefined;
}

/**
 * Hosts usually run in UTC, but tool defaults ("today", "last night") must
 * follow the user's calendar: use the time zone in their Garmin profile.
 */
async function profileTimeZone(garmin: GarminClient): Promise<string | undefined> {
  const profile = (await garmin.getJson("/userprofile-service/userprofile/settings").catch(() => null)) as {
    timeZone?: unknown;
  } | null;
  return isTimeZone(profile?.timeZone) ? profile.timeZone : undefined;
}

function unauthorized(message: string): Response {
  // Not "Bearer": in MCP that challenge tells clients to start OAuth discovery, which this server doesn't offer.
  return plain(401, message, { "WWW-Authenticate": 'ApiKey realm="garmin-mcp"' });
}

function plain(status: number, body: string, headers: Record<string, string> = {}): Response {
  return new Response(body, { status, headers: { "Content-Type": "text/plain; charset=utf-8", ...headers } });
}

/** Serves a fetch handler with node:http, for running the HTTP mode outside Vercel. */
export function listen(handler: FetchHandler, port: number, host: string): Promise<Server> {
  const server = createNodeServer(async (req, res) => {
    try {
      const response = await handler(toRequest(req));
      res.writeHead(response.status, Object.fromEntries(response.headers));
      if (response.body) for await (const chunk of response.body) res.write(chunk);
      res.end();
    } catch (error) {
      console.error(`${req.method} ${req.url} failed:`, error);
      if (!res.headersSent) res.writeHead(500, { "Content-Type": "text/plain" });
      res.end("Internal error");
    }
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => resolve(server));
  });
}

function toRequest(req: IncomingMessage): Request {
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    for (const item of Array.isArray(value) ? value : value === undefined ? [] : [value]) headers.append(name, item);
  }
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  const hasBody = req.method !== "GET" && req.method !== "HEAD";
  return new Request(url, {
    method: req.method,
    headers,
    body: hasBody ? (Readable.toWeb(req) as ReadableStream<Uint8Array>) : undefined,
    duplex: "half",
  } as RequestInit);
}
