#!/usr/bin/env node
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { createServices } from "./app.js";
import { redactSecrets } from "./errors.js";
import { createMcpServer } from "./mcp/server.js";

const services = await createServices();
serveStdio(() => createMcpServer(services), {
  onerror(error) {
    process.stderr.write(`${redactSecrets(error.message)}\n`);
  },
});
// Some process supervisors unref an otherwise open pipe. Explicitly keep the STDIO
// entrypoint alive until its owner closes stdin; this is harmless in regular terminals.
process.stdin.resume();
