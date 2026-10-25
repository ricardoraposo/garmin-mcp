#!/usr/bin/env node
import { parseArgs } from "node:util";

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { createHttpHandlerFromEnv, listen } from "./http.ts";
import { createGarminClient, createServer } from "./server.ts";

const { values } = parseArgs({
  options: {
    http: { type: "boolean", default: false },
    port: { type: "string", default: process.env.PORT ?? "8787" },
    host: { type: "string", default: process.env.HOST ?? "127.0.0.1" },
  },
});

if (values.http) {
  await listen(createHttpHandlerFromEnv(), Number(values.port), values.host);
  console.error(`garmin-mcp: listening on http://${values.host}:${values.port}/mcp`);
} else {
  // The key is only read on the first tool call, so the server starts (and lists
  // its tools) even before one is configured; the tool error explains the setup.
  await createServer(createGarminClient(), { allowFileWrites: true }).connect(new StdioServerTransport());
  console.error("garmin-mcp: running on stdio");
}
