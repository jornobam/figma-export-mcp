import { appError } from "../errors.js";

export type ParsedFigmaReference = { fileKey: string; nodeId?: string };

export function normalizeNodeId(value: string): string {
  const decoded = decodeURIComponent(value).trim();
  return decoded.includes(":") ? decoded : decoded.replace(/^(\d+)-(\d+)$/u, "$1:$2");
}

export function parseFigmaReference(raw: string): ParsedFigmaReference {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw appError("INVALID_FIGMA_URL", "inspection", "Figma URL is malformed");
  }
  if (!/(^|\.)figma\.com$/iu.test(url.hostname)) {
    throw appError("INVALID_FIGMA_URL", "inspection", "URL is not hosted by figma.com");
  }
  const segments = url.pathname.split("/").filter(Boolean);
  const kindIndex = segments.findIndex((segment) =>
    ["design", "file", "proto", "board"].includes(segment),
  );
  const fileKey = kindIndex >= 0 ? segments[kindIndex + 1] : undefined;
  if (!fileKey || !/^[A-Za-z0-9_-]{6,}$/u.test(fileKey)) {
    throw appError("INVALID_FIGMA_URL", "inspection", "Figma file key is missing or invalid");
  }
  const nodeParam = url.searchParams.get("node-id");
  return { fileKey, ...(nodeParam ? { nodeId: normalizeNodeId(nodeParam) } : {}) };
}
