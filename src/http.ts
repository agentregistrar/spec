/**
 * Bounded, SSRF-aware HTTP primitives shared by the discovery validator and the
 * attestation verifier.
 *
 * Every fetch applies the timeout, the bounded read, and the same-origin
 * redirect limit required by spec §4 and §8.1. Discovery, JWKS, and broker
 * metadata fetches all go through {@link fetchResource}; nothing follows a URL
 * found inside a document body implicitly.
 */
import { VALIDATOR_VERSION } from "./version";

export const MAX_REDIRECTS = 3; // spec §4: at most three hops
export const DEV_LOCALHOST_HOSTNAMES = new Set(["localhost", "127.0.0.1"]);

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseAbsoluteHttpUrl(value: unknown): URL | null {
  if (typeof value !== "string" || value.length === 0) {
    return null;
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return null;
  }
  return url;
}

export function isDevelopmentOrigin(url: URL): boolean {
  return url.protocol === "http:" && DEV_LOCALHOST_HOSTNAMES.has(url.hostname);
}

export function isAbsoluteProtocolUrl(value: unknown): boolean {
  const url = parseAbsoluteHttpUrl(value);
  if (url === null) {
    return false;
  }
  return url.protocol === "https:" || isDevelopmentOrigin(url);
}

/**
 * Absolute origin: scheme + host (optional port), canonical form exactly
 * (`https://example.com`, never `https://Example.com:443/`), no path, query,
 * fragment, or wildcard. Spec §5.2 requires `iss`, `rp.origin`, and the broker
 * metadata `issuer` to be canonical origins.
 */
export function isCanonicalOrigin(value: unknown): boolean {
  if (typeof value !== "string" || value.length === 0 || value.includes("*")) {
    return false;
  }
  const url = parseAbsoluteHttpUrl(value);
  if (url === null) {
    return false;
  }
  if (url.protocol !== "https:" && !isDevelopmentOrigin(url)) {
    return false;
  }
  if (url.pathname !== "/" && url.pathname !== "") {
    return false;
  }
  if (url.search !== "" || url.hash !== "") {
    return false;
  }
  return value === url.origin;
}

/**
 * Canonical HTTPS origin for a **signed identity artifact** (`iss`, `rp.origin`,
 * broker metadata `issuer`). The localhost development exception does not apply
 * here: an attestation or metadata document is a public identity statement, and
 * the published JSON Schemas restrict these origins to `https://`.
 */
export function isHttpsCanonicalOrigin(value: unknown): boolean {
  if (!isCanonicalOrigin(value)) {
    return false;
  }
  return (value as string).startsWith("https://");
}

/** Backwards-compatible alias used by the discovery checks (trailing slash tolerated). */
export function isAbsoluteOrigin(value: unknown): boolean {
  if (typeof value !== "string" || value.length === 0 || value.includes("*")) {
    return false;
  }
  const trimmed = value.replace(/\/+$/, "");
  const url = parseAbsoluteHttpUrl(trimmed);
  if (url === null) {
    return false;
  }
  if (url.protocol !== "https:" && !isDevelopmentOrigin(url)) {
    return false;
  }
  if (url.pathname !== "/" && url.pathname !== "") {
    return false;
  }
  return url.search === "" && url.hash === "";
}

export function normalizeOrigin(value: string): string {
  return value.replace(/\/+$/, "");
}

/** Enforces the HTTPS requirement (localhost dev exception) before fetching. */
export function assertFetchableUrl(rawUrl: string): string | null {
  const url = parseAbsoluteHttpUrl(rawUrl);
  if (url === null) {
    return "target is not a valid absolute http(s) URL";
  }
  if (url.protocol !== "https:" && !isDevelopmentOrigin(url)) {
    return "https is required (only http://localhost and http://127.0.0.1 are allowed for development)";
  }
  return null;
}

export type FetchFailureKind =
  | "network"
  | "timeout"
  | "redirect"
  | "status"
  | "content-type"
  | "size";

export type FetchOutcome =
  | {
      ok: true;
      status: number;
      headers: Headers;
      text: string;
      bytes: number;
      finalUrl: string;
      redirects: number;
    }
  | { ok: false; kind: FetchFailureKind; message: string };

export interface FetchOptions {
  timeoutMs: number;
  maxBytes: number;
  requireJson: boolean;
  method?: string;
  acceptStatus?: (status: number) => boolean;
  /**
   * When `false`, a 3xx response is passed to `acceptStatus` instead of being
   * followed. Used by the endpoint liveness probe, which only needs to observe
   * that the route answered (spec §5.1 defines `agent_signup` as a `POST`
   * target, so a redirect is not itself a failure).
   */
  followRedirects?: boolean;
}

async function readBounded(
  response: Response,
  maxBytes: number,
): Promise<{ text: string; bytes: number; truncated: boolean }> {
  const body = response.body;
  if (body === null) {
    return { text: "", bytes: 0, truncated: false };
  }
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    if (value) {
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        return { text: "", bytes: total, truncated: true };
      }
      chunks.push(value);
    }
  }
  const buffer = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
  return { text: buffer.toString("utf8"), bytes: total, truncated: false };
}

/**
 * Fetches a resource with a timeout, a bounded read, and a same-origin
 * redirect limit. Returns a discriminated outcome rather than throwing.
 */
export async function fetchResource(
  rawUrl: string,
  options: FetchOptions,
): Promise<FetchOutcome> {
  const guard = assertFetchableUrl(rawUrl);
  if (guard !== null) {
    return { ok: false, kind: "network", message: guard };
  }

  const acceptStatus = options.acceptStatus ?? ((status: number) => status === 200);
  const initialOrigin = new URL(rawUrl).origin;
  let current = rawUrl;
  let redirects = 0;

  for (;;) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs);
    try {
      let response: Response;
      try {
        response = await fetch(current, {
          method: options.method ?? "GET",
          redirect: "manual",
          signal: controller.signal,
          headers: {
            accept: "application/json, text/plain;q=0.5, */*;q=0.1",
            "user-agent": `agent-identity-conformance-validator/${VALIDATOR_VERSION}`,
          },
        });
      } catch (error) {
        if (error instanceof Error && error.name === "AbortError") {
          return {
            ok: false,
            kind: "timeout",
            message: `request timed out after ${options.timeoutMs}ms`,
          };
        }
        return {
          ok: false,
          kind: "network",
          message: error instanceof Error ? error.message : String(error),
        };
      }

      if (
        options.followRedirects !== false &&
        response.status >= 300 &&
        response.status < 400
      ) {
        const location = response.headers.get("location");
        if (location === null) {
          return {
            ok: false,
            kind: "redirect",
            message: `received ${response.status} redirect without a Location header`,
          };
        }
        if (redirects >= MAX_REDIRECTS) {
          return {
            ok: false,
            kind: "redirect",
            message: `exceeded the ${MAX_REDIRECTS}-hop redirect limit`,
          };
        }
        let next: URL;
        try {
          next = new URL(location, current);
        } catch {
          return {
            ok: false,
            kind: "redirect",
            message: `redirect Location is not a valid URL: ${location}`,
          };
        }
        if (next.origin !== initialOrigin) {
          return {
            ok: false,
            kind: "redirect",
            message: `redirect leaves the original origin (${initialOrigin} -> ${next.origin})`,
          };
        }
        redirects += 1;
        current = next.toString();
        continue;
      }

      if (!acceptStatus(response.status)) {
        return {
          ok: false,
          kind: "status",
          message: `expected status ${options.acceptStatus ? "an accepted value" : "200"} but received ${response.status}`,
        };
      }

      if (options.requireJson) {
        const contentType = response.headers.get("content-type") ?? "";
        const mime = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
        if (mime !== "application/json") {
          return {
            ok: false,
            kind: "content-type",
            message: `expected Content-Type application/json but received ${contentType || "(none)"}`,
          };
        }
      }

      const bounded = await readBounded(response, options.maxBytes);
      if (bounded.truncated) {
        return {
          ok: false,
          kind: "size",
          message: `response body exceeds the ${options.maxBytes}-byte cap`,
        };
      }

      return {
        ok: true,
        status: response.status,
        headers: response.headers,
        text: bounded.text,
        bytes: bounded.bytes,
        finalUrl: current,
        redirects,
      };
    } finally {
      clearTimeout(timer);
    }
  }
}
