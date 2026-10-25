import assert from "node:assert/strict";
import { test } from "node:test";

import { Encoder, Profile } from "@garmin/fitsdk";
import { zipSync } from "fflate";

import { analyzeFit, extractActivityFiles, findFitFile } from "../src/fit.ts";

const start = new Date("2026-10-25T11:00:00Z");
const DEGREES_TO_SEMICIRCLES = 2 ** 31 / 180;

/** A 10-minute run with one record per second and two laps. */
function syntheticRun(): Uint8Array {
  const encoder = new Encoder();
  encoder.writeMesg({ mesgNum: Profile.MesgNum.FILE_ID, type: "activity", manufacturer: "garmin", product: 4432, timeCreated: start });
  for (let s = 0; s < 600; s++) {
    encoder.writeMesg({
      mesgNum: Profile.MesgNum.RECORD,
      timestamp: new Date(start.getTime() + s * 1000),
      heartRate: 120 + Math.floor(s / 20),
      distance: s * 3,
      enhancedSpeed: 3,
      cadence: 86,
      positionLat: Math.round(47.4 * DEGREES_TO_SEMICIRCLES),
      positionLong: Math.round(8.5 * DEGREES_TO_SEMICIRCLES),
    });
  }
  for (const [i, lapStart] of [0, 300].entries()) {
    encoder.writeMesg({
      mesgNum: Profile.MesgNum.LAP,
      messageIndex: i,
      timestamp: new Date(start.getTime() + (lapStart + 300) * 1000),
      startTime: new Date(start.getTime() + lapStart * 1000),
      totalTimerTime: 300,
      totalDistance: 900,
      avgHeartRate: 125 + i * 10,
    });
  }
  encoder.writeMesg({
    mesgNum: Profile.MesgNum.SESSION,
    timestamp: new Date(start.getTime() + 600_000),
    startTime: start,
    sport: "running",
    totalTimerTime: 600,
    totalDistance: 1800,
    startPositionLat: Math.round(47.4 * DEGREES_TO_SEMICIRCLES),
  });
  return encoder.close();
}

test("activity ZIP is unpacked and the FIT file is found", () => {
  const zip = zipSync({ "123_ACTIVITY.fit": syntheticRun(), "notes.txt": new TextEncoder().encode("hi") });
  const files = extractActivityFiles(zip);
  assert.deepEqual(files.map((f) => f.name).sort(), ["123_ACTIVITY.fit", "notes.txt"]);
  assert.equal(findFitFile(files)?.name, "123_ACTIVITY.fit");
});

test("analyzeFit returns session, laps and a downsampled columnar stream", () => {
  const result = analyzeFit(syntheticRun(), { maxPoints: 11, includeGps: false }) as {
    integrity_ok: boolean;
    sessions: Record<string, unknown>[];
    laps: Record<string, unknown>[];
    stream: { total_records: number; returned_points: number; columns: Record<string, (number | null)[]> };
  };

  assert.equal(result.integrity_ok, true);
  assert.equal(result.sessions[0]?.sport, "running");
  assert.equal(result.sessions[0]?.totalDistance, 1800);
  assert.equal("startPositionLat" in result.sessions[0]!, false, "positions are hidden without include_gps");
  assert.deepEqual(result.laps.map((lap) => lap.avgHeartRate), [125, 135]);

  assert.equal(result.stream.total_records, 600);
  assert.equal(result.stream.returned_points, 11);
  assert.equal(result.stream.columns.elapsed_s?.[0], 0);
  assert.equal(result.stream.columns.elapsed_s?.at(-1), 599);
  assert.equal(result.stream.columns.distance_m?.at(-1), 1797);
  assert.equal(result.stream.columns.heart_rate_bpm?.[0], 120);
  assert.equal(result.stream.columns.lat, undefined);
});

test("include_gps adds positions in degrees", () => {
  const result = analyzeFit(syntheticRun(), { maxPoints: 3, includeGps: true }) as {
    sessions: Record<string, unknown>[];
    stream: { columns: Record<string, number[]> };
  };
  assert.equal(result.stream.columns.lat?.[0], 47.4);
  assert.equal(result.stream.columns.lng?.[0], 8.5);
  assert.equal(result.sessions[0]?.startPositionLat, 47.4);
});
