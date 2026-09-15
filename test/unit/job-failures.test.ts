import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../../src/config.js";
import { CreateExportPlanInputSchema } from "../../src/domain/schemas.js";
import type { ExportJob } from "../../src/domain/types.js";
import { FigmaClient } from "../../src/figma/client.js";
import { normalizeFigmaFile } from "../../src/figma/snapshot.js";
import { JobOrchestrator } from "../../src/jobs/orchestrator.js";
import { compileExportPlan } from "../../src/plan/compiler.js";
import { StateStore } from "../../src/state/store.js";
import { YandexDiskClient } from "../../src/yandex/client.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function preparedZipJob() {
  const root = await mkdtemp(path.join(tmpdir(), "figma-export-job-failure-"));
  roots.push(root);
  const config = loadConfig({
    FIGMA_TOKEN: "figd_test",
    YANDEX_DISK_TOKEN: "y0_test",
    FIGMA_EXPORT_STATE_DIR: root,
    YANDEX_DISK_ROOT: "/AI Exports",
  });
  const store = new StateStore(root);
  await store.initialize();
  const snapshot = normalizeFigmaFile("abcdef123", {
    name: "Fixture",
    version: "42",
    components: {},
    document: {
      id: "0:0",
      type: "DOCUMENT",
      name: "Document",
      children: [
        {
          id: "1:0",
          type: "CANVAS",
          name: "Page",
          children: [
            {
              id: "2:1",
              type: "FRAME",
              name: "Card",
              visible: true,
              absoluteBoundingBox: { x: 0, y: 0, width: 100, height: 100 },
            },
          ],
        },
      ],
    },
  });
  const input = CreateExportPlanInputSchema.parse({
    snapshot_id: snapshot.id,
    selection: { type: { in: ["FRAME"] }, visible: true },
    export_target: { mode: "self" },
    export: { format: "png", scale: 1 },
    ordering: { mode: "row-major" },
    naming: { template: "{index}.png" },
    destination: { root: "/AI Exports", job_folder: "Failure" },
    packaging: { mode: "singleZip" },
  });
  const plan = compileExportPlan(snapshot, input, "/AI Exports", 100);
  expect(plan.archiveManifest).toHaveLength(1);
  plan.status = "running";
  await store.savePlan(plan);
  const now = new Date().toISOString();
  const job: ExportJob = {
    schemaVersion: 1,
    id: "job_deadbeef",
    planId: plan.id,
    planDigest: plan.digest,
    idempotencyKey: "failure-test",
    status: "queued",
    createdAt: now,
    updatedAt: now,
    workspaceName: "job_deadbeef",
    items: plan.manifest.map((item) => ({
      ...item,
      kind: "source",
      stage: "downloaded",
      attempts: 1,
      localRelativePath: path.join("items", `${item.id}.png`),
      localSize: 3,
      localSha256: "sha256:abc",
    })),
    events: [],
    cleanupComplete: false,
  };
  await store.saveJob(job);
  const jobs = new JobOrchestrator(
    config,
    store,
    new FigmaClient(config),
    new YandexDiskClient(config),
  );
  return { jobs, store, plan, job };
}

describe("background job failure persistence", () => {
  it("records a ZIP workspace preparation error on the archive and finishes the job", async () => {
    const { jobs, store, plan, job } = await preparedZipJob();
    await writeFile(store.workspacePath(job.workspaceName), "blocks mkdir");

    jobs.start(job.id);
    await jobs.wait(job.id);

    const saved = await store.getJob(job.id);
    const archive = saved.items.find((item) => item.kind === "archive");
    expect(saved.status).toBe("partial");
    expect(archive?.stage).toBe("failed");
    expect(archive?.error?.stage).toBe("packaging");
    expect(
      saved.events.some((event) => event.stage === "failed" && event.itemId === archive?.id),
    ).toBe(true);
    expect((jobs.status(saved).errors as unknown[]).length).toBe(1);
    expect((await store.getPlan(plan.id)).status).toBe("partial");
  });

  it("records unexpected run errors instead of leaving the job running", async () => {
    const { jobs, store, plan, job } = await preparedZipJob();
    vi.spyOn(store, "getPlan").mockRejectedValueOnce(new Error("synthetic startup failure"));

    jobs.start(job.id);
    await jobs.wait(job.id);

    const saved = await store.getJob(job.id);
    expect(saved.status).toBe("failed");
    expect(saved.runError?.code).toBe("INTERNAL_ERROR");
    expect(saved.events.at(-1)?.stage).toBe("failed");
    expect(jobs.status(saved).errors).toContainEqual(saved.runError);
    expect((await store.getPlan(plan.id)).status).toBe("failed");
  });
});
