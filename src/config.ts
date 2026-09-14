import os from "node:os";
import path from "node:path";
import * as z from "zod/v4";

const EnvSchema = z.object({
  FIGMA_TOKEN: z.string().optional(),
  YANDEX_DISK_TOKEN: z.string().optional(),
  FIGMA_EXPORT_STATE_DIR: z.string().optional(),
  YANDEX_DISK_ROOT: z.string().default("/AI Exports"),
  LOG_LEVEL: z.enum(["silent", "error", "warn", "info", "debug"]).default("info"),
  FIGMA_API_BASE_URL: z.string().url().default("https://api.figma.com"),
  YANDEX_DISK_API_BASE_URL: z.string().url().default("https://cloud-api.yandex.net/v1/disk"),
  FIGMA_EXPORT_CONCURRENCY: z.coerce.number().int().min(1).max(32).default(4),
  FIGMA_EXPORT_MAX_ITEMS: z.coerce.number().int().min(1).max(100_000).default(5_000),
  FIGMA_EXPORT_MAX_FILE_BYTES: z.coerce
    .number()
    .int()
    .positive()
    .default(100 * 1024 * 1024),
  FIGMA_EXPORT_MAX_TEMP_BYTES: z.coerce
    .number()
    .int()
    .positive()
    .default(10 * 1024 * 1024 * 1024),
  FIGMA_EXPORT_HTTP_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(300_000).default(30_000),
  FIGMA_EXPORT_ALLOW_PRIVATE_URLS: z.enum(["0", "1"]).default("0"),
});

function defaultStateDir(platform = process.platform): string {
  if (platform === "win32") {
    const base = process.env.LOCALAPPDATA ?? process.env.APPDATA ?? os.homedir();
    return path.join(base, "FigmaExportMCP", "state");
  }
  if (platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", "figma-export-mcp");
  }
  return path.join(
    process.env.XDG_STATE_HOME ?? path.join(os.homedir(), ".local", "state"),
    "figma-export-mcp",
  );
}

export type AppConfig = {
  figmaToken?: string;
  yandexToken?: string;
  stateDir: string;
  yandexRoot: string;
  logLevel: "silent" | "error" | "warn" | "info" | "debug";
  figmaApiBaseUrl: string;
  yandexApiBaseUrl: string;
  concurrency: number;
  maxItems: number;
  maxFileBytes: number;
  maxTempBytes: number;
  httpTimeoutMs: number;
  allowPrivateUrls: boolean;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = EnvSchema.parse(env);
  return {
    ...(parsed.FIGMA_TOKEN ? { figmaToken: parsed.FIGMA_TOKEN } : {}),
    ...(parsed.YANDEX_DISK_TOKEN ? { yandexToken: parsed.YANDEX_DISK_TOKEN } : {}),
    stateDir: parsed.FIGMA_EXPORT_STATE_DIR || defaultStateDir(),
    yandexRoot: parsed.YANDEX_DISK_ROOT,
    logLevel: parsed.LOG_LEVEL,
    figmaApiBaseUrl: parsed.FIGMA_API_BASE_URL.replace(/\/$/u, ""),
    yandexApiBaseUrl: parsed.YANDEX_DISK_API_BASE_URL.replace(/\/$/u, ""),
    concurrency: parsed.FIGMA_EXPORT_CONCURRENCY,
    maxItems: parsed.FIGMA_EXPORT_MAX_ITEMS,
    maxFileBytes: parsed.FIGMA_EXPORT_MAX_FILE_BYTES,
    maxTempBytes: parsed.FIGMA_EXPORT_MAX_TEMP_BYTES,
    httpTimeoutMs: parsed.FIGMA_EXPORT_HTTP_TIMEOUT_MS,
    allowPrivateUrls: parsed.FIGMA_EXPORT_ALLOW_PRIVATE_URLS === "1",
  };
}

export { defaultStateDir };
