import { setTimeout as sleep } from "node:timers/promises";

import { TokenProvider } from "./auth.ts";
import { REQUEST_TIMEOUT_MS } from "./config.ts";
import { GarminConfigError, GarminHttpError } from "./errors.ts";

export type QueryValue = string | number | boolean | undefined | (string | number | boolean)[];
export type Query = Record<string, QueryValue>;

const RETRYABLE_STATUS = new Set([429, 502, 503, 504]);
const MAX_RETRIES = 2;
// Only plain API paths: no scheme, host, "..", "//" or query string, so the bearer
// token can never be sent anywhere but the Personal API host.
const SAFE_PATH = /^(\/[A-Za-z0-9._~-]+)+\/?$/;

/** Read-only client for https://personal.connectapi.garmin.com. */
export class GarminClient {
  private readonly baseUrl: string;
  private readonly tokens: TokenProvider;
  private readonly fetchImpl: typeof fetch;

  constructor(options: { baseUrl: string; tokens: TokenProvider; fetchImpl?: typeof fetch }) {
    this.baseUrl = options.baseUrl;
    this.tokens = options.tokens;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  /** GETs a JSON endpoint. Returns `null` for empty bodies (Garmin uses 204 for "no data"). */
  async getJson(path: string, query?: Query): Promise<unknown> {
    const response = await this.request(path, query, "application/json");
    const text = await response.text();
    return text.trim() ? JSON.parse(text) : null;
  }

  async getBytes(path: string, accept: string): Promise<Uint8Array> {
    const response = await this.request(path, undefined, accept);
    return new Uint8Array(await response.arrayBuffer());
  }

  private async request(path: string, query: Query | undefined, accept: string): Promise<Response> {
    if (!SAFE_PATH.test(path) || path.split("/").includes("..")) {
      throw new GarminConfigError(`Refusing to request unsafe path ${JSON.stringify(path)}.`);
    }
    const url = `${this.baseUrl}${path}${toQueryString(query)}`;

    let token = await this.tokens.getToken();
    let renewed = false;
    for (let attempt = 0; ; attempt++) {
      const response = await this.fetchImpl(url, {
        headers: { Accept: accept, Authorization: `Bearer ${token.accessToken}` },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (response.ok) return response;

      // A token can be revoked before its exp; mint a new one once.
      if (response.status === 401 && !renewed) {
        await response.body?.cancel();
        token = await this.tokens.getToken(true);
        renewed = true;
        continue;
      }
      if (RETRYABLE_STATUS.has(response.status) && attempt < MAX_RETRIES) {
        await response.body?.cancel();
        await sleep(retryDelayMs(response, attempt));
        continue;
      }
      throw new GarminHttpError(response.status, "GET", path, await response.text());
    }
  }
}

function toQueryString(query: Query | undefined): string {
  if (!query) return "";
  const params = new URLSearchParams();
  for (const [name, value] of Object.entries(query)) {
    if (value === undefined) continue;
    // Array parameters are repeated (?requiredField=a&requiredField=b).
    for (const item of Array.isArray(value) ? value : [value]) params.append(name, String(item));
  }
  const encoded = params.toString();
  return encoded ? `?${encoded}` : "";
}

function retryDelayMs(response: Response, attempt: number): number {
  const retryAfter = Number(response.headers.get("retry-after"));
  if (Number.isFinite(retryAfter) && retryAfter > 0) return Math.min(retryAfter, 30) * 1000;
  return 1000 * 2 ** attempt;
}
