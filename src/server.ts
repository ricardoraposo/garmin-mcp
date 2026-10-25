import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { TokenProvider } from "./auth.ts";
import { baseUrl } from "./config.ts";
import { GarminClient } from "./garmin-client.ts";
import { registerTools, SERVER_INSTRUCTIONS, type ToolOptions } from "./tools.ts";

/** Local client: the key comes from the environment or the key file. */
export function createGarminClient(): GarminClient {
  const url = baseUrl();
  return new GarminClient({ baseUrl: url, tokens: new TokenProvider({ baseUrl: url }) });
}

export function createServer(garmin: GarminClient, options: ToolOptions): McpServer {
  const server = new McpServer(
    { name: "garmin-mcp", title: "Garmin Connect", version: "0.3.0" },
    { instructions: SERVER_INSTRUCTIONS },
  );
  registerTools(server, garmin, options);
  return server;
}
