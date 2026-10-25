import assert from "node:assert/strict";
import { test } from "node:test";

import { addDays, daysInRange, parseDate, resolveRange, splitRange, today } from "../src/dates.ts";

test("parseDate rejects malformed and impossible dates", () => {
  assert.throws(() => parseDate("2026-02-30"));
  assert.throws(() => parseDate("2026-2-1"));
  assert.throws(() => parseDate("yesterday"));
  assert.equal(parseDate("2024-02-29"), Date.UTC(2024, 1, 29));
});

test("addDays and daysInRange cross month and DST boundaries", () => {
  assert.equal(addDays("2026-10-31", 1), "2026-11-01");
  assert.equal(addDays("2026-03-01", -1), "2026-02-28");
  assert.equal(daysInRange("2026-10-01", "2026-10-31"), 31);
  assert.equal(daysInRange("2026-10-25", "2026-10-25"), 1);
});

test("resolveRange defaults end to today and start to end", () => {
  assert.deepEqual(resolveRange(), { start: today(), end: today() });
  assert.deepEqual(resolveRange(undefined, "2026-10-01"), { start: "2026-10-01", end: "2026-10-01" });
  assert.throws(() => resolveRange("2026-10-10", "2026-10-01"), /after end_date/);
});

test("splitRange produces contiguous chunks no longer than the limit", () => {
  const chunks = splitRange({ start: "2026-01-01", end: "2026-03-01" }, 28);
  assert.deepEqual(chunks, [
    { start: "2026-01-01", end: "2026-01-28" },
    { start: "2026-01-29", end: "2026-02-25" },
    { start: "2026-02-26", end: "2026-03-01" },
  ]);
  assert.deepEqual(splitRange({ start: "2026-05-05", end: "2026-05-05" }, 7), [{ start: "2026-05-05", end: "2026-05-05" }]);
});

test("today uses the local calendar date", () => {
  const now = new Date(2026, 9, 25, 23, 30);
  assert.equal(today(now), "2026-10-25");
});

test("today can follow an explicit IANA time zone", () => {
  // 01:30 UTC on Oct 26 is still Oct 25 in New York.
  const now = new Date("2026-10-26T01:30:00Z");
  assert.equal(today(now, "America/New_York"), "2026-10-25");
  assert.equal(today(now, "UTC"), "2026-10-26");
});
