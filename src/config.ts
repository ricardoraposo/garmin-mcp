import { homedir } from "node:os";
import { join } from "node:path";

// Defaults match Garmin's official Python client (garmin/connect-personal-api-python),
// so a key file or token cache created by `gc-personal` is picked up here too.
export const DEFAULT_BASE_URL = "https://personal.connectapi.garmin.com";
export const TOKEN_PATH = "/personalapitoken-service/personal-api/personal-api-key/token";
export const KEY_CREATION_URL = "https://connect.garmin.com/app/settings/personalApiToken";

export const API_KEY_ENV_VAR = "GARMIN_PERSONAL_API_KEY";
export const API_KEY_FILE_ENV_VAR = "GARMIN_PERSONAL_API_KEY_FILE";
export const BASE_URL_ENV_VAR = "GARMIN_PERSONAL_API_BASE_URL";
export const TOKEN_CACHE_ENV_VAR = "GARMIN_PERSONAL_API_TOKEN_CACHE";
export const MAX_RESPONSE_CHARS_ENV_VAR = "GARMIN_MCP_MAX_RESPONSE_CHARS";
// HTTP mode: IANA zone for "today" when the Garmin profile has none.
export const TIMEZONE_ENV_VAR = "GARMIN_TIMEZONE";

const configDir = join(homedir(), ".config", "garmin");
export const DEFAULT_API_KEY_FILE = join(configDir, "connect-personal-api-key");
export const DEFAULT_TOKEN_CACHE_FILE = join(configDir, "connect-personal-api-bearer-token.json");

export const REQUEST_TIMEOUT_MS = 30_000;
// A cached token is replaced when less than this much lifetime remains.
export const TOKEN_REFRESH_WINDOW_MS = 60 * 60 * 1000;

// Roughly 25k tokens, the default MCP output cap in Claude Code.
export const DEFAULT_MAX_RESPONSE_CHARS = 90_000;

export function baseUrl(): string {
  return (process.env[BASE_URL_ENV_VAR] ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
}

export function maxResponseChars(): number {
  const raw = Number(process.env[MAX_RESPONSE_CHARS_ENV_VAR]);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_MAX_RESPONSE_CHARS;
}
