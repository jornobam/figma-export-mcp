import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { appError } from "./errors.js";

function isPrivateIp(address: string): boolean {
  if (address === "::1" || address === "0:0:0:0:0:0:0:1") return true;
  if (address.startsWith("fc") || address.startsWith("fd") || address.startsWith("fe80:"))
    return true;
  const parts = address.split(".").map(Number);
  if (parts.length !== 4) return false;
  const [a = -1, b = -1] = parts;
  return (
    a === 10 ||
    a === 127 ||
    a === 0 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127) ||
    a >= 224
  );
}

export async function assertSafeExternalUrl(
  rawUrl: string,
  options: { allowPrivate?: boolean; allowedHosts?: string[] } = {},
): Promise<URL> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw appError("UNSAFE_EXTERNAL_URL", "network", "External URL is malformed");
  }
  if (url.protocol !== "https:" && !options.allowPrivate) {
    throw appError("UNSAFE_EXTERNAL_URL", "network", "External URL must use HTTPS");
  }
  if (url.username || url.password) {
    throw appError("UNSAFE_EXTERNAL_URL", "network", "Credentials in external URLs are forbidden");
  }
  if (options.allowedHosts && !options.allowedHosts.includes(url.hostname)) {
    throw appError("UNSAFE_EXTERNAL_URL", "network", "External URL host is not allowlisted");
  }
  if (!options.allowPrivate) {
    const addresses = isIP(url.hostname)
      ? [{ address: url.hostname }]
      : await lookup(url.hostname, { all: true }).catch(() => {
          throw appError(
            "DNS_LOOKUP_FAILED",
            "network",
            "External host could not be resolved",
            true,
          );
        });
    if (addresses.some(({ address }) => isPrivateIp(address))) {
      throw appError(
        "UNSAFE_EXTERNAL_URL",
        "network",
        "Private, loopback, and link-local targets are forbidden",
      );
    }
  }
  return url;
}

export { isPrivateIp };
