import type { NormalizedNode, Snapshot } from "../domain/types.js";
import { makeId } from "../util.js";
import type { FigmaFileResponse } from "./client.js";

type RawNode = Record<string, unknown> & {
  id?: string;
  type?: string;
  name?: string;
  children?: RawNode[];
};

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function propertyValue(value: unknown): string | undefined {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean")
    return String(value);
  if (value && typeof value === "object" && "value" in value)
    return propertyValue((value as { value: unknown }).value);
  return undefined;
}

export function normalizeFigmaFile(
  fileKey: string,
  response: FigmaFileResponse,
  options: { pageNames?: string[]; sourceNodeId?: string; ttlMs?: number } = {},
): Snapshot {
  const nodes: Record<string, NormalizedNode> = {};
  const rootIds: string[] = [];
  const components = response.components ?? {};
  const wantedPages = new Set(options.pageNames ?? []);

  function visit(
    raw: RawNode,
    parent: NormalizedNode | undefined,
    page: string | undefined,
    section: string | undefined,
    inheritedVisible: boolean,
    path: string[],
  ): string[] {
    const id = stringValue(raw.id);
    if (!id) return [];
    const type = stringValue(raw.type) ?? "UNKNOWN";
    const name = stringValue(raw.name) ?? id;
    const currentPage = type === "CANVAS" ? name : page;
    if (type === "CANVAS" && wantedPages.size && !wantedPages.has(name)) return [];
    const currentSection = type === "SECTION" ? name : section;
    const currentPath = [...path, name];
    const rawBounds = raw.absoluteBoundingBox;
    const bounds =
      rawBounds && typeof rawBounds === "object"
        ? {
            x: Number((rawBounds as Record<string, unknown>).x),
            y: Number((rawBounds as Record<string, unknown>).y),
            width: Number((rawBounds as Record<string, unknown>).width),
            height: Number((rawBounds as Record<string, unknown>).height),
          }
        : undefined;
    const validBounds = bounds && Object.values(bounds).every(Number.isFinite) ? bounds : undefined;
    const visible = inheritedVisible && raw.visible !== false && raw.opacity !== 0;
    const properties: Record<string, string> = {};
    if (raw.componentProperties && typeof raw.componentProperties === "object") {
      for (const [key, value] of Object.entries(
        raw.componentProperties as Record<string, unknown>,
      )) {
        const parsed = propertyValue(value);
        if (parsed !== undefined) properties[key] = parsed;
      }
    }
    const componentId = stringValue(raw.componentId);
    const componentName = componentId ? components[componentId]?.name : undefined;
    const node: NormalizedNode = {
      id,
      type,
      name,
      ...(type === "TEXT" && stringValue(raw.characters) !== undefined
        ? { text: stringValue(raw.characters) }
        : {}),
      ...(parent ? { parentId: parent.id } : {}),
      childIds: [],
      hierarchyPath: currentPath,
      ...(currentPage ? { page: currentPage } : {}),
      ...(currentSection ? { section: currentSection } : {}),
      visible,
      ...(validBounds ? { bounds: validBounds } : {}),
      descendantTexts: [],
      ...(componentName ? { componentName } : {}),
      componentProperties: properties,
      siblingIndex: parent ? parent.childIds.length : rootIds.length,
    };
    nodes[id] = node;
    if (!parent) rootIds.push(id);
    const descendantTexts: string[] = [];
    for (const child of Array.isArray(raw.children) ? raw.children : []) {
      const childTexts = visit(child, node, currentPage, currentSection, visible, currentPath);
      const childId = stringValue(child.id);
      if (childId && nodes[childId]) node.childIds.push(childId);
      descendantTexts.push(...childTexts);
    }
    if (node.text) descendantTexts.unshift(node.text);
    node.descendantTexts = [...new Set(descendantTexts)];
    return descendantTexts;
  }

  visit(response.document as RawNode, undefined, undefined, undefined, true, []);
  const now = Date.now();
  return {
    schemaVersion: 1,
    id: makeId("snap"),
    fileKey,
    fileName: response.name,
    version: response.version,
    ...(options.sourceNodeId ? { sourceNodeId: options.sourceNodeId } : {}),
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + (options.ttlMs ?? 24 * 60 * 60 * 1_000)).toISOString(),
    nodes,
    rootIds,
  };
}
