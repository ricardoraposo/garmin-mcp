import { Decoder, Stream } from "@garmin/fitsdk";
import { unzipSync } from "fflate";

import { GarminConfigError } from "./errors.ts";
import { downsample } from "./format.ts";

export interface ExtractedFile {
  name: string;
  bytes: Uint8Array;
}

/** Garmin's download endpoint wraps the original upload (usually one .fit) in a ZIP. */
export function extractActivityFiles(zip: Uint8Array): ExtractedFile[] {
  const entries = unzipSync(zip, { filter: (file) => !file.name.endsWith("/") });
  return Object.entries(entries).map(([name, bytes]) => ({ name, bytes }));
}

export function findFitFile(files: ExtractedFile[]): ExtractedFile | undefined {
  return files.find((file) => file.name.toLowerCase().endsWith(".fit"));
}

const SEMICIRCLES_TO_DEGREES = 180 / 2 ** 31;

// Record fields exposed as stream columns, in output order. FIT names on the left.
const STREAM_FIELDS: Record<string, string> = {
  distance: "distance_m",
  heartRate: "heart_rate_bpm",
  enhancedSpeed: "speed_mps",
  power: "power_w",
  cadence: "cadence",
  enhancedAltitude: "altitude_m",
  grade: "grade_pct",
  temperature: "temperature_c",
  verticalOscillation: "vertical_oscillation_mm",
  stanceTime: "ground_contact_ms",
  stepLength: "step_length_mm",
  enhancedRespirationRate: "respiration_rate",
  coreTemperature: "core_temperature_c",
};

const LAP_FIELDS = [
  "startTime",
  "totalElapsedTime",
  "totalTimerTime",
  "totalDistance",
  "enhancedAvgSpeed",
  "enhancedMaxSpeed",
  "avgHeartRate",
  "maxHeartRate",
  "avgCadence",
  "avgPower",
  "maxPower",
  "normalizedPower",
  "totalAscent",
  "totalDescent",
  "totalCalories",
  "avgTemperature",
  "intensity",
  "lapTrigger",
  "sport",
  "subSport",
  "wktStepIndex",
] as const;

export interface FitAnalysisOptions {
  maxPoints: number;
  includeGps: boolean;
}

/** Decodes a FIT activity into session totals, laps and a downsampled columnar stream. */
export function analyzeFit(bytes: Uint8Array, options: FitAnalysisOptions): Record<string, unknown> {
  const stream = Stream.fromByteArray(bytes);
  const decoder = new Decoder(stream);
  if (!decoder.isFIT()) throw new GarminConfigError("The downloaded file is not a FIT file.");
  const integrityOk = decoder.checkIntegrity();

  const { messages, errors } = decoder.read({
    applyScaleAndOffset: true,
    expandComponents: true,
    expandSubFields: true,
    convertTypesToStrings: true,
    convertDateTimesToDates: true,
    mergeHeartRates: true,
  });

  const fileId = messages.fileIdMesgs?.[0];
  // The SDK's message interfaces have no index signature; treat them as plain records.
  const records = (messages.recordMesgs ?? []) as unknown as Record<string, unknown>[];
  const start = records[0]?.timestamp ?? messages.sessionMesgs?.[0]?.startTime;
  const startMs = start instanceof Date ? start.getTime() : undefined;

  return {
    file: fileId && {
      type: fileId.type,
      manufacturer: fileId.manufacturer,
      product: fileId.garminProduct ?? fileId.product,
      timeCreated: fileId.timeCreated,
    },
    device: (messages.deviceInfoMesgs ?? [])
      .filter((d) => d.deviceIndex === "creator" || d.deviceIndex === 0)
      .map((d) => ({ manufacturer: d.manufacturer, product: d.garminProduct ?? d.product, software: d.softwareVersion }))[0],
    sessions: (messages.sessionMesgs ?? []).map((s) => withoutUnknownFields(s, options.includeGps)),
    laps: (messages.lapMesgs ?? []).map((lap, index) => ({ lap: index + 1, ...pick(lap, LAP_FIELDS) })),
    workout_steps: messages.workoutStepMesgs?.map((step) => withoutUnknownFields(step, false)),
    stream: buildStream(records, startMs, options),
    integrity_ok: integrityOk,
    decode_errors: errors.length ? errors.map((e) => e.message) : undefined,
  };
}

function buildStream(
  records: readonly Record<string, unknown>[],
  startMs: number | undefined,
  { maxPoints, includeGps }: FitAnalysisOptions,
): Record<string, unknown> | undefined {
  if (!records.length) return undefined;

  const present = Object.keys(STREAM_FIELDS).filter((field) => records.some((r) => typeof r[field] === "number"));
  const hasGps = includeGps && records.some((r) => typeof r.positionLat === "number");
  const sample = downsample(records, maxPoints);

  const columns: Record<string, unknown[]> = {
    elapsed_s: sample.map((r) =>
      r.timestamp instanceof Date && startMs !== undefined ? Math.round((r.timestamp.getTime() - startMs) / 1000) : null,
    ),
  };
  for (const field of present) {
    columns[STREAM_FIELDS[field]!] = sample.map((r) => round(r[field]));
  }
  if (hasGps) {
    columns.lat = sample.map((r) => toDegrees(r.positionLat));
    columns.lng = sample.map((r) => toDegrees(r.positionLong));
  }

  return {
    total_records: records.length,
    returned_points: sample.length,
    note:
      "Columnar: index i of every column is the same instant. elapsed_s counts from the first record. " +
      "Running cadence in FIT is per foot (strides/min): double it for steps/min.",
    columns,
  };
}

function pick(source: object, fields: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of fields) {
    const value = (source as Record<string, unknown>)[field];
    if (value !== undefined) out[field] = value;
  }
  return out;
}

// Session bounds and start/end points, stored as semicircles.
const POSITION_FIELD = /(PositionLat|PositionLong|^necLat|^necLong|^swcLat|^swcLong)$/;

// Fields missing from the FIT profile come back under numeric keys; they mean nothing to a reader.
// Positions are dropped unless GPS was asked for, like the stream's lat/lng columns.
function withoutUnknownFields(mesg: object, includeGps: boolean): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(mesg)) {
    if (/^\d+$/.test(key) || key === "mesgNum" || key === "developerFields") continue;
    if (POSITION_FIELD.test(key)) {
      if (includeGps) out[key] = toDegrees(value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

function round(value: unknown): number | null {
  return typeof value === "number" ? Math.round(value * 100) / 100 : null;
}

function toDegrees(value: unknown): number | null {
  return typeof value === "number" ? Math.round(value * SEMICIRCLES_TO_DEGREES * 1e6) / 1e6 : null;
}
