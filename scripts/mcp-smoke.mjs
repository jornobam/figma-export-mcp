import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { createServices } from "../dist/app.js";
import { loadConfig } from "../dist/config.js";
import { createMcpServer } from "../dist/mcp/server.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const entrypoint = await readFile(path.join(projectRoot, "dist", "stdio.js"), "utf8");
if (!entrypoint.startsWith("#!/usr/bin/env node") || !entrypoint.includes("serveStdio"))
  throw new Error("Built STDIO entrypoint is invalid");
const stateDir = await mkdtemp(path.join(tmpdir(), "figma-export-mcp-smoke-"));
const services = await createServices(
  loadConfig({ FIGMA_EXPORT_STATE_DIR: stateDir, LOG_LEVEL: "silent" }),
);
const server = createMcpServer(services);
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
const client = new Client({ name: "figma-export-mcp-smoke", version: "1.0.0" });
try {
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const instructions = client.getInstructions() ?? "";
  if (!instructions.startsWith("Before any bulk export"))
    throw new Error("Server instructions are missing");
  const { tools } = await client.listTools();
  const expected = [
    "check_connections",
    "inspect_figma_file",
    "analyze_figma_layout",
    "query_nodes",
    "create_export_plan",
    "preview_export_plan",
    "confirm_export_plan",
    "execute_export_plan",
    "get_export_status",
    "retry_failed_items",
    "verify_yandex_upload",
    "cleanup_job",
  ];
  for (const name of expected) {
    const tool = tools.find((entry) => entry.name === name);
    if (!tool?.inputSchema || !tool.outputSchema) throw new Error(`Tool schema missing: ${name}`);
  }
  const result = await client.callTool({ name: "check_connections", arguments: {} });
  if (result.isError || result.structuredContent?.ok !== true)
    throw new Error("check_connections failed");
  process.stdout.write(
    `MCP protocol/STDIO artifact smoke passed: ${tools.length} tools, instructions=${instructions.length} chars\n`,
  );
} finally {
  await client.close().catch(() => undefined);
  await server.close().catch(() => undefined);
  await rm(stateDir, { recursive: true, force: true });
}
