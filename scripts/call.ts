// Calls one tool through the MCP protocol and prints the result. Usage:
//   GARMIN_PERSONAL_API_KEY=... node scripts/call.ts garmin_get_sleep '{"start_date":"2026-10-01"}'
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";

const [name, json = "{}"] = process.argv.slice(2);
if (!name) {
  console.error("usage: node scripts/call.ts <tool_name> [json_arguments]");
  process.exit(2);
}

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [fileURLToPath(new URL("../src/index.ts", import.meta.url))],
  env: process.env as Record<string, string>,
});
const client = new Client({ name: "garmin-mcp-call", version: "0.0.0" });
await client.connect(transport);

const result = await client.callTool({ name, arguments: JSON.parse(json) });
const text = (result.content as { type: string; text?: string }[]).map((c) => c.text ?? "").join("");
console.log(result.isError ? `ERROR: ${text}` : text);

await client.close();
process.exit(result.isError ? 1 : 0);
