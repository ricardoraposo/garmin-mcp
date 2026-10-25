import assert from "node:assert/strict";
import { test } from "node:test";

import { downsample, jsonResult, limitSamples, stripNulls } from "../src/format.ts";

const text = (result: ReturnType<typeof jsonResult>) => (result.content[0] as { text: string }).text;

test("stripNulls drops nulls and serializes FIT dates and bigints", () => {
  const when = new Date("2026-10-25T11:09:45Z");
  assert.deepEqual(stripNulls({ a: null, b: [1, null, { c: null, d: when }], e: 5n }), {
    b: [1, null, { d: "2026-10-25T11:09:45.000Z" }],
    e: 5,
  });
});

test("limitSamples omits or downsamples the named arrays at any depth", () => {
  const day = { restingHeartRate: 48, heartRateValues: Array.from({ length: 100 }, (_, i) => [i, 60 + i]) };
  const omitted = limitSamples([day], new Set(["heartRateValues"]), 0) as Record<string, unknown>[];
  assert.match(String(omitted[0]?.heartRateValues), /^100 samples omitted/);
  assert.equal(omitted[0]?.restingHeartRate, 48);

  const sampled = limitSamples(day, new Set(["heartRateValues"]), 5) as { heartRateValues: number[][] };
  assert.equal(sampled.heartRateValues.length, 5);
  assert.deepEqual(sampled.heartRateValues[0], [0, 60]);
  assert.deepEqual(sampled.heartRateValues[4], [99, 159]);
});

test("downsample keeps first and last", () => {
  assert.deepEqual(downsample([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 4), [1, 4, 7, 10]);
  assert.deepEqual(downsample([1, 2], 10), [1, 2]);
});

test("jsonResult trims the largest array to fit the budget", () => {
  process.env.GARMIN_MCP_MAX_RESPONSE_CHARS = "2000";
  try {
    const days = Array.from({ length: 200 }, (_, i) => ({ calendarDate: `day-${i}`, steps: i * 100 }));
    const result = jsonResult({ range: { start: "a", end: "b" }, days });
    const body = JSON.parse(text(result)) as { range: unknown; days: unknown[]; truncated: { returned: number; total: number } };
    assert.ok(text(result).length <= 2000);
    assert.deepEqual(body.range, { start: "a", end: "b" });
    assert.equal(body.truncated.total, 200);
    assert.equal(body.days.length, body.truncated.returned);
    assert.ok(body.truncated.returned > 10);

    const huge = jsonResult({ blob: "x".repeat(5000) });
    assert.equal(huge.isError, true);
  } finally {
    delete process.env.GARMIN_MCP_MAX_RESPONSE_CHARS;
  }
});
