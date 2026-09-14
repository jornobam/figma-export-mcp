import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

if (
  process.env.LIVE_SMOKE_CONFIRM !== "YES" ||
  !process.env.FIGMA_TOKEN ||
  !process.env.YANDEX_DISK_TOKEN ||
  !process.env.LIVE_FIGMA_URL
) {
  throw new Error(
    "Set LIVE_SMOKE_CONFIRM=YES, FIGMA_TOKEN, YANDEX_DISK_TOKEN and LIVE_FIGMA_URL. This smoke test only reads connections and the Figma file; it does not upload or delete remote data.",
  );
}
const stateDir = await mkdtemp(path.join(tmpdir(), "figma-export-mcp-live-"));
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [new URL("../dist/stdio.js", import.meta.url).pathname],
  env: { ...process.env, FIGMA_EXPORT_STATE_DIR: stateDir },
  stderr: "inherit",
});
const client = new Client({ name: "figma-export-live-smoke", version: "1.0.0" });
try {
  await client.connect(transport);
  const connections = await client.callTool({ name: "check_connections", arguments: {} });
  const inspection = await client.callTool({
    name: "inspect_figma_file",
    arguments: { figma_url: process.env.LIVE_FIGMA_URL },
  });
  if (connections.isError || inspection.isError)
    throw new Error("Live smoke failed; inspect the safe structured result above");
  process.stdout.write(
    "Live read-only smoke passed. No uploads or remote deletions were performed.\n",
  );
} finally {
  await client.close().catch(() => undefined);
  await rm(stateDir, { recursive: true, force: true });
}
