import { McpServer, ResourceTemplate } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import type { AppConfig } from "../config.js";
import {
  AnalyzeInputSchema,
  CreateExportPlanInputSchema,
  InspectInputSchema,
  QueryInputSchema,
  SCHEMA_VERSION,
} from "../domain/schemas.js";
import type { SafeError } from "../domain/types.js";
import { appError, toSafeError } from "../errors.js";
import type { FigmaClient } from "../figma/client.js";
import type { JobOrchestrator } from "../jobs/orchestrator.js";
import { compileExportPlan, previewPlan } from "../plan/compiler.js";
import { querySnapshot } from "../selection/engine.js";
import type { SnapshotService } from "../snapshot-service.js";
import type { StateStore } from "../state/store.js";
import { makeCursor, parseCursor } from "../util.js";
import type { YandexDiskClient } from "../yandex/client.js";

export const SERVER_INSTRUCTIONS = `Before any bulk export, inspect the Figma file, create a draft export plan, resolve every material ambiguity with the user, preview the exact count/order/naming/destination, and obtain explicit user confirmation. Never call confirm_export_plan or execute_export_plan based on assumptions. Figma is read-only. Upload to Yandex Disk, verify every object, and delete temporary files only after verification. Resume partial jobs instead of duplicating files.

Required workflow: call check_connections, inspect_figma_file, then analyze_figma_layout/query_nodes. Ask concise questions for every ambiguity that could change selection, export target, order, names, folders, collision behavior, format, scale, or publication. create_export_plan always creates an immutable draft. Show its current digest, count, order, naming examples, destination, collisions, warnings, and clarifications via preview_export_plan. Only an explicit user approval given after that preview authorizes confirm_export_plan with the exact digest and a truthful confirmation_summary. Execute only a confirmed unchanged digest. If the Figma version changed, create a new preview. Poll get_export_status; retry only retryable failures and never duplicate verified items. cleanup_job is safe automatically only after every expected remote object is verified. This server never edits Figma and never creates public links.`;

type Services = {
  config: AppConfig;
  store: StateStore;
  figma: FigmaClient;
  yandex: YandexDiskClient;
  snapshots: SnapshotService;
  jobs: JobOrchestrator;
};

const OutputSchema = z.looseObject({
  schema_version: z.literal(SCHEMA_VERSION),
  ok: z.boolean(),
  error: z
    .object({
      code: z.string(),
      stage: z.string(),
      retryable: z.boolean(),
      safeMessage: z.string(),
    })
    .loose()
    .optional(),
});

function success(data: Record<string, unknown>) {
  const structuredContent = { schema_version: SCHEMA_VERSION, ok: true, ...data };
  return {
    content: [{ type: "text" as const, text: JSON.stringify(structuredContent) }],
    structuredContent,
  };
}

function failure(error: unknown) {
  const safe: SafeError = toSafeError(error, "tool");
  const structuredContent = { schema_version: SCHEMA_VERSION, ok: false, error: safe };
  return {
    content: [{ type: "text" as const, text: JSON.stringify(structuredContent) }],
    structuredContent,
    isError: true,
  };
}

async function guarded(fn: () => Promise<Record<string, unknown>>) {
  try {
    return success(await fn());
  } catch (error) {
    return failure(error);
  }
}

function snapshotSummary(
  snapshot: Awaited<ReturnType<StateStore["getSnapshot"]>>,
): Record<string, unknown> {
  const nodes = Object.values(snapshot.nodes);
  const typeCounts = Object.fromEntries(
    [...new Set(nodes.map((node) => node.type))]
      .sort()
      .map((type) => [type, nodes.filter((node) => node.type === type).length]),
  );
  return {
    snapshot_id: snapshot.id,
    file_key: snapshot.fileKey,
    file_name: snapshot.fileName,
    version: snapshot.version,
    node_count: nodes.length,
    pages: nodes.filter((node) => node.type === "CANVAS").map((node) => node.name),
    type_counts: typeCounts,
    top_level_names: nodes
      .filter((node) => node.hierarchyPath.length <= 3)
      .slice(0, 100)
      .map((node) => node.name),
    resource_uri: `figma-export://snapshots/${snapshot.id}/summary`,
  };
}

export function createMcpServer(services: Services): McpServer {
  const server = new McpServer(
    { name: "figma-export-mcp", version: "1.0.0" },
    { instructions: SERVER_INSTRUCTIONS },
  );

  server.registerTool(
    "check_connections",
    {
      title: "Check Figma, Yandex Disk and state-store readiness",
      description:
        "Checks configuration and safe reachability where possible without requiring extra scopes or returning secrets.",
      inputSchema: z.object({}),
      outputSchema: OutputSchema,
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    () =>
      guarded(async () => {
        const warnings: string[] = [];
        const figma = {
          configured: Boolean(services.config.figmaToken),
          reachable: null as boolean | null,
          verification: "not_configured",
        };
        const yandex = {
          configured: Boolean(services.config.yandexToken),
          reachable: false as boolean,
          root: services.config.yandexRoot,
          identity_hint: undefined as string | undefined,
        };
        if (figma.configured) {
          try {
            const result = await services.figma.checkConnection();
            figma.reachable = result.reachable;
            figma.verification = result.verification;
          } catch (error) {
            warnings.push(toSafeError(error).safeMessage);
          }
        } else warnings.push("FIGMA_TOKEN is not configured");
        if (yandex.configured) {
          try {
            const result = await services.yandex.checkConnection();
            yandex.reachable = true;
            yandex.identity_hint = result.identityHint;
          } catch (error) {
            warnings.push(toSafeError(error).safeMessage);
          }
        } else warnings.push("YANDEX_DISK_TOKEN is not configured");
        return {
          figma,
          yandex_disk: yandex,
          state_store: { writable: await services.store.isWritable() },
          warnings,
        };
      }),
  );

  server.registerTool(
    "inspect_figma_file",
    {
      title: "Inspect a Figma file",
      description:
        "Creates or reuses a versioned normalized read-only snapshot and returns a compact summary.",
      inputSchema: InspectInputSchema.refine(
        (value) => value.figma_url || value.file_key,
        "figma_url or file_key is required",
      ),
      outputSchema: OutputSchema,
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    (input) => guarded(async () => snapshotSummary(await services.snapshots.inspect(input))),
  );

  server.registerTool(
    "analyze_figma_layout",
    {
      title: "Analyze Figma layout",
      description:
        "Detects adaptive row/column geometry and reports heuristic evidence, confidence, anomalies and samples.",
      inputSchema: AnalyzeInputSchema,
      outputSchema: OutputSchema,
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    (input) =>
      guarded(async () => {
        const snapshot = await services.store.getSnapshot(input.snapshot_id);
        const result = querySnapshot(snapshot, input.selector, {
          toleranceFactor: input.tolerance,
          global: input.global,
        });
        const warnings = [...result.warnings];
        if (input.expected_columns && result.layout.columns.length !== input.expected_columns)
          warnings.push(
            `Expected ${input.expected_columns} columns; detected ${result.layout.columns.length}`,
          );
        if (
          input.expected_items_per_row &&
          result.layout.rows.some((row) => row.nodeIds.length !== input.expected_items_per_row)
        )
          warnings.push("One or more rows differ from expected_items_per_row");
        return {
          snapshot_id: snapshot.id,
          candidate_count: result.matches.length,
          rows: result.layout.rows.slice(0, 200),
          columns: result.layout.columns.slice(0, 200),
          tolerance: { x: result.layout.toleranceX, y: result.layout.toleranceY },
          confidence:
            result.matches.length && !warnings.length ? 0.95 : result.matches.length ? 0.75 : 0,
          explanation:
            "Candidates are partitioned by parent/section, clustered by center coordinates, and sorted with stable node-ID tie breakers.",
          representative_node_ids: result.matches.slice(0, 10).map((item) => item.exportNode.id),
          warnings,
        };
      }),
  );

  server.registerTool(
    "query_nodes",
    {
      title: "Query normalized Figma nodes",
      description:
        "Applies declarative logical selectors without rendering and returns a paginated evidence set.",
      inputSchema: QueryInputSchema,
      outputSchema: OutputSchema,
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    (input) =>
      guarded(async () => {
        const snapshot = await services.store.getSnapshot(input.snapshot_id);
        const result = querySnapshot(snapshot, input.selector);
        const offset = parseCursor(input.cursor);
        const ordered = result.matches.sort((a, b) => {
          if (input.order.mode === "row-major")
            return (
              (a.layout.rowIndex ?? 0) - (b.layout.rowIndex ?? 0) ||
              (a.layout.columnIndex ?? 0) - (b.layout.columnIndex ?? 0) ||
              a.exportNode.id.localeCompare(b.exportNode.id, "en")
            );
          if (input.order.mode === "column-major")
            return (
              (a.layout.columnIndex ?? 0) - (b.layout.columnIndex ?? 0) ||
              (a.layout.rowIndex ?? 0) - (b.layout.rowIndex ?? 0) ||
              a.exportNode.id.localeCompare(b.exportNode.id, "en")
            );
          return (
            a.exportNode.hierarchyPath
              .join("/")
              .localeCompare(b.exportNode.hierarchyPath.join("/"), "und", { numeric: true }) ||
            a.exportNode.id.localeCompare(b.exportNode.id, "en")
          );
        });
        const page = ordered.slice(offset, offset + input.page_size);
        return {
          snapshot_id: snapshot.id,
          total_count: ordered.length,
          matches: page.map((match) => ({
            node_id: match.node.id,
            export_node_id: match.exportNode.id,
            name: match.exportNode.name,
            type: match.exportNode.type,
            hierarchy_path: match.exportNode.hierarchyPath,
            row_index: match.layout.rowIndex,
            column_index: match.layout.columnIndex,
            variables: match.variables,
            reasons: match.reasons,
            confidence: match.confidence,
          })),
          next_cursor: makeCursor(offset + page.length, ordered.length),
          warnings: result.warnings,
        };
      }),
  );

  server.registerTool(
    "create_export_plan",
    {
      title: "Create immutable draft export plan",
      description:
        "Materializes selection, ordering, variables, names and paths. Never renders or uploads.",
      inputSchema: CreateExportPlanInputSchema,
      outputSchema: OutputSchema,
      annotations: { readOnlyHint: false, idempotentHint: false },
    },
    (input) =>
      guarded(async () => {
        const snapshot = await services.store.getSnapshot(input.snapshot_id);
        const plan = compileExportPlan(
          snapshot,
          input,
          services.config.yandexRoot,
          services.config.maxItems,
        );
        await services.store.savePlan(plan);
        const preview = previewPlan(plan, 0, 20);
        return {
          ...preview,
          manifest: undefined,
          manifest_resource: `figma-export://plans/${plan.id}/manifest?page=1&page_size=100`,
        };
      }),
  );

  server.registerTool(
    "preview_export_plan",
    {
      title: "Preview exact export plan",
      description:
        "Returns stable count/order/naming/destination/warnings plus a page of the manifest without bulk render.",
      inputSchema: z.object({
        plan_id: z.string(),
        page_size: z.int().min(1).max(500).default(100),
        cursor: z.string().nullable().default(null),
      }),
      outputSchema: OutputSchema,
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    (input) =>
      guarded(async () =>
        previewPlan(
          await services.store.getPlan(input.plan_id),
          parseCursor(input.cursor),
          input.page_size,
        ),
      ),
  );

  server.registerTool(
    "confirm_export_plan",
    {
      title: "Confirm a previewed export plan",
      description:
        "Unlocks only the exact digest after explicit user approval; rejects unresolved clarifications and changed Figma versions.",
      inputSchema: z.object({
        plan_id: z.string(),
        digest: z.string().startsWith("sha256:"),
        confirmation_summary: z.string().min(20).max(2_000),
      }),
      outputSchema: OutputSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    (input) =>
      guarded(async () => {
        const plan = await services.store.getPlan(input.plan_id);
        if (plan.digest !== input.digest)
          throw appError(
            "PLAN_DIGEST_MISMATCH",
            "confirmation",
            "Plan digest does not match the preview",
          );
        if (plan.status !== "draft" && plan.status !== "confirmed")
          throw appError(
            "PLAN_STATE_INVALID",
            "confirmation",
            `Plan in state ${plan.status} cannot be confirmed`,
          );
        if (plan.clarifications.some((item) => item.blocking) || plan.collisions.length)
          throw appError(
            "PLAN_HAS_UNRESOLVED_CLARIFICATIONS",
            "confirmation",
            "Plan has unresolved blocking clarifications or collisions",
          );
        const currentVersion = await services.figma.getCurrentVersion(plan.source.fileKey);
        if (currentVersion !== plan.source.version)
          throw appError(
            "FIGMA_VERSION_CHANGED",
            "confirmation",
            "Figma file changed after preview; create a new plan",
          );
        plan.status = "confirmed";
        plan.confirmedAt = new Date().toISOString();
        plan.confirmationSummary = input.confirmation_summary;
        await services.store.savePlan(plan);
        return {
          plan_id: plan.id,
          digest: plan.digest,
          status: plan.status,
          confirmed_at: plan.confirmedAt,
        };
      }),
  );

  server.registerTool(
    "execute_export_plan",
    {
      title: "Execute confirmed export plan",
      description:
        "Starts an idempotent background export/upload/verify job and quickly returns its job ID.",
      inputSchema: z.object({
        plan_id: z.string(),
        digest: z.string().startsWith("sha256:"),
        idempotency_key: z.string().min(8).max(200),
      }),
      outputSchema: OutputSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    (input) =>
      guarded(async () => {
        const job = await services.jobs.execute(
          await services.store.getPlan(input.plan_id),
          input.digest,
          input.idempotency_key,
        );
        return {
          job_id: job.id,
          plan_id: job.planId,
          status: job.status,
          status_resource: `figma-export://jobs/${job.id}/report`,
        };
      }),
  );

  server.registerTool(
    "get_export_status",
    {
      title: "Get export job status",
      description:
        "Returns stage totals, safe errors, retry state, verified paths and paginated events.",
      inputSchema: z.object({
        job_id: z.string(),
        event_cursor: z.string().nullable().default(null),
        event_page_size: z.int().min(1).max(500).default(100),
      }),
      outputSchema: OutputSchema,
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    (input) =>
      guarded(async () => {
        const job = await services.store.getJob(input.job_id);
        const offset = parseCursor(input.event_cursor);
        const events = job.events.slice(offset, offset + input.event_page_size);
        return {
          ...services.jobs.status(job),
          events,
          next_event_cursor: makeCursor(offset + events.length, job.events.length),
        };
      }),
  );

  server.registerTool(
    "retry_failed_items",
    {
      title: "Retry failed export items",
      description: "Retries only failed/retryable items and never reuploads verified items.",
      inputSchema: z.object({ job_id: z.string(), idempotency_key: z.string().min(8).max(200) }),
      outputSchema: OutputSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    (input) =>
      guarded(async () => ({
        ...services.jobs.status(await services.jobs.retry(input.job_id, input.idempotency_key)),
      })),
  );

  server.registerTool(
    "verify_yandex_upload",
    {
      title: "Verify Yandex Disk upload",
      description: "Rechecks every expected path, size and comparable checksum without uploading.",
      inputSchema: z.object({ job_id: z.string() }),
      outputSchema: OutputSchema,
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    (input) =>
      guarded(async () => ({
        job_id: input.job_id,
        ...(await services.jobs.verify(input.job_id)),
      })),
  );

  server.registerTool(
    "cleanup_job",
    {
      title: "Clean local job workspace",
      description:
        "Deletes local temporary data only after verification, or after explicit risk confirmation for incomplete jobs.",
      inputSchema: z.object({
        job_id: z.string(),
        confirm_partial_cleanup: z.boolean().default(false),
      }),
      outputSchema: OutputSchema,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    },
    (input) =>
      guarded(async () => ({
        ...services.jobs.status(
          await services.jobs.cleanup(input.job_id, input.confirm_partial_cleanup),
        ),
      })),
  );

  server.registerResource(
    "snapshot-summary",
    new ResourceTemplate("figma-export://snapshots/{snapshot_id}/summary", { list: undefined }),
    { title: "Figma snapshot summary", mimeType: "application/json" },
    async (uri, variables) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: "application/json",
          text: JSON.stringify(
            snapshotSummary(await services.store.getSnapshot(String(variables.snapshot_id))),
          ),
        },
      ],
    }),
  );
  server.registerResource(
    "plan-manifest",
    new ResourceTemplate("figma-export://plans/{plan_id}/manifest{?page,page_size}", {
      list: undefined,
    }),
    { title: "Paginated export plan manifest", mimeType: "application/json" },
    async (uri, variables) => {
      const plan = await services.store.getPlan(String(variables.plan_id));
      const page = Math.max(1, Number(variables.page ?? 1));
      const pageSize = Math.min(500, Math.max(1, Number(variables.page_size ?? 100)));
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "application/json",
            text: JSON.stringify(previewPlan(plan, (page - 1) * pageSize, pageSize)),
          },
        ],
      };
    },
  );
  server.registerResource(
    "job-report",
    new ResourceTemplate("figma-export://jobs/{job_id}/report", { list: undefined }),
    { title: "Export job report", mimeType: "application/json" },
    async (uri, variables) => {
      const job = await services.store.getJob(String(variables.job_id));
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "application/json",
            text: JSON.stringify({ ...services.jobs.status(job), events: job.events }),
          },
        ],
      };
    },
  );

  return server;
}

export type { Services };
