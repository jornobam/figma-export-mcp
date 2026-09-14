import type * as z from "zod/v4";
import type { InspectInputSchema } from "./domain/schemas.js";
import type { Snapshot } from "./domain/types.js";
import type { FigmaClient } from "./figma/client.js";
import { normalizeFigmaFile } from "./figma/snapshot.js";
import { parseFigmaReference } from "./figma/url.js";
import type { StateStore } from "./state/store.js";

type InspectInput = z.infer<typeof InspectInputSchema>;

export class SnapshotService {
  constructor(
    private readonly figma: FigmaClient,
    private readonly store: StateStore,
  ) {}

  async inspect(input: InspectInput): Promise<Snapshot> {
    const parsed = input.figma_url ? parseFigmaReference(input.figma_url) : undefined;
    const fileKey = input.file_key ?? parsed?.fileKey;
    const sourceNodeId = input.node_id ?? parsed?.nodeId;
    if (!fileKey) throw new Error("Either figma_url or file_key is required");
    if (!input.refresh) {
      const cached = (await this.store.listSnapshots())
        .filter(
          (item) =>
            item.fileKey === fileKey &&
            item.sourceNodeId === sourceNodeId &&
            Date.parse(item.expiresAt) > Date.now(),
        )
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
      if (cached) return cached;
    }
    const nodeIds = [
      ...new Set([...(input.scope.node_ids ?? []), ...(sourceNodeId ? [sourceNodeId] : [])]),
    ];
    const response = await this.figma.getFile(fileKey, { ...(nodeIds.length ? { nodeIds } : {}) });
    const snapshot = normalizeFigmaFile(fileKey, response, {
      pageNames: input.scope.page_names,
      ...(sourceNodeId ? { sourceNodeId } : {}),
    });
    await this.store.saveSnapshot(snapshot);
    return snapshot;
  }
}
