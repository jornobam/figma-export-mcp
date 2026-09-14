import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AppConfig } from "../config.js";
import type { CreateExportPlanInput } from "../domain/schemas.js";
import type { ExportJob, ExportPlan, JobItem } from "../domain/types.js";
import { AppError, appError, toSafeError } from "../errors.js";
import type { FigmaClient } from "../figma/client.js";
import { createZip } from "../packaging/zip.js";
import type { StateStore } from "../state/store.js";
import {
  assertInside,
  joinRemotePath,
  makeId,
  mapLimit,
  resolveJobFolder,
  sanitizeSegment,
} from "../util.js";
import type { YandexDiskClient } from "../yandex/client.js";

export class JobOrchestrator {
  private readonly active = new Map<string, Promise<void>>();

  constructor(
    private readonly config: AppConfig,
    private readonly store: StateStore,
    private readonly figma: FigmaClient,
    private readonly yandex: YandexDiskClient,
  ) {}

  private addEvent(job: ExportJob, stage: string, message: string, itemId?: string): void {
    job.events.push({
      sequence: (job.events.at(-1)?.sequence ?? 0) + 1,
      at: new Date().toISOString(),
      stage,
      message,
      ...(itemId ? { itemId } : {}),
    });
    if (job.events.length > 10_000) job.events.splice(0, job.events.length - 10_000);
    job.updatedAt = new Date().toISOString();
  }

  private async save(job: ExportJob): Promise<void> {
    job.updatedAt = new Date().toISOString();
    await this.store.saveJob(job);
  }

  async execute(plan: ExportPlan, digest: string, idempotencyKey: string): Promise<ExportJob> {
    if (plan.digest !== digest)
      throw appError("PLAN_DIGEST_MISMATCH", "execution", "Plan digest does not match");
    if (plan.status !== "confirmed")
      throw appError("PLAN_NOT_CONFIRMED", "execution", "Only a confirmed plan can be executed");
    const existing = (await this.store.listJobs()).find(
      (job) => job.idempotencyKey === idempotencyKey,
    );
    if (existing) {
      if (existing.planId !== plan.id || existing.planDigest !== digest) {
        throw appError(
          "IDEMPOTENCY_KEY_CONFLICT",
          "execution",
          "Idempotency key is already bound to another plan",
        );
      }
      this.start(existing.id);
      return existing;
    }
    const planJob = (await this.store.listJobs()).find(
      (job) => job.planId === plan.id && ["queued", "running", "partial"].includes(job.status),
    );
    if (planJob)
      throw appError("PLAN_ALREADY_RUNNING", "execution", "This plan already has an active job");
    const currentVersion = await this.figma.getCurrentVersion(plan.source.fileKey);
    if (currentVersion !== plan.source.version) {
      throw appError(
        "FIGMA_VERSION_CHANGED",
        "execution",
        "Figma file changed after preview; create and confirm a new plan",
      );
    }
    const now = new Date().toISOString();
    const id = makeId("job");
    const job: ExportJob = {
      schemaVersion: 1,
      id,
      planId: plan.id,
      planDigest: plan.digest,
      idempotencyKey,
      status: "queued",
      createdAt: now,
      updatedAt: now,
      workspaceName: id,
      items: plan.manifest.map((item) => ({
        ...item,
        kind: "source",
        stage: "planned",
        attempts: 0,
      })),
      events: [],
      cleanupComplete: false,
    };
    this.addEvent(job, "queued", `Queued ${job.items.length} items`);
    await this.store.saveJob(job);
    plan.status = "running";
    await this.store.savePlan(plan);
    this.start(job.id);
    return job;
  }

  start(jobId: string): void {
    if (this.active.has(jobId)) return;
    const promise = this.run(jobId)
      .catch(() => undefined)
      .finally(() => this.active.delete(jobId));
    this.active.set(jobId, promise);
  }

  async wait(jobId: string): Promise<void> {
    await this.active.get(jobId);
  }

  async resumePending(): Promise<void> {
    const jobs = await this.store.listJobs();
    for (const job of jobs) {
      if (["queued", "running"].includes(job.status)) this.start(job.id);
    }
  }

  private async failItem(
    job: ExportJob,
    item: JobItem,
    error: unknown,
    stage: string,
  ): Promise<void> {
    item.stage = "failed";
    item.error = toSafeError(error, stage);
    item.error.itemId = item.id;
    this.addEvent(job, "failed", `${item.error.code}: ${item.error.safeMessage}`, item.id);
    await this.save(job);
  }

  private async persistBytes(
    job: ExportJob,
    item: JobItem,
    bytes: Uint8Array,
    extension: string,
  ): Promise<void> {
    const used = job.items.reduce((total, current) => total + (current.localSize ?? 0), 0);
    if (used + bytes.byteLength > this.config.maxTempBytes) {
      throw appError(
        "TEMP_LIMIT_EXCEEDED",
        "downloading",
        "Job would exceed the configured temporary storage limit",
      );
    }
    const workspace = this.store.workspacePath(job.workspaceName);
    const itemsDir = path.join(workspace, "items");
    await mkdir(itemsDir, { recursive: true });
    const filename = `${item.id}.${extension}`;
    const target = path.join(itemsDir, filename);
    const temporary = path.join(itemsDir, `.${filename}.partial`);
    assertInside(workspace, target);
    await writeFile(temporary, bytes, { mode: 0o600 });
    await rename(temporary, target);
    item.localRelativePath = path.relative(workspace, target);
    item.localSize = bytes.byteLength;
    item.localSha256 = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
    item.stage = "downloaded";
    this.addEvent(job, "downloaded", `Downloaded ${bytes.byteLength} bytes`, item.id);
    await this.save(job);
  }

  private localPath(job: ExportJob, item: JobItem): string {
    if (!item.localRelativePath)
      throw appError("LOCAL_CHECKPOINT_MISSING", "filesystem", "Local checkpoint is missing");
    const workspace = this.store.workspacePath(job.workspaceName);
    const result = path.join(workspace, item.localRelativePath);
    assertInside(workspace, result);
    return result;
  }

  private async deliverItem(
    job: ExportJob,
    item: JobItem,
    input: CreateExportPlanInput,
  ): Promise<void> {
    const localPath = this.localPath(job, item);
    const bytes = new Uint8Array(await readFile(localPath));
    if (bytes.byteLength !== item.localSize || !item.localSha256) {
      throw appError(
        "LOCAL_CHECKPOINT_CORRUPT",
        "filesystem",
        "Local checkpoint size or checksum metadata is invalid",
      );
    }
    const existing = await this.yandex.getMetadata(item.remotePath);
    if (existing) {
      const canTreatAsOwnUpload = item.uploadAttempted === true;
      const identical =
        existing.type === "file" &&
        existing.size === item.localSize &&
        (!existing.sha256 || `sha256:${existing.sha256}` === item.localSha256);
      if (identical && (canTreatAsOwnUpload || input.collision_policy === "skip_identical")) {
        await this.yandex.verify(item.remotePath, {
          size: item.localSize,
          sha256: item.localSha256,
        });
        item.stage = "verified";
        item.verifiedAt = new Date().toISOString();
        this.addEvent(job, "verified", "Verified existing identical remote file", item.id);
      } else {
        throw appError(
          "YANDEX_DESTINATION_COLLISION",
          "uploading",
          "Remote destination already exists and is not an identical resumable upload",
        );
      }
    } else {
      item.uploadAttempted = true;
      item.stage = "transformed";
      await this.save(job);
      await this.yandex.upload(item.remotePath, bytes);
      item.stage = "uploaded";
      this.addEvent(job, "uploaded", `Uploaded ${bytes.byteLength} bytes`, item.id);
      await this.save(job);
      await this.yandex.verify(item.remotePath, {
        size: bytes.byteLength,
        sha256: item.localSha256,
      });
      item.stage = "verified";
      item.verifiedAt = new Date().toISOString();
      this.addEvent(
        job,
        "verified",
        "Remote path, type, size and available checksum verified",
        item.id,
      );
    }
    await unlink(localPath);
    item.stage = "cleaned";
    this.addEvent(job, "cleaned", "Removed local item after remote verification", item.id);
    await this.save(job);
  }

  private async prepareArchives(
    job: ExportJob,
    input: CreateExportPlanInput,
    sourceVersion: string,
  ): Promise<void> {
    if (input.packaging.mode === "folders" || job.items.some((item) => item.kind === "archive"))
      return;
    const sources = job.items.filter((item) => item.kind !== "archive");
    if (sources.some((item) => item.stage === "failed" || !item.localRelativePath)) return;
    const groups = new Map<string, JobItem[]>();
    if (input.packaging.mode === "zipPerGroup") {
      for (const item of sources) {
        const key =
          input.packaging.archive_groups_by
            .map((name) => item.variables[name] ?? `_missing_${name}`)
            .join("__") || "group";
        groups.set(key, [...(groups.get(key) ?? []), item]);
      }
    } else {
      groups.set("archive", sources);
    }
    const effectiveJobFolder = resolveJobFolder(
      input.destination.job_folder,
      input.collision_policy,
      sourceVersion,
      input.naming.max_segment_length,
    );
    for (const [key, items] of groups) {
      const commonPrefix = joinRemotePath(input.destination.root, effectiveJobFolder);
      const entries = await Promise.all(
        items.map(async (item) => ({
          name: item.remotePath.startsWith(`${commonPrefix}/`)
            ? item.remotePath.slice(commonPrefix.length + 1)
            : path.posix.basename(item.remotePath),
          bytes: new Uint8Array(await readFile(this.localPath(job, item))),
        })),
      );
      const bytes = createZip(entries);
      const archiveName =
        input.packaging.mode === "zipPerGroup"
          ? `${sanitizeSegment(key)}.zip`
          : `${sanitizeSegment(input.destination.job_folder)}.zip`;
      const archiveItem: JobItem = {
        id: makeId("item"),
        ordinal: job.items.length + 1,
        nodeId: `archive:${key}`,
        matchedNodeId: `archive:${key}`,
        hierarchyPath: ["archive", key],
        variables: { archive_group: key, ext: "zip" },
        remotePath: joinRemotePath(input.destination.root, effectiveJobFolder, archiveName),
        reasons: ["packaging"],
        confidence: 1,
        kind: "archive",
        archiveSourceItemIds: items.map((item) => item.id),
        stage: "planned",
        attempts: 0,
      };
      job.items.push(archiveItem);
      await this.persistBytes(job, archiveItem, bytes, "zip");
      this.addEvent(
        job,
        "packaging",
        `Created archive containing ${items.length} entries`,
        archiveItem.id,
      );
    }
    await this.save(job);
  }

  private async run(jobId: string): Promise<void> {
    const job = await this.store.getJob(jobId);
    const plan = await this.store.getPlan(job.planId);
    const input = plan.input as unknown as CreateExportPlanInput;
    job.status = "running";
    this.addEvent(job, "running", "Job started or resumed");
    await this.save(job);
    const needsRender = job.items.filter(
      (item) =>
        item.kind !== "archive" &&
        (["planned", "rendering", "rendered"].includes(item.stage) ||
          (item.stage === "failed" && item.error?.retryable && !item.localRelativePath)),
    );
    if (needsRender.length) {
      needsRender.forEach((item) => {
        item.stage = "rendering";
        item.attempts += 1;
        delete item.error;
      });
      await this.save(job);
      let urls: Record<string, string | null>;
      try {
        urls = await this.figma.renderImages(
          plan.source.fileKey,
          needsRender.map((item) => item.nodeId),
          {
            format: input.export.format,
            scale: input.export.scale,
            contentsOnly: input.export.contents_only,
            useAbsoluteBounds: input.export.use_absolute_bounds,
            version: plan.source.version,
          },
        );
      } catch (error) {
        for (const item of needsRender) await this.failItem(job, item, error, "rendering");
        await this.finish(job, plan);
        return;
      }
      await mapLimit(needsRender, this.config.concurrency, async (item) => {
        const url = urls[item.nodeId];
        if (!url) {
          await this.failItem(
            job,
            item,
            appError(
              "FIGMA_RENDER_NULL",
              "rendering",
              `Figma returned no render URL for node ${item.nodeId}`,
            ),
            "rendering",
          );
          return;
        }
        try {
          item.stage = "rendered";
          this.addEvent(job, "rendered", "Figma rendered item", item.id);
          const bytes = await this.figma.downloadRendered(url);
          await this.persistBytes(job, item, bytes, input.export.format);
        } catch (error) {
          await this.failItem(job, item, error, "downloading");
        }
      });
    }
    await this.prepareArchives(job, input, plan.source.version);
    const uploadSources =
      input.packaging.mode === "folders" || input.packaging.mode === "filesAndZip";
    const deliverable = job.items.filter(
      (item) =>
        (item.kind === "archive" || uploadSources) &&
        (["downloaded", "transformed", "uploaded", "verified"].includes(item.stage) ||
          (item.stage === "failed" && item.error?.retryable && item.localRelativePath)),
    );
    await mapLimit(deliverable, this.config.concurrency, async (item) => {
      try {
        if (item.stage === "verified") {
          await unlink(this.localPath(job, item)).catch((error: NodeJS.ErrnoException) => {
            if (error.code !== "ENOENT") throw error;
          });
          item.stage = "cleaned";
          await this.save(job);
          return;
        }
        await this.deliverItem(job, item, input);
      } catch (error) {
        await this.failItem(job, item, error, "uploading");
      }
    });
    if (!uploadSources) {
      const archivesComplete =
        job.items.filter((item) => item.kind === "archive").length > 0 &&
        job.items
          .filter((item) => item.kind === "archive")
          .every((item) => item.stage === "cleaned");
      if (archivesComplete) {
        for (const item of job.items.filter(
          (entry) => entry.kind !== "archive" && entry.stage === "downloaded",
        )) {
          await unlink(this.localPath(job, item)).catch((error: NodeJS.ErrnoException) => {
            if (error.code !== "ENOENT") throw error;
          });
          item.stage = "cleaned";
          this.addEvent(
            job,
            "cleaned",
            "Removed source after its verified archive was uploaded",
            item.id,
          );
        }
        await this.save(job);
      }
    }
    await this.finish(job, plan);
  }

  private async finish(job: ExportJob, plan: ExportPlan): Promise<void> {
    const failures = job.items.filter((item) => item.stage === "failed");
    const complete = job.items.length > 0 && job.items.every((item) => item.stage === "cleaned");
    job.status = complete ? "completed" : failures.length < job.items.length ? "partial" : "failed";
    plan.status = complete ? "completed" : job.status;
    this.addEvent(
      job,
      job.status,
      complete ? "All expected remote objects were verified" : `${failures.length} item(s) failed`,
    );
    if (complete) {
      await rm(this.store.workspacePath(job.workspaceName), { recursive: true, force: true });
      job.cleanupComplete = true;
    }
    await Promise.all([this.save(job), this.store.savePlan(plan)]);
  }

  async retry(jobId: string, idempotencyKey: string): Promise<ExportJob> {
    const job = await this.store.getJob(jobId);
    const previous = job.events.find(
      (event) => event.stage === "retry" && event.message === idempotencyKey,
    );
    if (previous) return job;
    const retryable = job.items.filter((item) => item.stage === "failed" && item.error?.retryable);
    if (!retryable.length)
      throw appError("NO_RETRYABLE_ITEMS", "retry", "Job has no failed retryable items");
    for (const item of retryable) {
      item.stage = item.localRelativePath ? "downloaded" : "planned";
      delete item.error;
    }
    job.status = "queued";
    this.addEvent(job, "retry", idempotencyKey);
    await this.save(job);
    this.start(job.id);
    return job;
  }

  async verify(jobId: string): Promise<{ verified: number; missing: number; mismatch: number }> {
    const job = await this.store.getJob(jobId);
    let verified = 0;
    let missing = 0;
    let mismatch = 0;
    for (const item of job.items) {
      if (!item.localSize || !item.localSha256) {
        missing += 1;
        continue;
      }
      try {
        await this.yandex.verify(item.remotePath, {
          size: item.localSize,
          sha256: item.localSha256,
        });
        verified += 1;
      } catch (error) {
        if (error instanceof AppError && error.safe.code === "YANDEX_VERIFY_MISSING") missing += 1;
        else mismatch += 1;
      }
    }
    return { verified, missing, mismatch };
  }

  async cleanup(jobId: string, confirmPartialCleanup: boolean): Promise<ExportJob> {
    const job = await this.store.getJob(jobId);
    if (job.status !== "completed" && !confirmPartialCleanup) {
      throw appError(
        "CLEANUP_REQUIRES_CONFIRMATION",
        "cleanup",
        "Incomplete job cleanup requires explicit confirmation because resume data may be lost",
      );
    }
    if (
      job.status === "completed" &&
      !job.items.every((item) => ["verified", "cleaned"].includes(item.stage))
    ) {
      throw appError(
        "CLEANUP_NOT_VERIFIED",
        "cleanup",
        "Cleanup refused because not every expected item is verified",
      );
    }
    await rm(this.store.workspacePath(job.workspaceName), { recursive: true, force: true });
    job.cleanupComplete = true;
    this.addEvent(
      job,
      "cleanup",
      job.status === "completed"
        ? "Verified workspace removed"
        : "Incomplete workspace removed after explicit confirmation",
    );
    await this.save(job);
    return job;
  }

  status(job: ExportJob): Record<string, unknown> {
    const atLeast = (stages: string[]) =>
      job.items.filter((item) => stages.includes(item.stage)).length;
    return {
      schema_version: "1.0",
      job_id: job.id,
      plan_id: job.planId,
      status: job.status,
      totals: {
        planned: job.items.length,
        rendered: atLeast([
          "rendered",
          "downloaded",
          "transformed",
          "uploaded",
          "verified",
          "cleaned",
        ]),
        downloaded: job.items.filter((item) => item.localSize !== undefined).length,
        uploaded: atLeast(["uploaded", "verified", "cleaned"]),
        verified: atLeast(["verified", "cleaned"]),
        failed: atLeast(["failed"]),
      },
      retry_delays: job.items
        .filter((item) => item.error?.retryAfterSeconds)
        .map((item) => ({ item_id: item.id, seconds: item.error?.retryAfterSeconds })),
      errors: job.items.flatMap((item) => (item.error ? [item.error] : [])),
      can_resume: job.items.some((item) => item.stage === "failed" && item.error?.retryable),
      remote_paths: job.items
        .filter((item) => ["uploaded", "verified", "cleaned"].includes(item.stage))
        .slice(0, 100)
        .map((item) => item.remotePath),
      cleanup_complete: job.cleanupComplete,
      updated_at: job.updatedAt,
    };
  }
}
