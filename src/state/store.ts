import { constants } from "node:fs";
import { access, mkdir, open, readdir, readFile, rename } from "node:fs/promises";
import path from "node:path";
import { ExportPlanSchema } from "../domain/schemas.js";
import type { ExportJob, ExportPlan, Snapshot } from "../domain/types.js";
import { appError } from "../errors.js";
import { assertInside, canonicalJson, makeId } from "../util.js";

type Entity = Snapshot | ExportPlan | ExportJob;
type EntityKind = "snapshots" | "plans" | "jobs";

export class StateStore {
  private readonly queues = new Map<string, Promise<void>>();

  constructor(readonly root: string) {}

  async initialize(): Promise<void> {
    await Promise.all([
      mkdir(path.join(this.root, "snapshots"), { recursive: true }),
      mkdir(path.join(this.root, "plans"), { recursive: true }),
      mkdir(path.join(this.root, "jobs"), { recursive: true }),
      mkdir(path.join(this.root, "workspaces"), { recursive: true }),
    ]);
  }

  async isWritable(): Promise<boolean> {
    try {
      await this.initialize();
      await access(this.root, constants.R_OK | constants.W_OK);
      return true;
    } catch {
      return false;
    }
  }

  private entityPath(kind: EntityKind, id: string): string {
    if (!/^[a-z]+_[a-f0-9]+$/u.test(id))
      throw appError("INVALID_ENTITY_ID", "state", "Entity ID is invalid");
    const result = path.join(this.root, kind, `${id}.json`);
    assertInside(this.root, result);
    return result;
  }

  private async atomicWrite(target: string, value: unknown): Promise<void> {
    const previous = this.queues.get(target) ?? Promise.resolve();
    const current = previous
      .catch(() => undefined)
      .then(async () => {
        await mkdir(path.dirname(target), { recursive: true });
        const temporary = path.join(
          path.dirname(target),
          `.${path.basename(target)}.${makeId("tmp")}`,
        );
        const handle = await open(temporary, "wx", 0o600);
        try {
          await handle.writeFile(`${canonicalJson(value)}\n`, "utf8");
          await handle.sync();
        } finally {
          await handle.close();
        }
        await rename(temporary, target);
      });
    this.queues.set(target, current);
    try {
      await current;
    } finally {
      if (this.queues.get(target) === current) this.queues.delete(target);
    }
  }

  private async write(kind: EntityKind, entity: Entity): Promise<void> {
    await this.atomicWrite(this.entityPath(kind, entity.id), entity);
  }

  private async read<T extends Entity>(kind: EntityKind, id: string): Promise<T> {
    try {
      return JSON.parse(await readFile(this.entityPath(kind, id), "utf8")) as T;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw appError("STATE_NOT_FOUND", "state", `${kind.slice(0, -1)} ${id} was not found`);
      }
      throw error;
    }
  }

  private async list<T extends Entity>(kind: EntityKind): Promise<T[]> {
    await this.initialize();
    const names = await readdir(path.join(this.root, kind));
    return Promise.all(
      names
        .filter((name) => name.endsWith(".json"))
        .map(
          async (name) => JSON.parse(await readFile(path.join(this.root, kind, name), "utf8")) as T,
        ),
    );
  }

  saveSnapshot(snapshot: Snapshot): Promise<void> {
    return this.write("snapshots", snapshot);
  }
  getSnapshot(id: string): Promise<Snapshot> {
    return this.read("snapshots", id);
  }
  listSnapshots(): Promise<Snapshot[]> {
    return this.list("snapshots");
  }
  savePlan(plan: ExportPlan): Promise<void> {
    ExportPlanSchema.parse(plan);
    return this.write("plans", plan);
  }
  async getPlan(id: string): Promise<ExportPlan> {
    return ExportPlanSchema.parse(await this.read("plans", id)) as ExportPlan;
  }
  listPlans(): Promise<ExportPlan[]> {
    return this.list("plans");
  }
  saveJob(job: ExportJob): Promise<void> {
    return this.write("jobs", job);
  }
  getJob(id: string): Promise<ExportJob> {
    return this.read("jobs", id);
  }
  listJobs(): Promise<ExportJob[]> {
    return this.list("jobs");
  }

  workspacePath(name: string): string {
    if (!/^[a-z]+_[a-f0-9]+$/u.test(name))
      throw appError("INVALID_WORKSPACE", "state", "Workspace name is invalid");
    const result = path.join(this.root, "workspaces", name);
    assertInside(path.join(this.root, "workspaces"), result);
    return result;
  }
}
