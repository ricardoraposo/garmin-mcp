import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import { maxResponseChars } from "./config.ts";
import { describeError } from "./errors.ts";

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

/**
 * Drops null fields recursively (Garmin DTOs are mostly nulls, and they cost
 * tokens) and turns Dates and bigints from the FIT decoder into JSON values.
 */
export function stripNulls(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripNulls);
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? undefined : value.toISOString();
  if (typeof value === "bigint") return Number.isSafeInteger(Number(value)) ? Number(value) : value.toString();
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      if (item !== null && item !== undefined) out[key] = stripNulls(item);
    }
    return out;
  }
  return value;
}

/**
 * Shrinks intraday time-series arrays (e.g. heartRateValues) found anywhere in
 * `value`. With `maxSamples` 0 they are replaced by a note; otherwise they are
 * evenly downsampled, always keeping the first and last sample.
 */
export function limitSamples(value: unknown, keys: ReadonlySet<string>, maxSamples: number): unknown {
  if (Array.isArray(value)) return value.map((item) => limitSamples(item, keys, maxSamples));
  if (!value || typeof value !== "object") return value;

  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (keys.has(key) && Array.isArray(item)) {
      out[key] =
        maxSamples === 0
          ? `${item.length} samples omitted; call again with samples > 0 to include them`
          : downsample(item, maxSamples);
    } else {
      out[key] = limitSamples(item, keys, maxSamples);
    }
  }
  return out;
}

export function downsample<T>(items: readonly T[], maxPoints: number): T[] {
  if (items.length <= maxPoints) return [...items];
  if (maxPoints <= 1) return items.slice(0, maxPoints);
  const step = (items.length - 1) / (maxPoints - 1);
  return Array.from({ length: maxPoints }, (_, i) => items[Math.round(i * step)] as T);
}

/** Wraps data as an MCP tool result, trimming the largest array if it would blow the output budget. */
export function jsonResult(value: unknown): CallToolResult {
  const budget = maxResponseChars();
  const data = stripNulls(value) as Json;
  const text = JSON.stringify(data);
  if (text.length <= budget) return { content: [{ type: "text", text }] };

  const trimmed = trimLargestArray(data, budget);
  if (trimmed) return { content: [{ type: "text", text: JSON.stringify(trimmed) }] };

  return errorResult(
    `The response is ${text.length} characters, over the ${budget} character limit. ` +
      "Request a shorter date range, fewer samples, or fewer sections.",
  );
}

export function errorResult(error: unknown): CallToolResult {
  return { isError: true, content: [{ type: "text", text: describeError(error) }] };
}

function trimLargestArray(data: Json, budget: number): Json | undefined {
  let holder: Record<string, Json> | undefined;
  let key: string | undefined;
  let items: Json[] | undefined;

  if (Array.isArray(data)) {
    items = data;
  } else if (data && typeof data === "object") {
    for (const [k, v] of Object.entries(data)) {
      if (Array.isArray(v) && (!items || JSON.stringify(v).length > JSON.stringify(items).length)) {
        holder = data;
        key = k;
        items = v;
      }
    }
  }
  if (!items || items.length < 2) return undefined;

  const build = (count: number): Json => {
    const note = {
      returned: count,
      total: items.length,
      hint:
        "Output was too large and was cut. Request the rest with a later start date, " +
        "or ask for less per item (sections, samples, detail=compact).",
    };
    if (!holder || key === undefined) return { items: items.slice(0, count), truncated: note };
    return { ...holder, [key]: items.slice(0, count), truncated: note };
  };

  // Binary search for the largest prefix that fits.
  let lo = 0;
  let hi = items.length - 1;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (JSON.stringify(build(mid)).length <= budget) lo = mid;
    else hi = mid - 1;
  }
  return lo > 0 ? build(lo) : undefined;
}
