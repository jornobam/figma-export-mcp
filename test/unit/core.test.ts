import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config.js";
import { CreateExportPlanInputSchema } from "../../src/domain/schemas.js";
import type { Match } from "../../src/domain/types.js";
import { FigmaClient } from "../../src/figma/client.js";
import { normalizeFigmaFile } from "../../src/figma/snapshot.js";
import { normalizeNodeId, parseFigmaReference } from "../../src/figma/url.js";
import { JobOrchestrator } from "../../src/jobs/orchestrator.js";
import { createMcpServer, type Services } from "../../src/mcp/server.js";
import { createZip, createZipFile } from "../../src/packaging/zip.js";
import {
  compileExportPlan,
  isPlanDigestValid,
  orderMatches,
  previewPlan,
  selectedByPositions,
} from "../../src/plan/compiler.js";
import { matchesString, querySnapshot, safeRegex } from "../../src/selection/engine.js";
import { analyzeGeometry } from "../../src/selection/geometry.js";
import type { SnapshotService } from "../../src/snapshot-service.js";
import { StateStore } from "../../src/state/store.js";
import {
  canonicalJson,
  ensureCaseInsensitiveUnique,
  joinRemotePath,
  sanitizeSegment,
  sha256,
} from "../../src/util.js";
import type { YandexDiskClient } from "../../src/yandex/client.js";

function fixture() {
  const card = (id: string, x: number, y: number, name: string, text: string, visible = true) => ({
    id,
    type: "FRAME",
    name,
    visible,
    absoluteBoundingBox: { x, y, width: 100, height: 100 },
    children: [
      {
        id: `${id}-1`,
        type: "TEXT",
        name: "Metadata",
        characters: text,
        absoluteBoundingBox: { x: x + 4, y: y + 4, width: 80, height: 20 },
      },
    ],
  });
  return normalizeFigmaFile("abcdef123", {
    name: "Fixture",
    version: "42",
    document: {
      id: "0:0",
      type: "DOCUMENT",
      name: "Document",
      children: [
        {
          id: "1:0",
          type: "CANVAS",
          name: "Карточки",
          children: [
            {
              id: "2:0",
              type: "SECTION",
              name: "RAL 6021",
              children: [
                card("3:1", 0, 0, "Обложка", "RAL 6021\nАромат КЛУБНИКА\n0,9 л"),
                card("3:2", 110, 1, "Card", "RAL 6021\nАромат ЛИМОН\n2,5 л"),
                card("3:3", 220, 2, "Card", "RAL 6021\nАромат МЯТА\n0,9 л", false),
              ],
            },
            {
              id: "4:0",
              type: "SECTION",
              name: "RAL 6027",
              children: [card("4:1", 0, 120, "Обложка", "RAL 6027\nАромат КЛУБНИКА\n0,9 л")],
            },
          ],
        },
      ],
    },
  });
}

function layoutMatch(id: string, rowIndex: number, columnIndex: number): Match {
  const node = {
    id,
    type: "FRAME",
    name: id,
    childIds: [],
    hierarchyPath: [id],
    visible: true,
    descendantTexts: [],
    componentProperties: {},
    siblingIndex: columnIndex,
  };
  return {
    node,
    exportNode: node,
    reasons: [],
    variables: {},
    layout: { rowIndex, columnIndex, groupKey: "grid" },
    confidence: 1,
  };
}

function positionInput(positionSelection: Record<string, unknown>) {
  return CreateExportPlanInputSchema.parse({
    snapshot_id: "snap_fixture",
    selection: { type: { in: ["FRAME"] } },
    position_selection: positionSelection,
    ordering: { mode: "row-major" },
    destination: { job_folder: "Test" },
  });
}

describe("Figma URL and safe path primitives", () => {
  it("parses file and node IDs in both URL spellings", () => {
    expect(parseFigmaReference("https://www.figma.com/design/abcdef123/My?node-id=12-34")).toEqual({
      fileKey: "abcdef123",
      nodeId: "12:34",
    });
    expect(normalizeNodeId("12%3A34")).toBe("12:34");
  });

  it("sanitizes platform-reserved names and traversal", () => {
    expect(sanitizeSegment("CON. ")).toBe("_CON");
    expect(joinRemotePath("/AI Exports", "Русский", "a:b?.png")).toBe(
      "/AI Exports/Русский/a_b_.png",
    );
    expect(() => joinRemotePath("/root", "..", "secret")).toThrowError(
      /traversal|drive prefix|not allowed/iu,
    );
    expect(ensureCaseInsensitiveUnique(["A/Фото.png", "a/фото.png"]).length).toBe(1);
  });
});

describe("universal selector and geometry engine", () => {
  it("matches exact strings correctly in both case modes", () => {
    expect(matchesString("RAL 6021", { exact: "ral 6021", caseSensitive: false })).toBe(true);
    expect(matchesString("RAL 6021", { exact: "ral 6021", caseSensitive: true })).toBe(false);
    expect(matchesString(" RAL 6021 ", { exact: "RAL 6021", caseSensitive: false })).toBe(false);
  });

  it("supports descendant text, logical selectors, visibility and nearest ancestor", () => {
    const snapshot = fixture();
    const result = querySnapshot(
      snapshot,
      {
        all: [
          { type: { in: ["TEXT"] } },
          { visible: true },
          { descendantText: { regex: "RAL\\s*6021" } },
          { not: { name: { contains: "draft" } } },
        ],
      },
      { exportTarget: { mode: "nearestAncestor", where: { type: { in: ["FRAME"] } } } },
    );
    expect(result.matches).toHaveLength(2);
    expect(result.matches[0]?.exportNode.id).toBe("3:1");
    expect(result.matches[0]?.confidence).toBeGreaterThan(0.8);
  });

  it("clusters Y drift adaptively and partitions sections", () => {
    const snapshot = fixture();
    const nodes = Object.values(snapshot.nodes).filter((node) => node.type === "FRAME");
    const result = analyzeGeometry(nodes);
    expect(result.rows.length).toBeGreaterThanOrEqual(2);
    expect(result.toleranceY).toBeGreaterThan(1);
    expect(result.warnings.some((warning) => warning.includes("unequal"))).toBe(false);
    expect(result.layout.get("3:1")?.blockIndex).toBe(1);
    expect(result.layout.get("4:1")?.blockIndex).toBe(2);
    expect(result.layout.get("3:1")?.dimensionsSimilarToPeers).toBe(true);
    expect(result.layout.get("4:1")?.dimensionsSimilarToPeers).toBe(false);
  });

  it("numbers rows locally without allowing child text to shift parent frames", () => {
    const result = querySnapshot(fixture(), {
      type: { in: ["FRAME"] },
      rowIndex: 1,
      visible: true,
    });
    expect(result.matches.map((match) => match.exportNode.id)).toEqual(["3:1", "3:2", "4:1"]);
    expect(result.layout.layout.get("3:1")?.rowIndex).toBe(1);
    expect(result.layout.layout.get("3:1")?.groupKey).toBe("2:0");
    expect(
      result.layout.rows
        .flatMap((row) => row.nodeIds)
        .every((id) => id.startsWith("3:") || id.startsWith("4:")),
    ).toBe(true);
  });

  it("evaluates blockIndex and dimensionsSimilarToPeers selectors", () => {
    const snapshot = fixture();
    const result = querySnapshot(snapshot, {
      type: { in: ["FRAME"] },
      blockIndex: 1,
      dimensionsSimilarToPeers: true,
    });
    expect(result.matches.map((match) => match.exportNode.id)).toEqual(["3:1", "3:2"]);
  });

  it("rejects unsafe regex constructs", () => {
    expect(() => safeRegex("(a+)+")).toThrowError(/unsafe|complex/iu);
    expect(safeRegex("RAL\\s*\\d{4}", "iu")).toBeInstanceOf(RegExp);
  });

  it("applies perGroupLimit independently and supports rowRules", () => {
    const matches = [1, 2].flatMap((row) =>
      [1, 2, 3].map((column) => layoutMatch(`r${row}c${column}`, row, column)),
    );
    const limited = selectedByPositions(
      matches,
      positionInput({ layout: "rows", columns: [2, 3], perGroupLimit: 1 }),
      [],
      [],
    );
    expect(limited.map((match) => match.exportNode.id)).toEqual(["r1c2", "r2c2"]);

    const ruled = selectedByPositions(
      matches,
      positionInput({
        layout: "rows",
        rowRules: [
          { rows: [1], positions: { explicitIndexes: [3] } },
          { rows: [2], positions: { first: 1 } },
        ],
      }),
      [],
      [],
    );
    expect(ruled.map((match) => match.exportNode.id)).toEqual(["r1c3", "r2c1"]);
  });

  it("keeps equal local row indexes in separate visual blocks", () => {
    const first = layoutMatch("block-1-row-1", 1, 1);
    first.layout = { ...first.layout, blockIndex: 1, groupKey: "block-1" };
    const second = layoutMatch("block-2-row-1", 1, 1);
    second.layout = { ...second.layout, blockIndex: 2, groupKey: "block-2" };
    const selected = selectedByPositions(
      [first, second],
      positionInput({ layout: "rows", rows: [1], columns: [1], perGroupLimit: 1 }),
      [],
      [],
    );
    expect(selected.map((match) => match.exportNode.id)).toEqual([
      "block-1-row-1",
      "block-2-row-1",
    ]);
  });

  it("transposes grouping when position layout is columns", () => {
    const matches = [1, 2].flatMap((row) =>
      [1, 2, 3].map((column) => layoutMatch(`r${row}c${column}`, row, column)),
    );
    const selected = selectedByPositions(
      matches,
      positionInput({ layout: "columns", explicitIndexes: [2] }),
      [],
      [],
    );
    expect(selected.map((match) => match.exportNode.id)).toEqual(["r2c1", "r2c2", "r2c3"]);
  });

  it("resolves positionPriority last separately for unequal rows", () => {
    const matches = [
      layoutMatch("r1c1", 1, 1),
      layoutMatch("r1c2", 1, 2),
      layoutMatch("r1c3", 1, 3),
      layoutMatch("r2c1", 2, 1),
      layoutMatch("r2c2", 2, 2),
    ];
    const input = CreateExportPlanInputSchema.parse({
      snapshot_id: "snap_fixture",
      selection: { type: { in: ["FRAME"] } },
      ordering: { mode: "position", positionPriority: ["last", 1] },
      destination: { job_folder: "Test" },
    });
    expect(orderMatches(matches, input).map((match) => match.exportNode.id)).toEqual([
      "r1c3",
      "r2c2",
      "r1c1",
      "r2c1",
      "r1c2",
    ]);
  });

  it("honors declared tie breakers instead of applying implicit hierarchy order", () => {
    const left = layoutMatch("node-b", 1, 1);
    const right = layoutMatch("node-a", 1, 1);
    left.exportNode.hierarchyPath = ["A"];
    right.exportNode.hierarchyPath = ["B"];
    const byNodeId = CreateExportPlanInputSchema.parse({
      snapshot_id: "snap_fixture",
      ordering: { mode: "hierarchy", tieBreakers: ["nodeId"] },
      destination: { job_folder: "Test" },
    });
    expect(orderMatches([left, right], byNodeId).map((match) => match.exportNode.id)).toEqual([
      "node-a",
      "node-b",
    ]);
  });
});

describe("connection checks", () => {
  it("does not call /v1/me or require current_user:read for a Figma readiness check", async () => {
    let fetchCalls = 0;
    const config = loadConfig({ FIGMA_TOKEN: "figd_file_content_only" });
    const figma = new FigmaClient(config, async () => {
      fetchCalls += 1;
      throw new Error("network must not be used");
    });
    await expect(figma.checkConnection()).resolves.toEqual({
      configured: true,
      reachable: null,
      verification: "deferred_until_file_inspection",
    });
    expect(fetchCalls).toBe(0);
  });

  it("uses mutually exclusive PAT and OAuth request headers", async () => {
    const seen: Headers[] = [];
    const mockFetch = async (_input: string | URL | Request, init?: RequestInit) => {
      seen.push(new Headers(init?.headers));
      return new Response(JSON.stringify({ name: "Fixture", version: "42", document: {} }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };
    const pat = new FigmaClient(
      loadConfig({ FIGMA_AUTH_MODE: "pat", FIGMA_TOKEN: "pat_test" }),
      mockFetch,
    );
    const oauth = new FigmaClient(
      loadConfig({
        FIGMA_AUTH_MODE: "oauth",
        FIGMA_TOKEN: "ignored_pat",
        FIGMA_OAUTH_ACCESS_TOKEN: "oauth_test",
      }),
      mockFetch,
    );
    await pat.getFile("abcdef123");
    await oauth.getFile("abcdef123");
    expect(seen[0]?.get("X-Figma-Token")).toBe("pat_test");
    expect(seen[0]?.has("Authorization")).toBe(false);
    expect(seen[1]?.get("Authorization")).toBe("Bearer oauth_test");
    expect(seen[1]?.has("X-Figma-Token")).toBe(false);
  });
});

describe("safe Yandex collision handling", () => {
  it("blocks archive collisions through the actual MCP confirmation tool", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "figma-export-mcp-archive-confirm-"));
    const store = new StateStore(root);
    await store.initialize();
    const snapshot = fixture();
    const plan = compileExportPlan(
      snapshot,
      CreateExportPlanInputSchema.parse({
        snapshot_id: snapshot.id,
        selection: { id: "3:1" },
        naming: { template: "Job.zip" },
        destination: { root: "/AI Exports", job_folder: "Job" },
        packaging: { mode: "filesAndZip" },
      }),
      "/AI Exports",
      100,
    );
    await store.savePlan(plan);
    const services = {
      config: loadConfig({ FIGMA_EXPORT_STATE_DIR: root }),
      store,
      figma: { getCurrentVersion: async () => "42" } as unknown as FigmaClient,
      yandex: {} as YandexDiskClient,
      snapshots: {} as SnapshotService,
      jobs: {} as JobOrchestrator,
    } satisfies Services;
    const server = createMcpServer(services);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "archive-collision-test", version: "1.0.0" });
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const result = await client.callTool({
        name: "confirm_export_plan",
        arguments: {
          plan_id: plan.id,
          digest: plan.digest,
          confirmation_summary: "Approve this exact export plan after preview",
        },
      });
      expect(result.isError).toBe(true);
      expect((result.structuredContent as { error?: { code?: string } })?.error?.code).toBe(
        "PLAN_HAS_UNRESOLVED_CLARIFICATIONS",
      );
      expect((await store.getPlan(plan.id)).status).toBe("draft");
    } finally {
      await client.close().catch(() => undefined);
      await server.close().catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects a tampered confirmed plan with archive collisions before any export", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "figma-export-archive-collision-"));
    try {
      const store = new StateStore(root);
      await store.initialize();
      const snapshot = fixture();
      const input = CreateExportPlanInputSchema.parse({
        snapshot_id: snapshot.id,
        selection: { id: "3:1" },
        naming: { template: "Job.zip" },
        destination: { root: "/AI Exports", job_folder: "Job" },
        packaging: { mode: "filesAndZip" },
      });
      const plan = compileExportPlan(snapshot, input, "/AI Exports", 100);
      plan.status = "confirmed";
      let metadataCalls = 0;
      let renderCalls = 0;
      const figma = {
        getCurrentVersion: async () => "42",
        renderImages: async () => {
          renderCalls += 1;
          return {};
        },
      } as unknown as FigmaClient;
      const yandex = {
        getMetadata: async () => {
          metadataCalls += 1;
          return null;
        },
      } as unknown as YandexDiskClient;
      const jobs = new JobOrchestrator(
        loadConfig({ FIGMA_EXPORT_STATE_DIR: root }),
        store,
        figma,
        yandex,
      );
      await expect(jobs.execute(plan, plan.digest, "archive-collision-1")).rejects.toThrow(
        /image and archive paths collide/iu,
      );
      expect(metadataCalls).toBe(0);
      expect(renderCalls).toBe(0);
      expect(await store.listJobs()).toHaveLength(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("preflights collision_policy error before rendering or creating a job", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "figma-export-preflight-"));
    try {
      const store = new StateStore(root);
      await store.initialize();
      const snapshot = fixture();
      const input = CreateExportPlanInputSchema.parse({
        snapshot_id: snapshot.id,
        selection: { id: "3:1" },
        ordering: { mode: "row-major" },
        destination: { root: "/AI Exports", job_folder: "Collision" },
        collision_policy: "error",
      });
      const plan = compileExportPlan(snapshot, input, "/AI Exports", 100);
      plan.status = "confirmed";
      let renderCalls = 0;
      const figma = {
        getCurrentVersion: async () => "42",
        renderImages: async () => {
          renderCalls += 1;
          return {};
        },
      } as unknown as FigmaClient;
      const yandex = {
        getMetadata: async () => ({ type: "file", size: 3 }),
      } as unknown as YandexDiskClient;
      const jobs = new JobOrchestrator(
        loadConfig({ FIGMA_EXPORT_STATE_DIR: root }),
        store,
        figma,
        yandex,
      );
      await expect(jobs.execute(plan, plan.digest, "preflight-1")).rejects.toThrow(
        /destination path.*already exist/iu,
      );
      expect(renderCalls).toBe(0);
      expect(await store.listJobs()).toHaveLength(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("never treats same-size remote data without a checksum as identical", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "figma-export-checksum-"));
    try {
      const store = new StateStore(root);
      await store.initialize();
      const snapshot = fixture();
      const input = CreateExportPlanInputSchema.parse({
        snapshot_id: snapshot.id,
        selection: { id: "3:1" },
        ordering: { mode: "row-major" },
        destination: { root: "/AI Exports", job_folder: "Checksum" },
        collision_policy: "skip_identical",
      });
      const plan = compileExportPlan(snapshot, input, "/AI Exports", 100);
      plan.status = "confirmed";
      await store.savePlan(plan);
      let uploadCalls = 0;
      const figma = {
        getCurrentVersion: async () => "42",
        renderImages: async (_fileKey: string, ids: string[]) =>
          Object.fromEntries(ids.map((id) => [id, `https://example.com/${id}`])),
        downloadRendered: async () => new TextEncoder().encode("abc"),
      } as unknown as FigmaClient;
      const yandex = {
        getMetadata: async (remotePath: string) => ({
          type: "file",
          size: 3,
          path: `disk:${remotePath}`,
        }),
        upload: async () => {
          uploadCalls += 1;
        },
      } as unknown as YandexDiskClient;
      const jobs = new JobOrchestrator(
        loadConfig({ FIGMA_EXPORT_STATE_DIR: root }),
        store,
        figma,
        yandex,
      );
      const job = await jobs.execute(plan, plan.digest, "checksum-1");
      await jobs.wait(job.id);
      const finished = await store.getJob(job.id);
      expect(finished.items[0]?.error?.code).toBe("YANDEX_CHECKSUM_UNAVAILABLE");
      expect(uploadCalls).toBe(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("persists verified state before deleting the local checkpoint", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "figma-export-checkpoint-"));
    try {
      const store = new StateStore(root);
      await store.initialize();
      const savedStages: string[] = [];
      const saveJob = store.saveJob.bind(store);
      store.saveJob = async (job) => {
        savedStages.push(job.items[0]?.stage ?? "none");
        await saveJob(job);
      };
      const snapshot = fixture();
      const input = CreateExportPlanInputSchema.parse({
        snapshot_id: snapshot.id,
        selection: { id: "3:1" },
        destination: { root: "/AI Exports", job_folder: "Checkpoint" },
        collision_policy: "skip_identical",
      });
      const plan = compileExportPlan(snapshot, input, "/AI Exports", 100);
      plan.status = "confirmed";
      await store.savePlan(plan);
      const figma = {
        getCurrentVersion: async () => "42",
        renderImages: async (_fileKey: string, ids: string[]) =>
          Object.fromEntries(ids.map((id) => [id, `https://example.com/${id}`])),
        downloadRendered: async () => new TextEncoder().encode("abc"),
      } as unknown as FigmaClient;
      const yandex = {
        getMetadata: async () => null,
        uploadFile: async () => undefined,
        verify: async () => ({ type: "file", size: 3 }),
      } as unknown as YandexDiskClient;
      const jobs = new JobOrchestrator(
        loadConfig({ FIGMA_EXPORT_STATE_DIR: root }),
        store,
        figma,
        yandex,
      );
      const job = await jobs.execute(plan, plan.digest, "checkpoint-1");
      await jobs.wait(job.id);
      expect(savedStages.indexOf("verified")).toBeGreaterThan(-1);
      expect(savedStages.indexOf("verified")).toBeLessThan(savedStages.indexOf("cleaned"));
      expect((await store.getJob(job.id)).status).toBe("completed");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("immutable plans, variables and ZIP", () => {
  it("materializes filesAndZip image/archive path collisions before confirmation", () => {
    const snapshot = fixture();
    const input = CreateExportPlanInputSchema.parse({
      snapshot_id: snapshot.id,
      selection: { id: "3:1" },
      naming: { template: "Job.zip" },
      destination: { root: "/AI Exports", job_folder: "Job" },
      packaging: { mode: "filesAndZip" },
    });
    const plan = compileExportPlan(snapshot, input, "/AI Exports", 100);
    expect(plan.manifest[0]?.remotePath).toBe("/AI Exports/Job/Job.zip");
    expect(plan.archiveManifest[0]?.remotePath).toBe(plan.manifest[0]?.remotePath);
    expect(plan.collisions).toHaveLength(1);
    expect(plan.collisions[0]?.itemIds).toEqual([
      plan.manifest[0]?.id,
      plan.archiveManifest[0]?.id,
    ]);
    expect(
      plan.clarifications.some((item) => item.code === "PATH_COLLISIONS" && item.blocking),
    ).toBe(true);
    const preview = previewPlan(plan, 0, 10);
    expect(preview.archive_count).toBe(1);
    expect(preview.output_count).toBe(2);
    expect((preview.manifest as Array<{ kind: string }>).map((item) => item.kind)).toEqual([
      "source",
      "archive",
    ]);
    expect(isPlanDigestValid(plan)).toBe(true);
    if (plan.archiveManifest[0]) plan.archiveManifest[0].remotePath = "/AI Exports/Job/other.zip";
    expect(isPlanDigestValid(plan)).toBe(false);
  });

  it("detects zipPerGroup archive collisions after safe-name sanitization", () => {
    const snapshot = fixture();
    const first = snapshot.nodes["3:1"];
    const second = snapshot.nodes["3:2"];
    if (!first || !second) throw new Error("fixture nodes missing");
    first.name = "A:B";
    second.name = "A?B";
    const input = CreateExportPlanInputSchema.parse({
      snapshot_id: snapshot.id,
      selection: { id: ["3:1", "3:2"] },
      variables: { group: { from: "name" } },
      destination: { root: "/AI Exports", job_folder: "Job" },
      packaging: { mode: "zipPerGroup", archive_groups_by: ["group"] },
    });
    const plan = compileExportPlan(snapshot, input, "/AI Exports", 100);
    expect(plan.archiveManifest).toHaveLength(2);
    expect(plan.archiveManifest.map((item) => item.remotePath)).toEqual([
      "/AI Exports/Job/A_B.zip",
      "/AI Exports/Job/A_B.zip",
    ]);
    expect(plan.archiveManifest[0]?.groupKey).not.toBe(plan.archiveManifest[1]?.groupKey);
    expect(plan.collisions).toHaveLength(1);
    expect(plan.collisions[0]?.itemIds).toEqual(plan.archiveManifest.map((item) => item.id));
    const preview = previewPlan(plan, 2, 10);
    expect((preview.manifest as Array<{ kind: string }>).map((item) => item.kind)).toEqual([
      "archive",
      "archive",
    ]);
  });
  it("extracts variables, positions, Unicode names and collisions before execution", () => {
    const snapshot = fixture();
    const input = CreateExportPlanInputSchema.parse({
      snapshot_id: snapshot.id,
      selection: { type: { in: ["FRAME"] }, visible: true },
      export_target: { mode: "self" },
      position_selection: { columns: [1, 3], missingPositionPolicy: "clarify" },
      export: { format: "png", scale: 1 },
      ordering: { mode: "row-major" },
      variables: {
        ral: { from: "descendantText", regex: "RAL\\s*(?<value>\\d{4})", required: true },
        aroma: { from: "descendantText", regex: "Аромат\\s+(?<value>[^\\n]+)", required: true },
      },
      grouping: { folders: ["RAL {ral}"] },
      naming: { template: "{aroma}.png" },
      destination: { root: "/AI Exports", job_folder: "Тест" },
      expected: { exact_count: null, required_values: {}, fail_on_missing_required_value: true },
    });
    const plan = compileExportPlan(snapshot, input, "/AI Exports", 100);
    expect(plan.manifest).toHaveLength(2);
    expect(plan.manifest[0]?.remotePath).toContain("/AI Exports/Тест/RAL 6021/");
    expect(plan.digest).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(plan.collisions).toHaveLength(0);
    const changed = compileExportPlan(
      snapshot,
      { ...input, naming: { ...input.naming, template: "{ral}_{aroma}.png" } },
      "/AI Exports",
      100,
    );
    expect(changed.digest).not.toBe(plan.digest);
  });

  it("applies a stable source-version suffix to the entire versioned job", () => {
    const snapshot = fixture();
    const input = CreateExportPlanInputSchema.parse({
      snapshot_id: snapshot.id,
      selection: { type: { in: ["FRAME"] }, visible: true },
      ordering: { mode: "row-major" },
      naming: { template: "{index}.{ext}" },
      destination: { root: "/AI Exports", job_folder: "Versioned" },
      collision_policy: "version",
    });
    const plan = compileExportPlan(snapshot, input, "/AI Exports", 100);
    expect(plan.manifest.length).toBeGreaterThan(1);
    expect(plan.manifest.every((item) => item.remotePath.includes("/Versioned--v-42/"))).toBe(true);
  });

  it("preserves or collapses naming whitespace according to the public option", () => {
    const snapshot = fixture();
    const makePlan = (whitespace: "preserve" | "collapse") =>
      compileExportPlan(
        snapshot,
        CreateExportPlanInputSchema.parse({
          snapshot_id: snapshot.id,
          selection: { id: "3:1" },
          naming: { template: "A  B.png", whitespace },
          destination: { root: "/AI Exports", job_folder: "Whitespace" },
        }),
        "/AI Exports",
        100,
      );
    expect(makePlan("preserve").manifest[0]?.remotePath).toContain("/A  B.png");
    expect(makePlan("collapse").manifest[0]?.remotePath).toContain("/A B.png");
  });

  it("restarts row-scoped sequences in every local visual block", () => {
    const snapshot = fixture();
    const plan = compileExportPlan(
      snapshot,
      CreateExportPlanInputSchema.parse({
        snapshot_id: snapshot.id,
        selection: { type: { in: ["FRAME"] }, visible: true },
        variables: { sequence: { from: "sequence", scope: "row", start: 1 } },
        naming: { template: "{sequence}-{index}.png" },
        ordering: { mode: "row-major" },
        destination: { root: "/AI Exports", job_folder: "Sequence" },
      }),
      "/AI Exports",
      100,
    );
    expect(plan.manifest.map((item) => item.variables.sequence)).toEqual(["1", "2", "1"]);
  });

  it("writes a valid deterministic ZIP and persists state atomically", async () => {
    const zip = createZip([
      { name: "Русский/hello.txt", bytes: new TextEncoder().encode("hello") },
    ]);
    expect(Buffer.from(zip).readUInt32LE(0)).toBe(0x04034b50);
    expect(Buffer.from(zip).readUInt32LE(zip.length - 22)).toBe(0x06054b50);
    const root = await mkdtemp(path.join(tmpdir(), "figma-export-state-"));
    try {
      const store = new StateStore(root);
      await store.initialize();
      const snapshot = fixture();
      await store.saveSnapshot(snapshot);
      expect((await store.getSnapshot(snapshot.id)).version).toBe("42");
      expect(canonicalJson({ b: 1, a: [2, 1] })).toBe('{"a":[2,1],"b":1}');
      expect(sha256("x")).toMatch(/^sha256:/u);
      expect(
        await readFile(path.join(root, "snapshots", `${snapshot.id}.json`), "utf8"),
      ).not.toContain("figd_");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("writes ZIP64 archives to disk through a bounded-memory stream", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "figma-export-stream-zip-"));
    try {
      const source = path.join(root, "source.bin");
      const destination = path.join(root, "archive.zip");
      const duplicate = path.join(root, "archive-copy.zip");
      const rejected = path.join(root, "too-large.zip");
      await writeFile(source, Buffer.alloc(2 * 1024 * 1024, 0x5a));
      const result = await createZipFile(
        [{ name: "large/source.bin", path: source }],
        destination,
        4 * 1024 * 1024,
      );
      const bytes = await readFile(destination);
      expect(bytes.readUInt32LE(0)).toBe(0x04034b50);
      expect(result.size).toBe(bytes.byteLength);
      expect(result.sha256).toBe(sha256(bytes));
      expect(bytes.includes(Buffer.from("PK\u0006\u0006", "binary"))).toBe(true);
      const duplicateResult = await createZipFile(
        [{ name: "large/source.bin", path: source }],
        duplicate,
        4 * 1024 * 1024,
      );
      expect(duplicateResult.sha256).toBe(result.sha256);
      await expect(
        createZipFile([{ name: "large/source.bin", path: source }], rejected, 1024),
      ).rejects.toThrow(/temporary storage limit/iu);
      await expect(readFile(rejected)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("configuration", () => {
  it("uses portable defaults and never requires secrets", () => {
    const config = loadConfig({});
    expect(path.isAbsolute(config.stateDir)).toBe(true);
    expect(config.stateDir.toLocaleLowerCase("en").replaceAll(/[^a-z]/gu, "")).toContain(
      "figmaexportmcp",
    );
    expect(config.figmaToken).toBeUndefined();
    expect(config.yandexToken).toBeUndefined();
  });
});
