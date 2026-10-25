import { writeFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult, ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import { resolveRange, splitRange, today, type DateRange } from "./dates.ts";
import { GarminConfigError } from "./errors.ts";
import { analyzeFit, extractActivityFiles, findFitFile } from "./fit.ts";
import { errorResult, jsonResult, limitSamples } from "./format.ts";
import type { GarminClient, Query } from "./garmin-client.ts";

// Per-request range limits. From Garmin's Swagger docs unless noted.
const MAX_DAYS = {
  sleepSummaries: 31,
  hydration: 31,
  bodyBattery: 31,
  steps: 28,
  stress: 28,
  dailySummaries: 365,
  hrvSummaries: 180, // Not documented; observed by the community.
  wellnessActivities: 31, // Not documented; kept small to be safe.
};
// Longer requests are split; this caps how many calls one tool call may make.
const MAX_CHUNKS = 15;

const READ_ONLY: ToolAnnotations = { readOnlyHint: true, idempotentHint: true, openWorldHint: true };

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD");
const dateArg = (what: string) => date.optional().describe(`${what} (YYYY-MM-DD). Defaults to today.`);
const rangeArgs = {
  start_date: date.optional().describe("First day, inclusive (YYYY-MM-DD). Defaults to end_date."),
  end_date: date.optional().describe("Last day, inclusive (YYYY-MM-DD). Defaults to today."),
};
const samplesArg = z
  .number()
  .int()
  .min(0)
  .max(2000)
  .default(0)
  .describe("Intraday samples to include, evenly spaced. 0 (default) omits the time series and keeps the daily figures.");
const activityId = z.number().int().positive().describe("Garmin activity ID, from garmin_list_activities.");

const DAILY_SUMMARY_SECTIONS = [
  "movement",
  "calories",
  "heartRate",
  "intensityMinutes",
  "stress",
  "bodyBattery",
  "hydration",
  "respiration",
  "pulseOx",
  "jetLag",
  "wellnessChronology",
] as const;

const COMPACT_ACTIVITY_FIELDS = [
  "activityId",
  "activityName",
  "startTimeLocal",
  "distance",
  "duration",
  "movingDuration",
  "elapsedDuration",
  "elevationGain",
  "elevationLoss",
  "averageSpeed",
  "maxSpeed",
  "avgGradeAdjustedSpeed",
  "averageHR",
  "maxHR",
  "calories",
  "steps",
  "averageRunningCadenceInStepsPerMinute",
  "averageBikingCadenceInRevPerMinute",
  "avgPower",
  "maxPower",
  "normPower",
  "trainingStressScore",
  "intensityFactor",
  "aerobicTrainingEffect",
  "anaerobicTrainingEffect",
  "trainingEffectLabel",
  "activityTrainingLoad",
  "vO2MaxValue",
  "lapCount",
  "locationName",
  "hrTimeInZone_1",
  "hrTimeInZone_2",
  "hrTimeInZone_3",
  "hrTimeInZone_4",
  "hrTimeInZone_5",
  "isPR",
] as const;

export const SERVER_INSTRUCTIONS = `Read-only access to the user's own Garmin Connect data through Garmin's official Personal API.

- Units are metric and raw: distance in meters, durations in seconds, speed in m/s, weight in grams. Convert for the user; garmin_get_profile tells you their preferred measurement system.
- Dates are the user's local calendar dates (YYYY-MM-DD). A night's sleep and HRV belong to the date the user woke up.
- Prefer range tools (garmin_get_daily_summaries, garmin_get_sleep with start_date/end_date) for trends; long ranges are split into several requests automatically.
- For a workout, list it with garmin_list_activities, then use garmin_get_activity for Garmin's summary or garmin_analyze_activity_file for laps and second-by-second data from the original FIT file.
- The Personal API does not expose training readiness, training status, VO2 max trends, race predictions, gear, devices, courses or workouts, and it cannot write anything to Garmin Connect.`;

export interface ToolOptions {
  /** Registers garmin_download_activity_file, which saves files on the server's disk. */
  allowFileWrites: boolean;
  /** IANA zone that "today" and "last night" follow. Defaults to the machine's zone. */
  timeZone?: string;
}

export function registerTools(server: McpServer, garmin: GarminClient, options: ToolOptions): void {
  const get = (path: string, query?: Query) => garmin.getJson(path, query);
  const now = () => today(new Date(), options.timeZone);

  // Splits long ranges into allowed chunks and fetches them one after another.
  async function chunked(range: DateRange, maxDays: number, fetchChunk: (chunk: DateRange) => Promise<unknown>) {
    const chunks = splitRange(range, maxDays);
    if (chunks.length > MAX_CHUNKS) {
      throw new GarminConfigError(
        `That range needs ${chunks.length} requests (max ${maxDays} days each); the limit is ${MAX_CHUNKS}. Use a shorter range.`,
      );
    }
    const parts: unknown[] = [];
    for (const chunk of chunks) parts.push(await fetchChunk(chunk));
    return parts;
  }

  const concat = (parts: unknown[]) => parts.flatMap((part) => (Array.isArray(part) ? part : part == null ? [] : [part]));
  const concatField = (parts: unknown[], field: string) =>
    concat(parts.map((part) => (part as Record<string, unknown> | null)?.[field]));

  // ---------------------------------------------------------------- profile

  server.registerTool(
    "garmin_get_profile",
    {
      title: "Profile settings",
      description:
        "User profile settings: display name, locale, time zone, measurement system (metric/statute), training days and hydration units. Call this first to know which units to answer in.",
      annotations: READ_ONLY,
    },
    async () => run(() => get("/userprofile-service/userprofile/settings")),
  );

  server.registerTool(
    "garmin_get_heart_rate_zones",
    {
      title: "Heart rate zones",
      description:
        "Heart rate zone floors per sport, the zone method (max HR, HR reserve or lactate threshold), and the max, resting and LTHR values used.",
      annotations: READ_ONLY,
    },
    async () => run(() => get("/biometric-service/heartRateZones/v2", { generateDefaults: true })),
  );

  // ---------------------------------------------------------------- daily wellness

  server.registerTool(
    "garmin_get_daily_summary",
    {
      title: "Daily summary (one day)",
      description:
        "Everything Garmin summarizes for one day: steps, distance, calories (active, BMR, consumed), intensity minutes, floors, resting/min/max heart rate, stress breakdown, Body Battery high/low/charged/drained, SpO2, respiration and Body Battery events.",
      inputSchema: { date: dateArg("Calendar date") },
      annotations: READ_ONLY,
    },
    async ({ date }) => run(() => get("/usersummary-service/usersummary/daily", { calendarDate: date ?? now() })),
  );

  server.registerTool(
    "garmin_get_daily_summaries",
    {
      title: "Daily summaries (date range)",
      description:
        "Daily wellness summaries for a range of days, for trends: movement, calories, heart rate, intensity minutes, stress, Body Battery, hydration, respiration, pulse ox and jet lag. Pass `sections` to keep only what you need; long ranges are much smaller that way.",
      inputSchema: {
        ...rangeArgs,
        sections: z
          .array(z.enum(DAILY_SUMMARY_SECTIONS))
          .optional()
          .describe("Sections to keep in each day. Omit for all."),
      },
      annotations: READ_ONLY,
    },
    async ({ start_date, end_date, sections }) =>
      run(async () => {
        const range = resolveRange(start_date, end_date, now());
        const parts = await chunked(range, MAX_DAYS.dailySummaries, (c) =>
          get("/usersummary-service/v2/dailysummaries", { startDate: c.start, endDate: c.end }),
        );
        let days = concatField(parts, "data") as Record<string, unknown>[];
        if (sections?.length) {
          const keep = new Set<string>(["calendarDate", ...sections]);
          days = days.map((day) => Object.fromEntries(Object.entries(day).filter(([key]) => keep.has(key))));
        }
        return { range, days };
      }),
  );

  server.registerTool(
    "garmin_get_sleep",
    {
      title: "Sleep",
      description:
        "Sleep for one night or a range of nights: start/end times, deep/light/REM/awake seconds, sleep scores and feedback, naps, average SpO2, respiration, heart rate and sleep stress. A night belongs to the date the user woke up. Omit both dates for last night.",
      inputSchema: rangeArgs,
      annotations: READ_ONLY,
    },
    async ({ start_date, end_date }) =>
      run(async () => {
        const range = resolveRange(start_date, end_date, now());
        if (range.start === range.end) return get("/sleep-service/sleep/dailySleep", { date: range.start });
        const parts = await chunked(range, MAX_DAYS.sleepSummaries, (c) =>
          get("/sleep-service/sleep/dailySleepSummariesByDate", { startDate: c.start, endDate: c.end }),
        );
        return { range, nights: concat(parts) };
      }),
  );

  server.registerTool(
    "garmin_get_hrv",
    {
      title: "Heart rate variability",
      description:
        "Overnight HRV. For one date: last-night average, 5-minute high, weekly average, baseline range, status and feedback, plus optional 5-minute readings. For a range: one summary per night.",
      inputSchema: {
        ...rangeArgs,
        samples: samplesArg.describe("Single date only: number of overnight HRV readings to include. Default 0."),
      },
      annotations: READ_ONLY,
    },
    async ({ start_date, end_date, samples }) =>
      run(async () => {
        const range = resolveRange(start_date, end_date, now());
        if (range.start === range.end) {
          const day = await get(`/hrv-service/hrv/${range.start}`);
          return day ?? `No HRV data for ${range.start}.`;
        }
        const parts = await chunked(range, MAX_DAYS.hrvSummaries, (c) => get(`/hrv-service/hrv/daily/${c.start}/${c.end}`));
        return { range, nights: concatField(parts, "hrvSummaries") };
      }, new Set(["hrvReadings"]), samples),
  );

  server.registerTool(
    "garmin_get_body_battery",
    {
      title: "Body Battery",
      description:
        "Daily Body Battery reports: charged, drained, feedback, and events (sleep, activities, stress) that changed it. Optionally the intraday level curve.",
      inputSchema: {
        ...rangeArgs,
        chunks: z
          .number()
          .int()
          .min(1)
          .max(96)
          .optional()
          .describe("Split each day into this many intervals and report the min/max level of each."),
        samples: samplesArg,
      },
      annotations: READ_ONLY,
    },
    async ({ start_date, end_date, chunks, samples }) =>
      run(async () => {
        const range = resolveRange(start_date, end_date, now());
        const parts = await chunked(range, MAX_DAYS.bodyBattery, (c) =>
          get("/wellness-service/wellness/bodyBattery/reports/daily", { startDate: c.start, endDate: c.end, chunks }),
        );
        return { range, days: concat(parts) };
      }, new Set(["bodyBatteryValuesArray"]), samples),
  );

  server.registerTool(
    "garmin_get_stress",
    {
      title: "Daily stress",
      description: "Daily stress levels (overall average, high, rest) for a date range.",
      inputSchema: rangeArgs,
      annotations: READ_ONLY,
    },
    async ({ start_date, end_date }) =>
      run(async () => {
        const range = resolveRange(start_date, end_date, now());
        const parts = await chunked(range, MAX_DAYS.stress, (c) =>
          get(`/usersummary-service/stats/stress/daily/${c.start}/${c.end}`),
        );
        return { range, days: concat(parts) };
      }),
  );

  server.registerTool(
    "garmin_get_steps",
    {
      title: "Daily steps",
      description: "Daily total steps, step goal and distance for a date range.",
      inputSchema: rangeArgs,
      annotations: READ_ONLY,
    },
    async ({ start_date, end_date }) =>
      run(async () => {
        const range = resolveRange(start_date, end_date, now());
        const parts = await chunked(range, MAX_DAYS.steps, (c) =>
          get(`/usersummary-service/stats/steps/daily/${c.start}/${c.end}`),
        );
        return { range, days: concat(parts) };
      }),
  );

  server.registerTool(
    "garmin_get_heart_rate",
    {
      title: "Daily heart rate",
      description:
        "Heart rate for one day: resting, min, max, 7-day resting average, abnormal HR alerts, and optionally the all-day heart rate curve ([timestamp_ms, bpm] pairs).",
      inputSchema: { date: dateArg("Calendar date"), samples: samplesArg },
      annotations: READ_ONLY,
    },
    async ({ date, samples }) =>
      run(
        () => get("/wellness-service/wellness/dailyHeartRate", { date: date ?? now() }),
        new Set(["heartRateValues", "abnormalHRValuesArray"]),
        samples,
      ),
  );

  server.registerTool(
    "garmin_get_spo2",
    {
      title: "Pulse ox (SpO2)",
      description:
        "Blood oxygen for one day: average, lowest, latest, 7-day average, average during sleep, altitude acclimation, and optionally the individual readings and hourly averages.",
      inputSchema: { date: dateArg("Calendar date"), samples: samplesArg },
      annotations: READ_ONLY,
    },
    async ({ date, samples }) =>
      run(
        () => get(`/wellness-service/wellness/daily/spo2acclimation/${date ?? now()}`),
        new Set(["spO2SingleValues", "spO2HourlyAverages", "monitoringEnvironmentValues"]),
        samples,
      ),
  );

  server.registerTool(
    "garmin_get_hydration",
    {
      title: "Hydration",
      description: "Daily water intake, goal and sweat loss for a date range.",
      inputSchema: rangeArgs,
      annotations: READ_ONLY,
    },
    async ({ start_date, end_date }) =>
      run(async () => {
        const range = resolveRange(start_date, end_date, now());
        const parts = await chunked(range, MAX_DAYS.hydration, (c) =>
          get(`/usersummary-service/stats/hydration/daily/${c.start}/${c.end}`),
        );
        return { range, days: concat(parts) };
      }),
  );

  // ---------------------------------------------------------------- body & nutrition

  server.registerTool(
    "garmin_get_weight",
    {
      title: "Weight and body composition",
      description:
        "Weigh-ins for a date range (weight in grams, BMI, body fat, muscle and bone mass, body water) with the range average, and optionally the user's weight goals.",
      inputSchema: {
        ...rangeArgs,
        all_entries: z.boolean().default(false).describe("Include every weigh-in, not just the latest of each day."),
        include_goals: z.boolean().default(false).describe("Also return the weight goals in effect for the range."),
      },
      annotations: READ_ONLY,
    },
    async ({ start_date, end_date, all_entries, include_goals }) =>
      run(async () => {
        const range = resolveRange(start_date, end_date, now());
        const weight = await get(`/weight-service/weight/range/${range.start}/${range.end}`, { includeAll: all_entries });
        if (!include_goals) return { range, weight };
        const goals = await get(`/goal-service/goal/user/effective/weightgoal/${range.start}/${range.end}`);
        return { range, weight, goals };
      }),
  );

  server.registerTool(
    "garmin_get_nutrition",
    {
      title: "Nutrition log",
      description:
        "Food logged in Garmin Connect for one day: calorie and macro goals, totals consumed, and meal-by-meal entries.",
      inputSchema: {
        date: dateArg("Calendar date"),
        meal_id: z.number().int().positive().optional().describe("Only this meal (e.g. breakfast, lunch, dinner, snacks)."),
      },
      annotations: READ_ONLY,
    },
    async ({ date, meal_id }) =>
      run(() => get(`/nutrition-service/food/logs/${date ?? now()}`, { includeMedia: false, mealId: meal_id })),
  );

  server.registerTool(
    "garmin_get_fitness_age",
    {
      title: "Fitness age",
      description:
        "Latest fitness age as of a date: chronological, fitness and achievable age, and the components behind it (BMI/body fat, resting HR, vigorous minutes).",
      inputSchema: { date: dateArg("As-of date") },
      annotations: READ_ONLY,
    },
    async ({ date }) => run(() => get(`/fitnessage-service/fitnessage/v2/${date ?? now()}`)),
  );

  server.registerTool(
    "garmin_get_menstrual_cycle",
    {
      title: "Menstrual cycle",
      description:
        "Women's health tracking. `summary` returns the cycle summary as of a date; `day` returns that day's logged symptoms, flow and mood, the cycle phase and predictions (and pregnancy data if tracked).",
      inputSchema: {
        date: dateArg("Calendar date"),
        view: z.enum(["summary", "day"]).default("summary"),
        include_analysis: z.boolean().default(false).describe("`day` view only: include cycle analysis."),
      },
      annotations: READ_ONLY,
    },
    async ({ date, view, include_analysis }) =>
      run(() => {
        const day = date ?? now();
        if (view === "summary") return get(`/periodichealth-service/menstrualcycle/summary/${day}`);
        return get(`/periodichealth-service/menstrualcycle/dayview/${day}`, {
          todayDate: now(),
          includeAnalysis: include_analysis,
        });
      }),
  );

  server.registerTool(
    "garmin_get_wellness_activities",
    {
      title: "Wellness activity summaries",
      description:
        "Summaries of wellness activities (e.g. auto-detected moves and breathwork/relaxation sessions) for a date range.",
      inputSchema: rangeArgs,
      annotations: READ_ONLY,
    },
    async ({ start_date, end_date }) =>
      run(async () => {
        const range = resolveRange(start_date, end_date, now());
        const parts = await chunked(range, MAX_DAYS.wellnessActivities, (c) =>
          get(`/wellnessactivity-service/activity/summary/range/${c.start}/${c.end}`),
        );
        return { range, activities: concat(parts) };
      }),
  );

  // ---------------------------------------------------------------- activities

  server.registerTool(
    "garmin_list_activities",
    {
      title: "List activities",
      description:
        "Search recorded activities (runs, rides, swims, strength, etc.), newest first. Returns ID, name, start time, distance (m), duration (s), speed (m/s), HR, power, cadence, training effect, training load and time in HR zones (s).",
      inputSchema: {
        ...rangeArgs,
        start_date: date.optional().describe("Earliest activity date, inclusive (YYYY-MM-DD)."),
        end_date: date.optional().describe("Latest activity date, inclusive (YYYY-MM-DD)."),
        activity_type: z
          .string()
          .optional()
          .describe("Parent type key, e.g. running, cycling, swimming, walking, hiking, fitness_equipment."),
        activity_subtype: z
          .string()
          .optional()
          .describe("Subtype key, e.g. trail_running, treadmill_running, road_cycling, indoor_cycling, lap_swimming, strength_training."),
        event_type: z.enum(["race", "training", "recreation", "fitness", "specialEvent", "uncategorized"]).optional(),
        search: z.string().optional().describe("Text to find in activity names and descriptions."),
        min_distance_m: z.number().int().min(0).optional(),
        max_distance_m: z.number().int().min(0).optional(),
        min_duration_s: z.number().int().min(0).optional(),
        max_duration_s: z.number().int().min(0).optional(),
        sort_by: z.string().optional().describe("Field to sort by, e.g. distance, duration. Defaults to start time."),
        sort_order: z.enum(["desc", "asc"]).default("desc"),
        offset: z.number().int().min(0).default(0).describe("Zero-based offset, for paging."),
        limit: z.number().int().min(1).max(50).default(20),
        detail: z
          .enum(["compact", "full"])
          .default("compact")
          .describe("`full` returns every field Garmin sends (power curve, fastest splits, dive data...)."),
      },
      annotations: READ_ONLY,
    },
    async (args) =>
      run(async () => {
        const activities = (await get("/activitylist-service/activities/search/activities", {
          start: args.offset,
          limit: args.limit,
          startDate: args.start_date,
          endDate: args.end_date,
          activityType: args.activity_type,
          activitySubType: args.activity_subtype,
          eventType: args.event_type,
          search: args.search,
          minDistance: args.min_distance_m,
          maxDistance: args.max_distance_m,
          minDuration: args.min_duration_s,
          maxDuration: args.max_duration_s,
          sortBy: args.sort_by,
          sortOrder: args.sort_order,
        })) as Record<string, unknown>[] | null;
        const list = activities ?? [];
        return {
          offset: args.offset,
          count: list.length,
          more_available: list.length === args.limit,
          activities: args.detail === "full" ? list : list.map(compactActivity),
        };
      }),
  );

  server.registerTool(
    "garmin_get_activity",
    {
      title: "Activity details",
      description:
        "Garmin's full summary of one activity: type, event type, time zone, device units, the summary metrics (pace, HR, power, cadence, running dynamics, training effect, load, stamina, RPE/feel) and split summaries. Optionally the structured workout that was followed.",
      inputSchema: {
        activity_id: activityId,
        include_workouts: z.boolean().default(false).describe("Also return the workout steps followed during the activity."),
      },
      annotations: READ_ONLY,
    },
    async ({ activity_id, include_workouts }) =>
      run(async () => {
        const activity = await get(`/activity-service/activity/${activity_id}`);
        if (!include_workouts) return activity;
        const workouts = await get(`/activity-service/activity/${activity_id}/workouts`);
        return { activity, workouts };
      }),
  );

  server.registerTool(
    "garmin_analyze_activity_file",
    {
      title: "Analyze activity FIT file",
      description:
        "Downloads the original FIT file of an activity and decodes it: session totals, every lap, workout steps, and a downsampled second-by-second stream (elapsed time, distance, heart rate, speed, power, cadence, altitude, running dynamics, optional GPS) in columnar form. Use for pacing, HR drift, interval and lap analysis.",
      inputSchema: {
        activity_id: activityId,
        max_points: z
          .number()
          .int()
          .min(0)
          .max(3000)
          .default(300)
          .describe("Stream points to return, evenly spaced over the activity. 0 skips the stream."),
        include_gps: z.boolean().default(false).describe("Add lat/lng columns to the stream."),
      },
      annotations: READ_ONLY,
    },
    async ({ activity_id, max_points, include_gps }) =>
      run(async () => {
        const files = extractActivityFiles(await downloadActivity(garmin, activity_id));
        const fit = findFitFile(files);
        if (!fit) {
          return `Activity ${activity_id} has no FIT file (found: ${files.map((f) => f.name).join(", ") || "nothing"}). It was probably uploaded as GPX/TCX or entered manually; use garmin_get_activity instead.`;
        }
        const analysis = analyzeFit(fit.bytes, { maxPoints: max_points, includeGps: include_gps });
        if (max_points === 0) delete analysis.stream;
        return { activity_id, file_name: fit.name, ...analysis };
      }),
  );

  // Writing files only makes sense when the server runs on the user's own machine.
  if (options.allowFileWrites) {
    server.registerTool(
      "garmin_download_activity_file",
      {
        title: "Download activity file",
        description:
          "Saves an activity's original file (a ZIP, usually holding a .fit) to a folder on this computer, for use in other tools such as GoldenCheetah or Runalyze. Existing files are never overwritten.",
        inputSchema: {
          activity_id: activityId,
          output_dir: z.string().optional().describe("Folder to save into. Defaults to ~/Downloads/garmin."),
          extract: z.boolean().default(true).describe("Also save the files inside the ZIP next to it."),
        },
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      },
      async ({ activity_id, output_dir, extract }) =>
        run(async () => {
          const dir = resolve(expandHome(output_dir ?? join(homedir(), "Downloads", "garmin")));
          await mkdir(dir, { recursive: true });
          const zip = await downloadActivity(garmin, activity_id);

          const toWrite = [{ name: `activity-${activity_id}.zip`, bytes: zip }];
          if (extract) {
            for (const file of extractActivityFiles(zip)) {
              // basename() keeps a hostile entry name like ../../x from leaving `dir`.
              // Garmin already names entries "<id>_ACTIVITY.fit"; prefix the ID only when missing.
              const name = basename(file.name);
              toWrite.push({ name: name.startsWith(String(activity_id)) ? name : `${activity_id}_${name}`, bytes: file.bytes });
            }
          }
          const saved: string[] = [];
          const skipped: string[] = [];
          for (const file of toWrite) {
            const path = join(dir, file.name);
            try {
              await writeFile(path, file.bytes, { flag: "wx" });
              saved.push(path);
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
              skipped.push(path);
            }
          }
          return { saved, already_existed: skipped.length ? skipped : undefined };
        }),
    );
  }

  // ---------------------------------------------------------------- escape hatch

  server.registerTool(
    "garmin_api_get",
    {
      title: "Raw Personal API GET",
      description:
        "Calls any Personal API GET endpoint directly and returns its JSON, for parameters the other tools don't expose. Paths are listed at https://developer.garmin.com/gc-developer-program/personal/swagger-docs/ (e.g. /weight-service/weight/all/2026-10-01/2026-10-25). Prefer the dedicated tools.",
      inputSchema: {
        path: z.string().describe("Path starting with '/', without the host or query string."),
        query: z
          .record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.array(z.string())]))
          .optional()
          .describe("Query parameters."),
      },
      annotations: READ_ONLY,
    },
    async ({ path, query }) => run(() => get(path, query)),
  );
}

/** Runs a tool body and turns its value or error into an MCP result. */
async function run(
  body: () => Promise<unknown> | unknown,
  sampleKeys?: ReadonlySet<string>,
  samples = 0,
): Promise<CallToolResult> {
  try {
    let value = await body();
    if (value === null || value === undefined) value = "Garmin returned no data for this request.";
    if (typeof value === "string") return { content: [{ type: "text", text: value }] };
    if (sampleKeys) value = limitSamples(value, sampleKeys, samples);
    return jsonResult(value);
  } catch (error) {
    return errorResult(error);
  }
}

function compactActivity(activity: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of COMPACT_ACTIVITY_FIELDS) {
    if (activity[field] !== null && activity[field] !== undefined) out[field] = activity[field];
  }
  out.activityType = (activity.activityType as { typeKey?: string } | undefined)?.typeKey;
  out.eventType = (activity.eventType as { typeKey?: string } | undefined)?.typeKey;
  return out;
}

async function downloadActivity(garmin: GarminClient, id: number): Promise<Uint8Array> {
  const zip = await garmin.getBytes(
    `/download-service/files/activity/${id}`,
    "application/zip, application/x-zip-compressed, application/octet-stream",
  );
  if (!zip.length) throw new GarminConfigError(`Garmin returned an empty file for activity ${id}.`);
  return zip;
}

function expandHome(path: string): string {
  return path === "~" || path.startsWith("~/") ? join(homedir(), path.slice(1)) : path;
}
