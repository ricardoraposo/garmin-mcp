// Connects to the server like an MCP client would, lists the tools and calls
// each one once. Usage:
//   GARMIN_PERSONAL_API_KEY=... node scripts/smoke.ts [tool_name ...]       (spawns it over stdio)
//   MCP_URL=https://.../mcp GARMIN_PERSONAL_API_KEY=... node scripts/smoke.ts  (a running HTTP server)
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { fileURLToPath } from "node:url";

const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);

const calls: Record<string, (ctx: { activityId?: number }) => Record<string, unknown>> = {
  garmin_get_profile: () => ({}),
  garmin_get_heart_rate_zones: () => ({}),
  garmin_get_daily_summary: () => ({}),
  garmin_get_daily_summaries: () => ({ start_date: daysAgo(40), sections: ["heartRate", "stress"] }),
  garmin_get_sleep: () => ({}),
  garmin_get_hrv: () => ({ samples: 5 }),
  garmin_get_body_battery: () => ({ start_date: daysAgo(2) }),
  garmin_get_stress: () => ({ start_date: daysAgo(35) }),
  garmin_get_steps: () => ({ start_date: daysAgo(6) }),
  garmin_get_heart_rate: () => ({ samples: 10 }),
  garmin_get_spo2: () => ({}),
  garmin_get_hydration: () => ({ start_date: daysAgo(6) }),
  garmin_get_weight: () => ({ start_date: daysAgo(90), include_goals: true }),
  garmin_get_nutrition: () => ({}),
  garmin_get_fitness_age: () => ({}),
  garmin_get_menstrual_cycle: () => ({}),
  garmin_get_wellness_activities: () => ({ start_date: daysAgo(6) }),
  garmin_list_activities: () => ({ limit: 3 }),
  garmin_get_activity: ({ activityId }) => ({ activity_id: activityId, include_workouts: true }),
  garmin_analyze_activity_file: ({ activityId }) => ({ activity_id: activityId, max_points: 5 }),
  garmin_api_get: () => ({ path: "/userprofile-service/userprofile/settings" }),
};

const only = new Set(process.argv.slice(2));
const transport: Transport = process.env.MCP_URL
  ? new StreamableHTTPClientTransport(new URL(process.env.MCP_URL), {
      requestInit: { headers: { Authorization: `ApiKey ${process.env.GARMIN_PERSONAL_API_KEY ?? ""}` } },
    })
  : new StdioClientTransport({
      command: process.execPath,
      args: [fileURLToPath(new URL("../src/index.ts", import.meta.url))],
      env: process.env as Record<string, string>,
      stderr: "inherit",
    });
const client = new Client({ name: "garmin-mcp-smoke", version: "0.0.0" });
await client.connect(transport);

const { tools } = await client.listTools();
console.log(`${tools.length} tools: ${tools.map((t) => t.name).join(", ")}\n`);

const ctx: { activityId?: number } = {};
let failures = 0;
for (const [name, args] of Object.entries(calls)) {
  if (only.size && !only.has(name)) continue;
  const input = args(ctx);
  if ("activity_id" in input && input.activity_id === undefined) {
    console.log(`- ${name}: skipped (no activity found)`);
    continue;
  }
  const started = Date.now();
  const result = await client.callTool({ name, arguments: input });
  const text = (result.content as { type: string; text?: string }[]).map((c) => c.text ?? "").join("");
  if (result.isError) failures++;
  if (name === "garmin_list_activities" && !result.isError) {
    ctx.activityId = (JSON.parse(text) as { activities: { activityId?: number }[] }).activities[0]?.activityId;
  }
  const status = result.isError ? "ERROR" : "ok";
  console.log(`- ${name} [${status}, ${text.length} chars, ${Date.now() - started} ms]\n  ${text.slice(0, 300).replace(/\n/g, " ")}\n`);
}

await client.close();
process.exit(failures ? 1 : 0);
