import type { AppConfig } from "../config.js";
import type { FetchLike } from "../domain/types.js";
import { AppError, appError } from "../errors.js";
import { assertSafeExternalUrl } from "../security.js";
import { joinRemotePath, parseRetryAfter, sleep } from "../util.js";

export type YandexResource = {
  name?: string;
  path?: string;
  type?: "file" | "dir";
  size?: number;
  md5?: string;
  sha256?: string;
};

export class YandexDiskClient {
  constructor(
    private readonly config: AppConfig,
    private readonly fetchImpl: FetchLike = fetch,
  ) {}

  private requireToken(): string {
    if (!this.config.yandexToken) {
      throw appError("YANDEX_NOT_CONFIGURED", "connection", "YANDEX_DISK_TOKEN is not configured");
    }
    return this.config.yandexToken;
  }

  private async apiRequest(
    pathValue: string,
    init: RequestInit = {},
    options: { accepted?: number[]; maxRetries?: number } = {},
  ): Promise<Response> {
    const accepted = options.accepted ?? [];
    const maxRetries = options.maxRetries ?? 4;
    for (let attempt = 0; ; attempt += 1) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.config.httpTimeoutMs);
      try {
        const response = await this.fetchImpl(`${this.config.yandexApiBaseUrl}${pathValue}`, {
          ...init,
          redirect: "manual",
          signal: controller.signal,
          headers: {
            Accept: "application/json",
            Authorization: `OAuth ${this.requireToken()}`,
            ...init.headers,
          },
        });
        clearTimeout(timeout);
        if (response.ok || accepted.includes(response.status)) return response;
        const retryAfter = parseRetryAfter(response.headers.get("retry-after"));
        const retryable = response.status === 429 || response.status >= 500;
        if (retryable && attempt < maxRetries) {
          await sleep(retryAfter ?? Math.min(250 * 2 ** attempt, 4_000));
          continue;
        }
        throw new AppError({
          code:
            response.status === 429
              ? "YANDEX_RATE_LIMITED"
              : response.status === 401 || response.status === 403
                ? "YANDEX_FORBIDDEN"
                : response.status === 507
                  ? "YANDEX_QUOTA_EXCEEDED"
                  : "YANDEX_HTTP_ERROR",
          stage: "yandex",
          retryable,
          safeMessage: `Yandex Disk API returned HTTP ${response.status}`,
          ...(retryAfter !== undefined ? { retryAfterSeconds: Math.ceil(retryAfter / 1_000) } : {}),
        });
      } catch (error) {
        clearTimeout(timeout);
        if (error instanceof AppError) throw error;
        if (attempt < maxRetries) {
          await sleep(Math.min(250 * 2 ** attempt, 4_000));
          continue;
        }
        throw new AppError(
          {
            code: "YANDEX_NETWORK_ERROR",
            stage: "yandex",
            retryable: true,
            safeMessage: "Yandex Disk request failed after bounded retries",
          },
          { cause: error },
        );
      }
    }
  }

  async checkConnection(): Promise<{ reachable: true; identityHint?: string }> {
    const response = await this.apiRequest("/?fields=user.login");
    const body = (await response.json()) as { user?: { login?: string } };
    const login = body.user?.login;
    return { reachable: true, ...(login ? { identityHint: `${login.slice(0, 1)}***` } : {}) };
  }

  async getMetadata(remotePath: string): Promise<YandexResource | null> {
    const params = new URLSearchParams({
      path: remotePath,
      fields: "name,path,type,size,md5,sha256",
    });
    const response = await this.apiRequest(
      `/resources?${params.toString()}`,
      { method: "GET" },
      { accepted: [404], maxRetries: 2 },
    );
    if (response.status === 404) return null;
    return (await response.json()) as YandexResource;
  }

  async ensureDirectory(remotePath: string): Promise<void> {
    const normalized = joinRemotePath(remotePath);
    const segments = normalized.split("/").filter(Boolean);
    let current = "";
    for (const segment of segments) {
      current = joinRemotePath(current || "/", segment);
      const params = new URLSearchParams({ path: current });
      const response = await this.apiRequest(
        `/resources?${params.toString()}`,
        { method: "PUT" },
        { accepted: [409] },
      );
      if (response.status === 409) {
        const metadata = await this.getMetadata(current);
        if (metadata?.type !== "dir") {
          throw appError(
            "YANDEX_PATH_COLLISION",
            "uploading",
            "A file exists where a directory is required",
          );
        }
      }
    }
  }

  async upload(remotePath: string, bytes: Uint8Array): Promise<void> {
    const parent = remotePath.slice(0, remotePath.lastIndexOf("/")) || "/";
    await this.ensureDirectory(parent);
    const params = new URLSearchParams({
      path: remotePath,
      overwrite: "false",
      fields: "href,method,templated",
    });
    const linkResponse = await this.apiRequest(`/resources/upload?${params.toString()}`);
    const link = (await linkResponse.json()) as {
      href?: string;
      method?: string;
      templated?: boolean;
    };
    if (!link.href || (link.method && link.method.toUpperCase() !== "PUT")) {
      throw appError(
        "YANDEX_UPLOAD_LINK_INVALID",
        "uploading",
        "Yandex Disk returned an invalid upload link",
      );
    }
    const uploadUrl = await assertSafeExternalUrl(link.href, {
      allowPrivate: this.config.allowPrivateUrls,
    });
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.httpTimeoutMs);
    try {
      const response = await this.fetchImpl(uploadUrl, {
        method: "PUT",
        body: bytes as BodyInit,
        redirect: "manual",
        signal: controller.signal,
      });
      clearTimeout(timeout);
      if (!response.ok) {
        throw appError(
          "YANDEX_UPLOAD_FAILED",
          "uploading",
          `Yandex upload endpoint returned HTTP ${response.status}`,
          response.status === 429 || response.status >= 500,
        );
      }
    } catch (error) {
      clearTimeout(timeout);
      if (error instanceof AppError) throw error;
      const remote = await this.getMetadata(remotePath).catch(() => null);
      if (remote?.type === "file" && remote.size === bytes.byteLength) return;
      throw new AppError(
        {
          code: "YANDEX_UPLOAD_AMBIGUOUS",
          stage: "uploading",
          retryable: true,
          safeMessage:
            "Upload outcome was ambiguous and remote verification did not confirm success",
        },
        { cause: error },
      );
    }
  }

  async verify(
    remotePath: string,
    expected: { size: number; sha256: string },
  ): Promise<YandexResource> {
    const metadata = await this.getMetadata(remotePath);
    if (metadata?.type !== "file") {
      throw appError(
        "YANDEX_VERIFY_MISSING",
        "verification",
        "Expected remote file is missing",
        true,
      );
    }
    const returnedPath = metadata.path?.replace(/^disk:/u, "");
    if (returnedPath && returnedPath.normalize("NFC") !== remotePath.normalize("NFC")) {
      throw appError(
        "YANDEX_VERIFY_PATH_MISMATCH",
        "verification",
        "Remote path does not match the manifest",
      );
    }
    if (metadata.size !== expected.size) {
      throw appError(
        "YANDEX_VERIFY_SIZE_MISMATCH",
        "verification",
        "Remote file size does not match the local file",
        true,
        {
          expected: expected.size,
          actual: metadata.size ?? -1,
        },
      );
    }
    if (
      metadata.sha256 &&
      `sha256:${metadata.sha256.toLowerCase()}` !== expected.sha256.toLowerCase()
    ) {
      throw appError(
        "YANDEX_VERIFY_CHECKSUM_MISMATCH",
        "verification",
        "Remote checksum does not match the local checksum",
        true,
      );
    }
    return metadata;
  }
}
