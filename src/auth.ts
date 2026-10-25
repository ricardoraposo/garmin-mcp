import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import {
  API_KEY_ENV_VAR,
  API_KEY_FILE_ENV_VAR,
  DEFAULT_API_KEY_FILE,
  DEFAULT_TOKEN_CACHE_FILE,
  KEY_CREATION_URL,
  REQUEST_TIMEOUT_MS,
  TOKEN_CACHE_ENV_VAR,
  TOKEN_PATH,
  TOKEN_REFRESH_WINDOW_MS,
} from "./config.ts";
import { GarminConfigError, GarminHttpError } from "./errors.ts";

export interface BearerToken {
  accessToken: string;
  /** Milliseconds since the epoch. */
  expiresAt: number;
}

/**
 * Finds the Personal API key: GARMIN_PERSONAL_API_KEY, then the file named by
 * GARMIN_PERSONAL_API_KEY_FILE, then ~/.config/garmin/connect-personal-api-key.
 */
export async function resolveApiKey(env: NodeJS.ProcessEnv = process.env): Promise<string> {
  const fromEnv = env[API_KEY_ENV_VAR];
  if (fromEnv !== undefined) return requireNonEmpty(fromEnv, `environment variable ${API_KEY_ENV_VAR}`);

  const explicitFile = env[API_KEY_FILE_ENV_VAR];
  const path = explicitFile ?? DEFAULT_API_KEY_FILE;
  let contents: string;
  try {
    contents = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    if (explicitFile) throw new GarminConfigError(`Personal API key file ${path} does not exist.`);
    throw new GarminConfigError(
      `No Garmin Personal API key found. Create one at ${KEY_CREATION_URL}, then set ` +
        `${API_KEY_ENV_VAR} in the MCP server config or save it to ${DEFAULT_API_KEY_FILE}.`,
    );
  }
  return requireNonEmpty(contents, `key file ${path}`);
}

function requireNonEmpty(value: string, source: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new GarminConfigError(`The Garmin Personal API key in ${source} is empty.`);
  return trimmed;
}

interface CacheFile {
  fingerprint: string;
  access_token: string;
  /** Seconds since the epoch, as written by Garmin's Python client. */
  expires_at: number;
}

/**
 * Exchanges the Personal API key for a ~24h bearer token. There is no refresh
 * token: a new access token is minted from the key whenever the old one is close
 * to expiring. Tokens are cached in memory and on disk (0600).
 */
export class TokenProvider {
  private memory: { fingerprint: string; token: BearerToken } | undefined;
  private pending: Promise<BearerToken> | undefined;
  private readonly baseUrl: string;
  /** null keeps tokens in memory only. */
  private readonly cacheFile: string | null;
  private readonly keySource: () => Promise<string>;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;

  constructor(options: {
    baseUrl: string;
    cacheFile?: string | null;
    keySource?: () => Promise<string>;
    fetchImpl?: typeof fetch;
    now?: () => number;
  }) {
    this.baseUrl = options.baseUrl;
    this.cacheFile =
      options.cacheFile === null ? null : (options.cacheFile ?? process.env[TOKEN_CACHE_ENV_VAR] ?? DEFAULT_TOKEN_CACHE_FILE);
    this.keySource = options.keySource ?? (() => resolveApiKey());
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? Date.now;
  }

  async getToken(forceRefresh = false): Promise<BearerToken> {
    // Concurrent tool calls share a single exchange.
    if (!this.pending) {
      this.pending = this.loadToken(forceRefresh).finally(() => {
        this.pending = undefined;
      });
    }
    return this.pending;
  }

  private async loadToken(forceRefresh: boolean): Promise<BearerToken> {
    const key = await this.keySource();
    // Same fingerprint scheme as the official client, so the cache file is shared.
    const fingerprint = createHash("sha256").update(`${this.baseUrl}\0${key}`).digest("hex");

    if (!forceRefresh) {
      const cached =
        this.memory?.fingerprint === fingerprint ? this.memory.token : await this.readCache(fingerprint);
      if (cached && cached.expiresAt - this.now() > TOKEN_REFRESH_WINDOW_MS) {
        this.memory = { fingerprint, token: cached };
        return cached;
      }
    }

    const token = await this.exchange(key);
    this.memory = { fingerprint, token };
    await this.writeCache(fingerprint, token);
    return token;
  }

  private async exchange(key: string): Promise<BearerToken> {
    const response = await this.fetchImpl(`${this.baseUrl}${TOKEN_PATH}`, {
      method: "POST",
      headers: { Accept: "*/*", Authorization: `ApiKey ${key}` },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const body = await response.text();
    if (!response.ok) throw new GarminHttpError(response.status, "POST", TOKEN_PATH, body);

    const accessToken = body.trim();
    return { accessToken, expiresAt: jwtExpiration(accessToken) };
  }

  private async readCache(fingerprint: string): Promise<BearerToken | undefined> {
    if (this.cacheFile === null) return undefined;
    try {
      const cache = JSON.parse(await readFile(this.cacheFile, "utf8")) as Partial<CacheFile>;
      if (cache.fingerprint !== fingerprint) return undefined;
      if (typeof cache.access_token !== "string" || typeof cache.expires_at !== "number") return undefined;
      return { accessToken: cache.access_token, expiresAt: cache.expires_at * 1000 };
    } catch {
      return undefined;
    }
  }

  private async writeCache(fingerprint: string, token: BearerToken): Promise<void> {
    if (this.cacheFile === null) return;
    const cache: CacheFile = {
      fingerprint,
      access_token: token.accessToken,
      expires_at: token.expiresAt / 1000,
    };
    try {
      await mkdir(dirname(this.cacheFile), { recursive: true, mode: 0o700 });
      await writeFile(this.cacheFile, JSON.stringify(cache), { mode: 0o600 });
    } catch (error) {
      // The in-memory token still works; only the next process start pays for a new exchange.
      console.error(`garmin-mcp: could not write token cache ${this.cacheFile}: ${String(error)}`);
    }
  }
}

/** Reads the `exp` claim of a JWT without verifying the signature. */
export function jwtExpiration(token: string): number {
  const payload = token.split(".")[1];
  if (payload) {
    try {
      const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { exp?: unknown };
      if (typeof claims.exp === "number") return claims.exp * 1000;
    } catch {
      // Fall through to the error below.
    }
  }
  throw new GarminConfigError("Garmin's token endpoint did not return a JWT with an exp claim.");
}
