import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config.js";
import { CreateExportPlanInputSchema } from "../../src/domain/schemas.js";
import { normalizeFigmaFile } from "../../src/figma/snapshot.js";
import { normalizeNodeId, parseFigmaReference } from "../../src/figma/url.js";
import { createZip } from "../../src/packaging/zip.js";
import { compileExportPlan } from "../../src/plan/compiler.js";
import { querySnapshot, safeRegex } from "../../src/selection/engine.js";
import { analyzeGeometry } from "../../src/selection/geometry.js";
import { StateStore } from "../../src/state/store.js";
import {
  canonicalJson,
  ensureCaseInsensitiveUnique,
  joinRemotePath,
  sanitizeSegment,
  sha256,
} from "../../src/util.js";

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
    expect(result.warnings.some((warning) => warning.includes("unequal"))).toBe(true);
  });

  it("rejects unsafe regex constructs", () => {
    expect(() => safeRegex("(a+)+")).toThrowError(/unsafe|complex/iu);
    expect(safeRegex("RAL\\s*\\d{4}", "iu")).toBeInstanceOf(RegExp);
  });
});

describe("immutable plans, variables and ZIP", () => {
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
});

describe("configuration", () => {
  it("uses portable defaults and never requires secrets", () => {
    const config = loadConfig({});
    expect(config.stateDir).toContain("figma-export-mcp");
    expect(config.figmaToken).toBeUndefined();
    expect(config.yandexToken).toBeUndefined();
  });
});
