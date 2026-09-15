import type { LayoutInfo, NormalizedNode } from "../domain/types.js";

function median(values: number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const upper = sorted[middle] ?? 0;
  return sorted.length % 2 ? upper : ((sorted[middle - 1] ?? upper) + upper) / 2;
}

type Cluster = { center: number; nodes: NormalizedNode[] };

function cluster(nodes: NormalizedNode[], axis: "x" | "y", tolerance: number): Cluster[] {
  const sizeKey = axis === "x" ? "width" : "height";
  const centers = nodes
    .filter((node) => node.bounds)
    .map((node) => ({
      node,
      center: (node.bounds?.[axis] ?? 0) + (node.bounds?.[sizeKey] ?? 0) / 2,
    }))
    .sort((a, b) => a.center - b.center || a.node.id.localeCompare(b.node.id, "en"));
  const clusters: Cluster[] = [];
  for (const entry of centers) {
    const current = clusters.at(-1);
    if (!current || Math.abs(entry.center - current.center) > tolerance) {
      clusters.push({ center: entry.center, nodes: [entry.node] });
    } else {
      current.nodes.push(entry.node);
      current.center =
        current.nodes.reduce(
          (sum, item) => sum + (item.bounds?.[axis] ?? 0) + (item.bounds?.[sizeKey] ?? 0) / 2,
          0,
        ) / current.nodes.length;
    }
  }
  return clusters;
}

export type LayoutAnalysis = {
  layout: Map<string, LayoutInfo>;
  rows: Array<{
    index: number;
    nodeIds: string[];
    y: number;
    blockIndex: number;
    groupKey: string;
  }>;
  columns: Array<{
    index: number;
    nodeIds: string[];
    x: number;
    blockIndex: number;
    groupKey: string;
  }>;
  toleranceX: number;
  toleranceY: number;
  warnings: string[];
};

export function analyzeGeometry(
  nodes: NormalizedNode[],
  options: { toleranceFactor?: number; dimensionToleranceFactor?: number; global?: boolean } = {},
): LayoutAnalysis {
  const bounded = nodes.filter((node) => node.bounds && node.visible);
  const factor = options.toleranceFactor ?? 0.35;
  const toleranceY = Math.max(1, median(bounded.map((node) => node.bounds?.height ?? 0)) * factor);
  const toleranceX = Math.max(1, median(bounded.map((node) => node.bounds?.width ?? 0)) * factor);
  const partitions = new Map<string, NormalizedNode[]>();
  for (const node of bounded) {
    const key = options.global ? "global" : (node.parentId ?? node.section ?? node.page ?? "root");
    partitions.set(key, [...(partitions.get(key) ?? []), node]);
  }
  const rows: LayoutAnalysis["rows"] = [];
  const columns: LayoutAnalysis["columns"] = [];
  const layout = new Map<string, LayoutInfo>();
  const warnings: string[] = [];
  const dimensionToleranceFactor = options.dimensionToleranceFactor ?? 0.15;
  const orderedPartitions = [...partitions.entries()].sort(([, a], [, b]) => {
    const firstA = [...a].sort(
      (left, right) =>
        (left.bounds?.y ?? 0) - (right.bounds?.y ?? 0) ||
        (left.bounds?.x ?? 0) - (right.bounds?.x ?? 0) ||
        left.id.localeCompare(right.id, "en"),
    )[0];
    const firstB = [...b].sort(
      (left, right) =>
        (left.bounds?.y ?? 0) - (right.bounds?.y ?? 0) ||
        (left.bounds?.x ?? 0) - (right.bounds?.x ?? 0) ||
        left.id.localeCompare(right.id, "en"),
    )[0];
    return (
      (firstA?.bounds?.y ?? 0) - (firstB?.bounds?.y ?? 0) ||
      (firstA?.bounds?.x ?? 0) - (firstB?.bounds?.x ?? 0) ||
      (firstA?.id ?? "").localeCompare(firstB?.id ?? "", "en")
    );
  });
  const blockCountersByDepth = new Map<number, number>();
  for (const [partitionKey, partition] of orderedPartitions) {
    const depth = options.global ? 0 : (partition[0]?.hierarchyPath.length ?? 0);
    const blockIndex = (blockCountersByDepth.get(depth) ?? 0) + 1;
    blockCountersByDepth.set(depth, blockIndex);
    const medianWidth = median(partition.map((node) => node.bounds?.width ?? 0));
    const medianHeight = median(partition.map((node) => node.bounds?.height ?? 0));
    for (const node of partition) {
      const width = node.bounds?.width ?? 0;
      const height = node.bounds?.height ?? 0;
      const similar =
        partition.length > 1 &&
        Math.abs(width - medianWidth) <= Math.max(1, medianWidth * dimensionToleranceFactor) &&
        Math.abs(height - medianHeight) <= Math.max(1, medianHeight * dimensionToleranceFactor);
      layout.set(node.id, {
        blockIndex,
        groupKey: partitionKey,
        dimensionsSimilarToPeers: similar,
      });
    }
    const partitionRows = cluster(partition, "y", toleranceY).sort(
      (a, b) =>
        a.center - b.center || (a.nodes[0]?.id ?? "").localeCompare(b.nodes[0]?.id ?? "", "en"),
    );
    const partitionColumns = cluster(partition, "x", toleranceX).sort(
      (a, b) =>
        a.center - b.center || (a.nodes[0]?.id ?? "").localeCompare(b.nodes[0]?.id ?? "", "en"),
    );
    for (const [rowOffset, row] of partitionRows.entries()) {
      const ordered = [...row.nodes].sort(
        (a, b) => (a.bounds?.x ?? 0) - (b.bounds?.x ?? 0) || a.id.localeCompare(b.id, "en"),
      );
      ordered.forEach((node, columnOffset) => {
        layout.set(node.id, {
          ...(layout.get(node.id) ?? {}),
          rowIndex: rowOffset + 1,
          columnIndex: columnOffset + 1,
          groupKey: partitionKey,
        });
      });
      rows.push({
        index: rowOffset + 1,
        nodeIds: ordered.map((node) => node.id),
        y: row.center,
        blockIndex,
        groupKey: partitionKey,
      });
      for (let index = 1; index < ordered.length; index += 1) {
        const previous = ordered[index - 1];
        const current = ordered[index];
        if (
          previous?.bounds &&
          current?.bounds &&
          previous.bounds.x + previous.bounds.width > current.bounds.x
        ) {
          warnings.push(
            `Overlapping nodes in block ${blockIndex}, row ${rowOffset + 1}: ${previous.id}, ${current.id}`,
          );
        }
      }
    }
    columns.push(
      ...partitionColumns.map((column, offset) => ({
        index: offset + 1,
        nodeIds: [...column.nodes]
          .sort((a, b) => (a.bounds?.y ?? 0) - (b.bounds?.y ?? 0) || a.id.localeCompare(b.id, "en"))
          .map((node) => node.id),
        x: column.center,
        blockIndex,
        groupKey: partitionKey,
      })),
    );
    const rowLengths = partitionRows.map((row) => row.nodes.length);
    if (new Set(rowLengths).size > 1) {
      warnings.push(`Rows in block ${blockIndex} have unequal lengths: ${rowLengths.join(", ")}`);
    }
  }
  return { layout, rows, columns, toleranceX, toleranceY, warnings };
}

export { median };
