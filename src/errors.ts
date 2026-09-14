import type { SafeError } from "./domain/types.js";

const SECRET_PATTERNS = [
  /(?:Bearer|OAuth)\s+[A-Za-z0-9._~+/=-]+/giu,
  /(?:X-Figma-Token|Authorization)\s*[:=]\s*[^\s,;]+/giu,
  /([?&](?:token|access_token|oauth_token|signature|sig|expires|key-pair-id)=)[^&\s]+/giu,
  /figd_[A-Za-z0-9_-]+/gu,
  /y0_[A-Za-z0-9_-]+/gu,
];

export function redactSecrets(value: string): string {
  return SECRET_PATTERNS.reduce(
    (text, pattern, patternIndex) =>
      text.replace(pattern, (...args) => {
        const prefix = patternIndex === 2 ? String(args[1] ?? "") : "";
        return `${prefix}[REDACTED]`;
      }),
    value,
  );
}

export class AppError extends Error {
  readonly safe: SafeError;

  constructor(safe: SafeError, options?: ErrorOptions) {
    super(redactSecrets(safe.safeMessage), options);
    this.name = "AppError";
    this.safe = { ...safe, safeMessage: redactSecrets(safe.safeMessage) };
  }
}

export function toSafeError(error: unknown, fallbackStage = "unknown"): SafeError {
  if (error instanceof AppError) return error.safe;
  const message = error instanceof Error ? redactSecrets(error.message) : "Unexpected error";
  return {
    code: "INTERNAL_ERROR",
    stage: fallbackStage,
    retryable: false,
    safeMessage: message,
  };
}

export function appError(
  code: string,
  stage: string,
  safeMessage: string,
  retryable = false,
  details?: SafeError["details"],
): AppError {
  return new AppError({ code, stage, retryable, safeMessage, ...(details ? { details } : {}) });
}
