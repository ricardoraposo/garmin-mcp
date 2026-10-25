import { GarminConfigError } from "./errors.ts";

const DAY_MS = 86_400_000;
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Today's calendar date in `timeZone` (IANA), or in the machine's local time zone. */
export function today(now: Date = new Date(), timeZone?: string): string {
  if (timeZone) {
    // en-CA formats dates as YYYY-MM-DD.
    return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
  }
  const local = new Date(now.getTime() - now.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 10);
}

export function isTimeZone(value: unknown): value is string {
  return typeof value === "string" && Intl.supportedValuesOf("timeZone").includes(value);
}

/** Validates a YYYY-MM-DD string and returns its UTC midnight in ms. */
export function parseDate(value: string, label = "date"): number {
  const match = ISO_DATE.exec(value);
  if (match) {
    const [, y, m, d] = match.map(Number) as [number, number, number, number];
    const ms = Date.UTC(y, m - 1, d);
    const back = new Date(ms);
    if (back.getUTCFullYear() === y && back.getUTCMonth() === m - 1 && back.getUTCDate() === d) return ms;
  }
  throw new GarminConfigError(`Invalid ${label} ${JSON.stringify(value)}; use YYYY-MM-DD.`);
}

export function formatDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export function addDays(date: string, days: number): string {
  return formatDate(parseDate(date) + days * DAY_MS);
}

/** Inclusive number of days in [start, end]. */
export function daysInRange(start: string, end: string): number {
  return Math.round((parseDate(end) - parseDate(start)) / DAY_MS) + 1;
}

export interface DateRange {
  start: string;
  end: string;
}

/** Fills in defaults (end = today, start = end) and checks start <= end. */
export function resolveRange(startDate?: string, endDate?: string, todayDate: string = today()): DateRange {
  const end = endDate ?? todayDate;
  const start = startDate ?? end;
  if (parseDate(start, "start_date") > parseDate(end, "end_date")) {
    throw new GarminConfigError(`start_date ${start} is after end_date ${end}.`);
  }
  return { start, end };
}

/** Splits an inclusive range into consecutive chunks of at most `maxDays` days. */
export function splitRange(range: DateRange, maxDays: number): DateRange[] {
  const chunks: DateRange[] = [];
  let start = range.start;
  while (parseDate(start) <= parseDate(range.end)) {
    const candidate = addDays(start, maxDays - 1);
    const end = parseDate(candidate) < parseDate(range.end) ? candidate : range.end;
    chunks.push({ start, end });
    start = addDays(end, 1);
  }
  return chunks;
}
