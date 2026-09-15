import * as z from "zod/v4";
import type { Selector } from "./types.js";

const safeFlags = z
  .string()
  .regex(/^[gimsuy]*$/u)
  .refine((value) => new Set(value).size === value.length, "Duplicate regular expression flag")
  .default("iu");

export const StringMatcherSchema = z
  .object({
    exact: z.string().max(2_000).optional(),
    contains: z.string().max(2_000).optional(),
    normalizedExact: z.string().max(2_000).optional(),
    regex: z.string().min(1).max(500).optional(),
    flags: safeFlags.optional(),
    oneOf: z.array(z.string().max(2_000)).max(1_000).optional(),
    caseSensitive: z.boolean().default(false),
  })
  .refine(
    (value) =>
      [value.exact, value.contains, value.normalizedExact, value.regex, value.oneOf].filter(
        (item) => item !== undefined,
      ).length === 1,
    "Exactly one string operation is required",
  );

export const NumberRangeSchema = z
  .object({
    min: z.number().finite().nonnegative().optional(),
    max: z.number().finite().positive().optional(),
  })
  .refine((value) => value.min !== undefined || value.max !== undefined, "Range cannot be empty")
  .refine(
    (value) => value.min === undefined || value.max === undefined || value.min <= value.max,
    "Range minimum must not exceed maximum",
  );

export const SelectorSchema: z.ZodType<Selector> = z.lazy(() =>
  z
    .object({
      id: z.union([z.string(), z.array(z.string()).min(1)]).optional(),
      type: z.object({ in: z.array(z.string()).min(1) }).optional(),
      name: StringMatcherSchema.optional(),
      text: StringMatcherSchema.optional(),
      descendantText: StringMatcherSchema.optional(),
      page: StringMatcherSchema.optional(),
      section: StringMatcherSchema.optional(),
      hierarchyPath: StringMatcherSchema.optional(),
      componentName: StringMatcherSchema.optional(),
      componentProperties: z.record(z.string(), StringMatcherSchema).optional(),
      visible: z.boolean().optional(),
      width: NumberRangeSchema.optional(),
      height: NumberRangeSchema.optional(),
      aspectRatio: NumberRangeSchema.optional(),
      rowIndex: z.union([z.int().positive(), z.array(z.int().positive()).min(1)]).optional(),
      columnIndex: z.union([z.int().positive(), z.array(z.int().positive()).min(1)]).optional(),
      blockIndex: z.union([z.int().positive(), z.array(z.int().positive()).min(1)]).optional(),
      siblingIndex: z
        .union([z.int().nonnegative(), z.array(z.int().nonnegative()).min(1)])
        .optional(),
      includeIds: z.array(z.string()).max(10_000).optional(),
      excludeIds: z.array(z.string()).max(10_000).optional(),
      dimensionsSimilarToPeers: z.boolean().optional(),
      all: z.array(SelectorSchema).min(1).optional(),
      any: z.array(SelectorSchema).min(1).optional(),
      not: SelectorSchema.optional(),
    })
    .strict(),
);

export const ExportTargetSchema = z
  .object({
    mode: z
      .enum(["self", "parent", "nearestAncestor", "ancestorAtDepth", "explicitIdMap"])
      .default("self"),
    where: SelectorSchema.optional(),
    maxDepth: z.int().min(1).max(100).default(8),
    depth: z.int().min(1).max(100).optional(),
    idMap: z.record(z.string(), z.string()).optional(),
  })
  .default({ mode: "self", maxDepth: 8 });

const rowRuleSchema = z.object({
  rows: z.union([z.literal("all"), z.array(z.int().positive()).min(1)]).default("all"),
  positions: z
    .object({
      first: z.int().positive().optional(),
      last: z.int().positive().optional(),
      explicitIndexes: z.array(z.int().positive()).optional(),
      range: z.object({ from: z.int().positive(), to: z.int().positive() }).optional(),
      everyNth: z.int().positive().optional(),
    })
    .optional(),
});

export const PositionSelectionSchema = z
  .object({
    layout: z.enum(["rows", "columns"]).default("rows"),
    rows: z.union([z.literal("all"), z.array(z.int().positive()).min(1)]).default("all"),
    columns: z.array(z.int().positive()).optional(),
    first: z.int().positive().optional(),
    last: z.int().positive().optional(),
    range: z.object({ from: z.int().positive(), to: z.int().positive() }).optional(),
    everyNth: z.int().positive().optional(),
    explicitIndexes: z.array(z.int().positive()).optional(),
    perGroupLimit: z.int().positive().optional(),
    rowRules: z.array(rowRuleSchema).optional(),
    missingPositionPolicy: z
      .enum(["clarify", "skip", "fail", "complete-rows-only"])
      .default("clarify"),
    indexBase: z.literal(1).default(1),
  })
  .optional();

export const OrderingSchema = z
  .object({
    mode: z.enum([
      "hierarchy",
      "row-major",
      "column-major",
      "position",
      "extractedVariable",
      "custom",
    ]),
    rowDirection: z.enum(["top-to-bottom", "bottom-to-top"]).default("top-to-bottom"),
    itemDirection: z.enum(["left-to-right", "right-to-left"]).default("left-to-right"),
    variables: z.array(z.string()).optional(),
    customNodeIds: z.array(z.string()).optional(),
    positionPriority: z.array(z.union([z.int().positive(), z.literal("last")])).optional(),
    tieBreakers: z
      .array(z.enum(["hierarchyPath", "nodeId"]).or(z.string()))
      .default(["hierarchyPath", "nodeId"]),
  })
  .default({
    mode: "hierarchy",
    rowDirection: "top-to-bottom",
    itemDirection: "left-to-right",
    tieBreakers: ["hierarchyPath", "nodeId"],
  });

export const VariableRuleSchema = z.object({
  from: z.enum([
    "name",
    "text",
    "descendantText",
    "hierarchyPath",
    "page",
    "section",
    "sequence",
    "rowIndex",
    "columnIndex",
  ]),
  regex: z.string().min(1).max(500).optional(),
  flags: safeFlags.optional(),
  capture: z.string().default("value"),
  required: z.boolean().default(false),
  lookup: z.record(z.string(), z.string()).optional(),
  normalize: z
    .object({
      trim: z.boolean().default(true),
      collapseWhitespace: z.boolean().default(true),
      decimalSeparator: z.enum([".", ","]).optional(),
      case: z.enum(["preserve", "lower", "upper"]).default("preserve"),
    })
    .default({ trim: true, collapseWhitespace: true, case: "preserve" }),
  scope: z.enum(["global", "group", "row"]).default("global"),
  start: z.int().default(1),
  pad: z.int().min(0).max(12).default(0),
});

export const CreateExportPlanInputSchema = z
  .object({
    snapshot_id: z.string().min(1),
    selection: SelectorSchema.default({}),
    export_target: ExportTargetSchema,
    position_selection: PositionSelectionSchema,
    export: z
      .object({
        format: z.enum(["png", "jpg", "svg", "pdf"]).default("png"),
        scale: z.number().min(0.01).max(4).default(1),
        contents_only: z.boolean().default(true),
        use_absolute_bounds: z.boolean().default(false),
      })
      .default({ format: "png", scale: 1, contents_only: true, use_absolute_bounds: false }),
    ordering: OrderingSchema,
    variables: z.record(z.string(), VariableRuleSchema).default({}),
    grouping: z
      .object({ folders: z.array(z.string()).max(20).default([]) })
      .default({ folders: [] }),
    naming: z
      .object({
        template: z.string().min(1).default("{index}.{ext}"),
        unicode: z.literal("preserve").default("preserve"),
        whitespace: z.enum(["preserve", "collapse"]).default("collapse"),
        max_segment_length: z.int().min(16).max(240).default(120),
      })
      .default({
        template: "{index}.{ext}",
        unicode: "preserve",
        whitespace: "collapse",
        max_segment_length: 120,
      }),
    destination: z.object({
      provider: z.literal("yandex-disk").default("yandex-disk"),
      root: z.string().default("/AI Exports"),
      job_folder: z.string().min(1),
    }),
    packaging: z
      .object({
        mode: z.enum(["folders", "singleZip", "zipPerGroup", "filesAndZip"]).default("folders"),
        archive_groups_by: z.array(z.string()).default([]),
      })
      .default({ mode: "folders", archive_groups_by: [] }),
    collision_policy: z.enum(["error", "version", "skip_identical"]).default("error"),
    expected: z
      .object({
        exact_count: z.int().nonnegative().nullable().default(null),
        required_values: z.record(z.string(), z.array(z.string())).default({}),
        fail_on_missing_required_value: z.boolean().default(true),
        override_missing_required_values: z.boolean().default(false),
      })
      .default({
        exact_count: null,
        required_values: {},
        fail_on_missing_required_value: true,
        override_missing_required_values: false,
      }),
  })
  .strict();

export type CreateExportPlanInput = z.infer<typeof CreateExportPlanInputSchema>;

export const InspectInputSchema = z.object({
  figma_url: z.string().url().optional(),
  file_key: z.string().min(6).optional(),
  node_id: z.string().optional(),
  scope: z
    .object({
      page_names: z.array(z.string()).default([]),
      node_ids: z.array(z.string()).default([]),
    })
    .default({ page_names: [], node_ids: [] }),
  refresh: z.boolean().default(false),
});

export const QueryInputSchema = z.object({
  snapshot_id: z.string(),
  selector: SelectorSchema.default({}),
  order: OrderingSchema,
  page_size: z.int().min(1).max(500).default(100),
  cursor: z.string().nullable().default(null),
});

export const AnalyzeInputSchema = z.object({
  snapshot_id: z.string(),
  selector: SelectorSchema.default({}),
  tolerance: z.number().min(0.05).max(2).default(0.35),
  expected_columns: z.int().positive().optional(),
  expected_items_per_row: z.int().positive().optional(),
  global: z.boolean().default(false),
});

export const SCHEMA_VERSION = "1.0" as const;

export const ManifestItemSchema = z.object({
  id: z.string(),
  ordinal: z.int().positive(),
  nodeId: z.string(),
  matchedNodeId: z.string(),
  hierarchyPath: z.array(z.string()),
  rowIndex: z.int().positive().optional(),
  columnIndex: z.int().positive().optional(),
  variables: z.record(z.string(), z.string()),
  remotePath: z.string(),
  reasons: z.array(z.string()),
  confidence: z.number().min(0).max(1),
});

export const ExportPlanSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string().startsWith("plan_"),
  digest: z.string().startsWith("sha256:"),
  status: z.enum(["draft", "confirmed", "running", "completed", "partial", "failed"]),
  createdAt: z.iso.datetime(),
  snapshotId: z.string().startsWith("snap_"),
  source: z.object({ fileKey: z.string(), version: z.string() }),
  input: CreateExportPlanInputSchema,
  manifest: z.array(ManifestItemSchema),
  archiveManifest: z
    .array(
      z.object({
        id: z.string().startsWith("item_"),
        ordinal: z.int().positive(),
        groupKey: z.string(),
        groupLabel: z.string(),
        remotePath: z.string(),
        entries: z.array(z.object({ itemId: z.string().startsWith("item_"), name: z.string() })),
      }),
    )
    .default([]),
  warnings: z.array(z.string()),
  clarifications: z.array(
    z.object({
      code: z.string(),
      message: z.string(),
      blocking: z.boolean(),
      affectedCount: z.int().nonnegative().optional(),
      options: z.array(z.string()).optional(),
    }),
  ),
  collisions: z.array(z.object({ path: z.string(), itemIds: z.array(z.string()) })),
  confirmedAt: z.iso.datetime().optional(),
  confirmationSummary: z.string().optional(),
});
