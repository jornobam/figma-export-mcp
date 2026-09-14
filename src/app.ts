import type { AppConfig } from "./config.js";
import { loadConfig } from "./config.js";
import type { FetchLike } from "./domain/types.js";
import { FigmaClient } from "./figma/client.js";
import { JobOrchestrator } from "./jobs/orchestrator.js";
import { createMcpServer, type Services } from "./mcp/server.js";
import { SnapshotService } from "./snapshot-service.js";
import { StateStore } from "./state/store.js";
import { YandexDiskClient } from "./yandex/client.js";

export async function createServices(
  config: AppConfig = loadConfig(),
  fetchImpl: FetchLike = fetch,
): Promise<Services> {
  const store = new StateStore(config.stateDir);
  await store.initialize();
  const figma = new FigmaClient(config, fetchImpl);
  const yandex = new YandexDiskClient(config, fetchImpl);
  const snapshots = new SnapshotService(figma, store);
  const jobs = new JobOrchestrator(config, store, figma, yandex);
  const services = { config, store, figma, yandex, snapshots, jobs };
  await jobs.resumePending();
  return services;
}

export async function createServer(config?: AppConfig, fetchImpl?: FetchLike) {
  return createMcpServer(await createServices(config, fetchImpl));
}
