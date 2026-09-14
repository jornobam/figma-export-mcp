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
  rows: Array<{ index: number; nodeIds: string[]; y: number }>;
  columns: Array<{ index: number; nodeIds: string[]; x: number }>;
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
  const rowClusters: Cluster[] = [];
  const columnClusters: Cluster[] = [];
  const layout = new Map<string, LayoutInfo>();
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
  for (const [blockOffset, [, partition]] of orderedPartitions.entries()) {
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
        blockIndex: blockOffset + 1,
        groupKey: node.parentId ?? node.section ?? node.page ?? "root",
        dimensionsSimilarToPeers: similar,
      });
    }
    rowClusters.push(...cluster(partition, "y", toleranceY));
    columnClusters.push(...cluster(partition, "x", toleranceX));
  }
  rowClusters.sort(
    (a, b) =>
      a.center - b.center || (a.nodes[0]?.id ?? "").localeCompare(b.nodes[0]?.id ?? "", "en"),
  );
  columnClusters.sort(
    (a, b) =>
      a.center - b.center || (a.nodes[0]?.id ?? "").localeCompare(b.nodes[0]?.id ?? "", "en"),
  );
  const rows = rowClusters.map((row, rowOffset) => {
    const ordered = [...row.nodes].sort(
      (a, b) => (a.bounds?.x ?? 0) - (b.bounds?.x ?? 0) || a.id.localeCompare(b.id, "en"),
    );
    ordered.forEach((node, columnOffset) => {
      layout.set(node.id, {
        ...(layout.get(node.id) ?? {}),
        rowIndex: rowOffset + 1,
        columnIndex: columnOffset + 1,
        groupKey: node.parentId ?? node.section ?? node.page ?? "root",
      });
    });
    return { index: rowOffset + 1, nodeIds: ordered.map((node) => node.id), y: row.center };
  });
  const columns = columnClusters.map((column, offset) => ({
    index: offset + 1,
    nodeIds: [...column.nodes]
      .sort((a, b) => (a.bounds?.y ?? 0) - (b.bounds?.y ?? 0) || a.id.localeCompare(b.id, "en"))
      .map((node) => node.id),
    x: column.center,
  }));
  const rowLengths = rows.map((row) => row.nodeIds.length);
  const warnings: string[] = [];
  if (new Set(rowLengths).size > 1)
    warnings.push(`Rows have unequal lengths: ${rowLengths.join(", ")}`);
  for (const row of rows) {
    const rowNodes = row.nodeIds
      .map((id) => nodes.find((node) => node.id === id))
      .filter((node): node is NormalizedNode => Boolean(node?.bounds));
    for (let index = 1; index < rowNodes.length; index += 1) {
      const previous = rowNodes[index - 1];
      const current = rowNodes[index];
      if (
        previous?.bounds &&
        current?.bounds &&
        previous.bounds.x + previous.bounds.width > current.bounds.x
      ) {
        warnings.push(`Overlapping nodes in row ${row.index}: ${previous.id}, ${current.id}`);
      }
    }
  }
  return { layout, rows, columns, toleranceX, toleranceY, warnings };
}

export { median };
