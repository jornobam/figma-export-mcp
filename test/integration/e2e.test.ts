import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config.js";
import { CreateExportPlanInputSchema } from "../../src/domain/schemas.js";
import { FigmaClient } from "../../src/figma/client.js";
import { normalizeFigmaFile } from "../../src/figma/snapshot.js";
import { JobOrchestrator } from "../../src/jobs/orchestrator.js";
import { compileExportPlan } from "../../src/plan/compiler.js";
import { StateStore } from "../../src/state/store.js";
import { YandexDiskClient } from "../../src/yandex/client.js";

const servers: Server[] = [];
const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function listen(
  handler: (request: IncomingMessage, response: ServerResponse) => void,
): Promise<string> {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(0, "127.0.0.1");
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("mock server did not bind");
  return `http://127.0.0.1:${address.port}`;
}

function figmaDocument() {
  return {
    id: "0:0",
    type: "DOCUMENT",
    name: "Document",
    children: [
      {
        id: "1:0",
        type: "CANVAS",
        name: "Cards",
        children: [
          {
            id: "2:1",
            type: "FRAME",
            name: "Card A",
            visible: true,
            absoluteBoundingBox: { x: 0, y: 0, width: 100, height: 100 },
            children: [
              {
                id: "2:1-1",
                type: "TEXT",
                name: "Text",
                characters: "RAL 6021",
                absoluteBoundingBox: { x: 1, y: 1, width: 50, height: 20 },
              },
            ],
          },
        ],
      },
    ],
  };
}

describe("mock-server end-to-end workflow", () => {
  it("inspects, plans, confirms, renders, uploads and verifies without real tokens", async (context) => {
    const uploaded = new Map<string, Uint8Array>();
    let figmaBase: string;
    try {
      figmaBase = await listen(async (request, response) => {
        const url = new URL(request.url ?? "/", "http://localhost");
        response.setHeader("content-type", "application/json");
        if (url.pathname === "/v1/me")
          return response.end(JSON.stringify({ email: "owner@example.com" }));
        if (url.pathname === "/v1/files/abcdef123")
          return response.end(
            JSON.stringify({
              name: "Fixture",
              version: "42",
              document: figmaDocument(),
              components: {},
            }),
          );
        if (url.pathname === "/v1/images/abcdef123")
          return response.end(JSON.stringify({ images: { "2:1": `${figmaBase}/render/2-1.png` } }));
        if (url.pathname === "/render/2-1.png") {
          response.setHeader("content-type", "image/png");
          return response.end(Buffer.from("png-fixture"));
        }
        response.statusCode = 404;
        return response.end(JSON.stringify({ error: "not found" }));
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EPERM") {
        context.skip();
        return;
      }
      throw error;
    }
    const yandexBase = await listen(async (request, response) => {
      const url = new URL(request.url ?? "/", "http://localhost");
      if (url.pathname === "/v1/disk/" && request.method === "GET")
        return response.end(JSON.stringify({ user: { login: "owner" } }));
      if (url.pathname === "/v1/disk/resources" && request.method === "PUT") {
        response.statusCode = 201;
        return response.end();
      }
      if (url.pathname === "/v1/disk/resources" && request.method === "GET") {
        const remotePath = url.searchParams.get("path") ?? "";
        const bytes = uploaded.get(remotePath);
        if (!bytes) {
          response.statusCode = 404;
          return response.end(JSON.stringify({ error: "DiskNotFoundError" }));
        }
        response.setHeader("content-type", "application/json");
        return response.end(
          JSON.stringify({
            type: "file",
            path: `disk:${remotePath}`,
            size: bytes.length,
            sha256: createHash("sha256").update(bytes).digest("hex"),
          }),
        );
      }
      if (url.pathname === "/v1/disk/resources/upload" && request.method === "GET") {
        const remotePath = url.searchParams.get("path") ?? "";
        response.setHeader("content-type", "application/json");
        return response.end(
          JSON.stringify({
            href: `${yandexBase}/upload?path=${encodeURIComponent(remotePath)}`,
            method: "PUT",
          }),
        );
      }
      if (url.pathname === "/upload" && request.method === "PUT") {
        const remotePath = new URL(request.url ?? "/", yandexBase).searchParams.get("path") ?? "";
        const chunks: Buffer[] = [];
        request.on("data", (chunk: Buffer) => chunks.push(chunk));
        request.on("end", () => {
          uploaded.set(remotePath, Buffer.concat(chunks));
          response.statusCode = 201;
          response.end();
        });
        return;
      }
      response.statusCode = 404;
      response.end();
    });
    const stateDir = await mkdtemp(path.join(tmpdir(), "figma-export-e2e-"));
    tempRoots.push(stateDir);
    const config = loadConfig({
      FIGMA_TOKEN: "figd_test",
      YANDEX_DISK_TOKEN: "y0_test",
      FIGMA_EXPORT_STATE_DIR: stateDir,
      FIGMA_API_BASE_URL: figmaBase,
      YANDEX_DISK_API_BASE_URL: `${yandexBase}/v1/disk`,
      FIGMA_EXPORT_ALLOW_PRIVATE_URLS: "1",
      YANDEX_DISK_ROOT: "/AI Exports",
      FIGMA_EXPORT_HTTP_TIMEOUT_MS: "5000",
    });
    const store = new StateStore(stateDir);
    await store.initialize();
    const figma = new FigmaClient(config);
    const yandex = new YandexDiskClient(config);
    const response = await figma.getFile("abcdef123");
    const snapshot = normalizeFigmaFile("abcdef123", response);
    await store.saveSnapshot(snapshot);
    const input = CreateExportPlanInputSchema.parse({
      snapshot_id: snapshot.id,
      selection: { type: { in: ["FRAME"] }, visible: true },
      export_target: { mode: "self" },
      export: { format: "png", scale: 1 },
      ordering: { mode: "row-major" },
      naming: { template: "{index}.png" },
      destination: { root: "/AI Exports", job_folder: "E2E" },
    });
    const plan = compileExportPlan(snapshot, input, "/AI Exports", 100);
    plan.status = "confirmed";
    plan.confirmedAt = new Date().toISOString();
    plan.confirmationSummary = "Explicitly confirmed E2E plan with one PNG and destination";
    await store.savePlan(plan);
    const jobs = new JobOrchestrator(config, store, figma, yandex);
    const job = await jobs.execute(plan, plan.digest, "e2e-idempotency-key");
    await jobs.wait(job.id);
    const result = jobs.status(await store.getJob(job.id));
    expect(result.status).toBe("completed");
    expect((result.totals as { verified: number }).verified).toBe(1);
    expect(uploaded.size).toBe(1);
    expect([...uploaded.values()][0]?.toString()).toBe("png-fixture");
  });
});
