import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { appError } from "./errors.js";

export function makeId(prefix: string): string {
  return `${prefix}_${randomUUID().replaceAll("-", "")}`;
}

export function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, item]) => item !== undefined)
        .sort(([a], [b]) => a.localeCompare(b, "en"))
        .map(([key, item]) => [key, canonicalize(item)]),
    );
  }
  return value;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

export function sha256(value: string | Uint8Array): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

export function normalizeText(value: string): string {
  return value.normalize("NFC").replace(/\s+/gu, " ").trim();
}

const WINDOWS_RESERVED = /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?$/iu;
const UNSAFE_SEGMENT = /[<>:"/\\|?*]/gu;

export function sanitizeSegment(raw: string, maxLength = 120): string {
  const normalized = normalizeText(raw)
    .replace(/[\s\S]/gu, (character) => {
      const code = character.codePointAt(0);
      return code !== undefined && code < 32 ? "_" : character;
    })
    .replace(UNSAFE_SEGMENT, "_")
    .replace(/[. ]+$/gu, "")
    .replace(/^\.+$/gu, "_");
  const protectedName = WINDOWS_RESERVED.test(normalized) ? `_${normalized}` : normalized;
  const nonEmpty = protectedName || "_";
  return Array.from(nonEmpty).slice(0, maxLength).join("");
}

export function joinRemotePath(root: string, ...segments: string[]): string {
  const normalizedRoot = `/${root
    .replaceAll("\\", "/")
    .split("/")
    .filter(Boolean)
    .map((item) => sanitizeSegment(item))
    .join("/")}`;
  const safeSegments = segments
    .flatMap((segment) => segment.replaceAll("\\", "/").split("/"))
    .filter(Boolean)
    .map((item) => {
      if (item === "." || item === ".." || /^[A-Za-z]:[\\/]/u.test(item)) {
        throw appError("UNSAFE_PATH", "planning", "Path traversal or drive prefix is not allowed");
      }
      return sanitizeSegment(item);
    });
  const result = path.posix.join(normalizedRoot, ...safeSegments);
  const prefix = normalizedRoot === "/" ? "/" : `${normalizedRoot}/`;
  if (result !== normalizedRoot && !result.startsWith(prefix)) {
    throw appError("UNSAFE_PATH", "planning", "Remote path escaped the configured root");
  }
  return result;
}

export function parseCursor(cursor: string | null | undefined): number {
  if (!cursor) return 0;
  try {
    const value = Number.parseInt(Buffer.from(cursor, "base64url").toString("utf8"), 10);
    if (!Number.isSafeInteger(value) || value < 0) throw new Error("invalid");
    return value;
  } catch {
    throw appError("INVALID_CURSOR", "query", "Cursor is invalid");
  }
}

export function makeCursor(offset: number, total: number): string | null {
  return offset < total ? Buffer.from(String(offset), "utf8").toString("base64url") : null;
}

export function parseRetryAfter(value: string | null, now = Date.now()): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1_000);
  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) ? undefined : Math.max(0, timestamp - now);
}

export async function sleep(ms: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      const item = items[index];
      if (item !== undefined) results[index] = await worker(item, index);
    }
  });
  await Promise.all(runners);
  return results;
}

export function assertInside(base: string, candidate: string): void {
  const relative = path.relative(path.resolve(base), path.resolve(candidate));
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw appError("UNSAFE_LOCAL_PATH", "filesystem", "Local path escaped the job workspace");
  }
}

export function ensureCaseInsensitiveUnique(
  paths: string[],
): Array<{ path: string; indexes: number[] }> {
  const seen = new Map<string, number[]>();
  paths.forEach((item, index) => {
    const key = item.normalize("NFC").toLocaleLowerCase("en-US");
    seen.set(key, [...(seen.get(key) ?? []), index]);
  });
  return [...seen.entries()]
    .filter(([, indexes]) => indexes.length > 1)
    .map(([item, indexes]) => ({ path: item, indexes }));
}
