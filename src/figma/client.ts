import type { AppConfig } from "../config.js";
import type { FetchLike } from "../domain/types.js";
import { AppError, appError, redactSecrets } from "../errors.js";
import { assertSafeExternalUrl } from "../security.js";
import { mapLimit, parseRetryAfter, sleep } from "../util.js";

type FigmaFileResponse = {
  name: string;
  version: string;
  document: Record<string, unknown>;
  components?: Record<string, { name?: string }>;
};

type FigmaImagesResponse = { images: Record<string, string | null>; err?: string; status?: number };

export class FigmaClient {
  constructor(
    private readonly config: AppConfig,
    private readonly fetchImpl: FetchLike = fetch,
  ) {}

  private requireToken(): string {
    if (!this.config.figmaToken) {
      throw appError("FIGMA_NOT_CONFIGURED", "connection", "FIGMA_TOKEN is not configured");
    }
    return this.config.figmaToken;
  }

  private async requestJson<T>(path: string, init: RequestInit = {}, maxRetries = 4): Promise<T> {
    const token = this.requireToken();
    for (let attempt = 0; ; attempt += 1) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.config.httpTimeoutMs);
      let response: Response;
      try {
        response = await this.fetchImpl(`${this.config.figmaApiBaseUrl}${path}`, {
          ...init,
          redirect: "manual",
          signal: controller.signal,
          headers: { Accept: "application/json", "X-Figma-Token": token, ...init.headers },
        });
      } catch (error) {
        clearTimeout(timeout);
        if (attempt < maxRetries) {
          await sleep(Math.min(250 * 2 ** attempt, 4_000));
          continue;
        }
        throw new AppError(
          {
            code: "FIGMA_NETWORK_ERROR",
            stage: "figma",
            retryable: true,
            safeMessage: "Figma request failed after bounded retries",
          },
          { cause: error },
        );
      }
      clearTimeout(timeout);
      if (response.ok) return (await response.json()) as T;
      const retryAfter = parseRetryAfter(response.headers.get("retry-after"));
      const retryable = response.status === 429 || response.status >= 500;
      if (retryable && attempt < maxRetries) {
        await sleep(retryAfter ?? Math.min(250 * 2 ** attempt, 4_000));
        continue;
      }
      const safeMessage = `Figma API returned HTTP ${response.status}`;
      throw new AppError({
        code:
          response.status === 429
            ? "FIGMA_RATE_LIMITED"
            : response.status === 403
              ? "FIGMA_FORBIDDEN"
              : response.status === 404
                ? "FIGMA_NOT_FOUND"
                : "FIGMA_HTTP_ERROR",
        stage: "figma",
        retryable,
        safeMessage,
        ...(retryAfter !== undefined ? { retryAfterSeconds: Math.ceil(retryAfter / 1_000) } : {}),
      });
    }
  }

  async checkConnection(): Promise<{ reachable: true; identityHint?: string }> {
    const data = await this.requestJson<{ email?: string; handle?: string }>("/v1/me", {}, 1);
    const source = data.email ?? data.handle;
    if (!source) return { reachable: true };
    const [name = "", domain] = source.split("@");
    const masked = domain ? `${name.slice(0, 1)}***@${domain}` : `${source.slice(0, 1)}***`;
    return { reachable: true, identityHint: masked };
  }

  async getFile(
    fileKey: string,
    options: { nodeIds?: string[]; version?: string; depth?: number } = {},
  ): Promise<FigmaFileResponse> {
    const params = new URLSearchParams();
    if (options.nodeIds?.length) params.set("ids", options.nodeIds.join(","));
    if (options.version) params.set("version", options.version);
    if (options.depth) params.set("depth", String(options.depth));
    const query = params.size ? `?${params.toString()}` : "";
    return this.requestJson<FigmaFileResponse>(`/v1/files/${encodeURIComponent(fileKey)}${query}`);
  }

  async getCurrentVersion(fileKey: string): Promise<string> {
    return (await this.getFile(fileKey, { depth: 1 })).version;
  }

  async renderImages(
    fileKey: string,
    nodeIds: string[],
    options: {
      format: "png" | "jpg" | "svg" | "pdf";
      scale: number;
      contentsOnly: boolean;
      useAbsoluteBounds: boolean;
      version: string;
    },
  ): Promise<Record<string, string | null>> {
    const batches: string[][] = [];
    let batch: string[] = [];
    let encodedLength = 0;
    for (const id of nodeIds) {
      const nextLength = encodeURIComponent(id).length + 1;
      if (batch.length >= 100 || encodedLength + nextLength > 6_000) {
        batches.push(batch);
        batch = [];
        encodedLength = 0;
      }
      batch.push(id);
      encodedLength += nextLength;
    }
    if (batch.length) batches.push(batch);
    const results = await mapLimit(batches, Math.min(this.config.concurrency, 3), async (ids) => {
      const params = new URLSearchParams({
        ids: ids.join(","),
        format: options.format,
        scale: String(options.scale),
        contents_only: String(options.contentsOnly),
        use_absolute_bounds: String(options.useAbsoluteBounds),
        version: options.version,
      });
      const data = await this.requestJson<FigmaImagesResponse>(
        `/v1/images/${encodeURIComponent(fileKey)}?${params.toString()}`,
      );
      return data.images;
    });
    return Object.assign({}, ...results) as Record<string, string | null>;
  }

  async downloadRendered(urlValue: string): Promise<Uint8Array> {
    let url = await assertSafeExternalUrl(urlValue, { allowPrivate: this.config.allowPrivateUrls });
    for (let redirect = 0; redirect <= 5; redirect += 1) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.config.httpTimeoutMs);
      let response: Response;
      try {
        response = await this.fetchImpl(url, { redirect: "manual", signal: controller.signal });
      } catch (error) {
        clearTimeout(timeout);
        throw new AppError(
          {
            code: "FIGMA_DOWNLOAD_FAILED",
            stage: "downloading",
            retryable: true,
            safeMessage: "Rendered image download failed",
          },
          { cause: error },
        );
      }
      clearTimeout(timeout);
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get("location");
        if (!location || redirect === 5) {
          throw appError(
            "UNSAFE_REDIRECT",
            "downloading",
            "Rendered image redirect chain is invalid",
          );
        }
        url = await assertSafeExternalUrl(new URL(location, url).href, {
          allowPrivate: this.config.allowPrivateUrls,
        });
        continue;
      }
      if (!response.ok) {
        throw appError(
          "FIGMA_DOWNLOAD_FAILED",
          "downloading",
          `Rendered image returned HTTP ${response.status}`,
          response.status >= 500,
        );
      }
      const declaredSize = Number(response.headers.get("content-length"));
      if (Number.isFinite(declaredSize) && declaredSize > this.config.maxFileBytes) {
        throw appError(
          "FILE_TOO_LARGE",
          "downloading",
          "Rendered image exceeds the configured file-size limit",
        );
      }
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.byteLength > this.config.maxFileBytes) {
        throw appError(
          "FILE_TOO_LARGE",
          "downloading",
          "Rendered image exceeds the configured file-size limit",
        );
      }
      return bytes;
    }
    throw appError(
      "FIGMA_DOWNLOAD_FAILED",
      "downloading",
      redactSecrets("Rendered image download failed"),
    );
  }
}

export type { FigmaFileResponse };
