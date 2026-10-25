import { KEY_CREATION_URL } from "./config.ts";

/** Problems with local setup (missing key, bad arguments) that the user or model can fix. */
export class GarminConfigError extends Error {
  override name = "GarminConfigError";
}

export class GarminHttpError extends Error {
  override name = "GarminHttpError";
  readonly status: number;
  readonly path: string;
  readonly body: string;

  constructor(status: number, method: string, path: string, body: string) {
    const detail = body.trim() ? `: ${body.trim().slice(0, 500)}` : "";
    super(`${method} ${path} returned HTTP ${status}${detail}`);
    this.status = status;
    this.path = path;
    this.body = body;
  }
}

/** Turns any error into a message that tells the model what to do next. */
export function describeError(error: unknown): string {
  if (error instanceof GarminHttpError) {
    const hint = httpHint(error);
    return hint ? `${error.message}\n\n${hint}` : error.message;
  }
  if (error instanceof GarminConfigError) return error.message;
  if (error instanceof Error && error.name === "TimeoutError") {
    return "Garmin did not respond in time. Try again, or request a smaller date range.";
  }
  return error instanceof Error ? error.message : String(error);
}

function httpHint(error: GarminHttpError): string | undefined {
  if (error.path.includes("personal-api-key/token")) {
    return (
      "Garmin rejected the Personal API key. It may be wrong, revoked or expired " +
      `(keys last 30 days to 1 year). Create a new one at ${KEY_CREATION_URL}.`
    );
  }
  switch (error.status) {
    case 400:
      return "Garmin rejected the parameters. Check the date format (YYYY-MM-DD) and try a shorter date range.";
    case 401:
      return `The access token was refused even after renewing it. Check the key at ${KEY_CREATION_URL}.`;
    case 403:
      return "This key is not allowed to read that resource.";
    case 404:
      return "Not found. Either the ID does not exist, or the Personal API does not expose this endpoint.";
    case 429:
      return "Garmin is rate limiting requests. Wait a little before trying again.";
    default:
      return error.status >= 500 ? "Garmin had a server error. Try again later." : undefined;
  }
}
