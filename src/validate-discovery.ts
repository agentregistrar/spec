/**
 * Discovery Conformance Validator (`agent-identity-v1`).
 *
 * Enforces the objective rule: "a Relying Party claiming `agent-identity-v1`
 * support MUST publish a valid discovery document." The normative source of
 * truth is `agent-identity-v1.md` in this repository; the implementation source
 * of truth is `AgentSignupDiscoverySchema` in `./schema.ts`.
 *
 * Run:
 *   pnpm validate:discovery <url-or-file> [--json] [--probe-jwks]
 *                            [--probe-endpoints] [--timeout <ms>]
 *                            [--max-bytes <n>]
 *
 * Exit codes:
 *   0  valid conformant document
 *   1  document retrieved and parsed, but failed conformance
 *   2  could not fetch a usable document (network/HTTP/redirect/size/parse)
 *
 * Safety (spec §3.6 / §8.1): only the top-level URL provided by the user (and
 * explicitly requested probe targets) is ever fetched. URLs found inside the
 * document body are never followed by default; `terms.text` is never executed
 * or interpreted. Every fetch applies a timeout, a bounded read, and a
 * same-origin redirect limit.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { AgentSignupDiscoverySchema } from "./schema";

/** Bumped when validator behavior changes; surfaced in `--json` evidence. */
const VALIDATOR_VERSION = "1.0.0";
const VALIDATOR_ID = "agent-identity-v1";

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_BYTES = 1024 * 1024; // spec §4: 1 MiB cap
const MAX_REDIRECTS = 3; // spec §4: at most three hops
const DEV_LOCALHOST_HOSTNAMES = new Set(["localhost", "127.0.0.1"]);

// ---------------------------------------------------------------------------
// Shared mirror helpers (kept in lockstep with ./schema.ts).
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseAbsoluteHttpUrl(value: unknown): URL | null {
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

function isDevelopmentOrigin(url: URL): boolean {
  return url.protocol === "http:" && DEV_LOCALHOST_HOSTNAMES.has(url.hostname);
}

function isAbsoluteProtocolUrl(value: unknown): boolean {
  const url = parseAbsoluteHttpUrl(value);
  if (url === null) {
    return false;
  }
  return url.protocol === "https:" || isDevelopmentOrigin(url);
}

function isAbsoluteOrigin(value: unknown): boolean {
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

function normalizeOrigin(value: string): string {
  return value.replace(/\/+$/, "");
}

const EMAIL_PATTERN = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const SHA256_HEX_PATTERN = /^sha256:[0-9a-f]{64}$/;

function sha256Prefixed(content: string): string {
  return `sha256:${createHash("sha256").update(content, "utf8").digest("hex")}`;
}

// ---------------------------------------------------------------------------
// Result model.
// ---------------------------------------------------------------------------

type CheckStatus = "pass" | "fail" | "warn" | "skip";

interface Check {
  id: string;
  title: string;
  status: CheckStatus;
  message: string;
  expected?: string;
  actual?: string;
  path?: string;
}

interface Probe {
  id: string;
  kind: "jwks" | "endpoint";
  target: string;
  status: "pass" | "fail" | "skip";
  message: string;
}

interface DocumentMetadata {
  protocol: string | null;
  audience: string | null;
  providerName: string | null;
  signupEndpoint: string | null;
  terms: { version: string | null; url: string | null; sha256: string | null } | null;
}

interface RunResult {
  mode: "file" | "url";
  source: string;
  input: string;
  valid: boolean;
  exitCode: number;
  document: unknown | null;
  metadata: DocumentMetadata | null;
  checks: Check[];
  probes: Probe[];
  fetchFailure: string | null;
}

interface ParsedOptions {
  input: string | null;
  json: boolean;
  help: boolean;
  probeJwks: boolean;
  probeEndpoints: boolean;
  timeoutMs: number;
  maxBytes: number;
}

// ---------------------------------------------------------------------------
// CLI parsing.
// ---------------------------------------------------------------------------

class UsageError extends Error {}

function parseArgs(argv: string[]): ParsedOptions {
  const options: ParsedOptions = {
    input: null,
    json: false,
    help: false,
    probeJwks: false,
    probeEndpoints: false,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    maxBytes: DEFAULT_MAX_BYTES,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else if (arg === "--json") {
      options.json = true;
    } else if (arg === "--probe-jwks" || arg === "--probe-issuers") {
      options.probeJwks = true;
    } else if (arg === "--probe-endpoints") {
      options.probeEndpoints = true;
    } else if (arg === "--timeout") {
      const value = Number(argv[i + 1]);
      i += 1;
      if (!Number.isFinite(value) || value <= 0) {
        throw new UsageError("--timeout expects a positive number of milliseconds");
      }
      options.timeoutMs = value;
    } else if (arg.startsWith("--timeout=")) {
      const value = Number(arg.slice("--timeout=".length));
      if (!Number.isFinite(value) || value <= 0) {
        throw new UsageError("--timeout expects a positive number of milliseconds");
      }
      options.timeoutMs = value;
    } else if (arg === "--max-bytes") {
      const value = Number(argv[i + 1]);
      i += 1;
      if (!Number.isFinite(value) || value <= 0) {
        throw new UsageError("--max-bytes expects a positive number of bytes");
      }
      options.maxBytes = Math.floor(value);
    } else if (arg.startsWith("--max-bytes=")) {
      const value = Number(arg.slice("--max-bytes=".length));
      if (!Number.isFinite(value) || value <= 0) {
        throw new UsageError("--max-bytes expects a positive number of bytes");
      }
      options.maxBytes = Math.floor(value);
    } else if (arg.startsWith("-")) {
      throw new UsageError(`unknown flag: ${arg}`);
    } else if (options.input === null) {
      options.input = arg;
    } else {
      throw new UsageError(`unexpected extra argument: ${arg}`);
    }
  }

  return options;
}

function printHelp(): void {
  const lines = [
    "Discovery Conformance Validator (agent-identity-v1)",
    "",
    "Usage:",
    "  pnpm validate:discovery <url-or-file> [options]",
    "",
    "Modes:",
    "  <https://...>   fetch and validate a live discovery document (URL mode)",
    "  <path>          read and validate a local JSON file without network (file mode)",
    "",
    "Options:",
    "  --json              emit a stable machine-readable result on stdout",
    "  --probe-jwks        opt-in: fetch GET <issuer>/.well-known/jwks.json for each",
    "                      issuer and require >=1 usable verification key",
    "  --probe-endpoints   opt-in: non-destructively HEAD/OPTIONS the advertised",
    "                      agent_signup endpoint (never POST / never signup)",
    "  --timeout <ms>      per-fetch timeout (default " + DEFAULT_TIMEOUT_MS + ")",
    "  --max-bytes <n>     bounded read size per fetch (default " + DEFAULT_MAX_BYTES + ")",
    "  -h, --help          show this help",
    "",
    "Exit codes:",
    "  0  valid conformant document",
    "  1  document retrieved and parsed, but failed conformance",
    "  2  could not fetch a usable document (network/HTTP/redirect/size/parse)",
    "",
    "Safety: only the URL you provide and explicitly requested probe targets are",
    "fetched. URLs found in the document body (including under `extensions`) are",
    "never followed. `terms.text` is treated as data, never executed.",
  ];
  console.log(lines.join("\n"));
}

// ---------------------------------------------------------------------------
// Bounded, SSRF-safe fetch.
// ---------------------------------------------------------------------------

type FetchFailureKind =
  | "network"
  | "timeout"
  | "redirect"
  | "status"
  | "content-type"
  | "size";

type FetchOutcome =
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

interface FetchOptions {
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

/** Enforces the HTTPS requirement (localhost dev exception) before fetching. */
function assertFetchableUrl(rawUrl: string): string | null {
  const url = parseAbsoluteHttpUrl(rawUrl);
  if (url === null) {
    return "target is not a valid absolute http(s) URL";
  }
  if (url.protocol !== "https:" && !isDevelopmentOrigin(url)) {
    return "https is required (only http://localhost and http://127.0.0.1 are allowed for development)";
  }
  return null;
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
async function fetchResource(
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

// ---------------------------------------------------------------------------
// Scope-boundary scan (spec §5.3 / §3.4).
// ---------------------------------------------------------------------------

interface ForbiddenFinding {
  path: string;
  key: string;
  reason: string;
}

const FORBIDDEN_EXACT_KEYS: ReadonlyMap<string, string> = new Map([
  ["instance_catalog", "vendor product catalog"],
  ["instance_catalogs", "vendor product catalog"],
  ["provision", "resource provisioning endpoint (endpoints.provision is removed)"],
  ["provisioning", "resource provisioning surface"],
  ["email_signup", "legacy vendor email signup endpoint"],
  ["verify_otp", "legacy vendor OTP verification endpoint"],
  ["verify_email", "legacy vendor email verification endpoint"],
  ["broker_signup_receipt", "broker receipt callback (Contract F, not discovery)"],
  ["endpoint_url", "vendor resource endpoint"],
  ["api_key", "vendor resource credential"],
  ["api_secret", "vendor resource credential"],
  ["access_key", "vendor resource credential"],
]);

const FORBIDDEN_TOKENS: ReadonlyMap<string, string> = new Map([
  ["catalog", "vendor product catalog"],
  ["catalogs", "vendor product catalog"],
  ["sku", "product SKU"],
  ["skus", "product SKU"],
  ["pricing", "vendor pricing metadata"],
  ["price", "vendor pricing metadata"],
  ["tier", "vendor pricing tier"],
  ["tiers", "vendor pricing tier"],
  ["quota", "free-tier quota"],
  ["quotas", "free-tier quota"],
  ["provision", "resource provisioning surface"],
  ["provisioning", "resource provisioning surface"],
  ["resource", "vendor resource metadata"],
  ["resources", "vendor resource metadata"],
  ["credential", "vendor resource credential"],
  ["credentials", "vendor resource credential"],
  ["instance", "vendor instance metadata"],
  ["instances", "vendor instance metadata"],
  ["lifecycle", "vendor instance lifecycle"],
  ["secret", "vendor credential/secret"],
  ["password", "vendor credential/secret"],
]);

function tokenizeKey(key: string): string[] {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 0);
}

function forbiddenReason(key: string): string | null {
  const lower = key.toLowerCase();
  const exact = FORBIDDEN_EXACT_KEYS.get(lower);
  if (exact !== undefined) {
    return exact;
  }
  for (const token of tokenizeKey(key)) {
    const reason = FORBIDDEN_TOKENS.get(token);
    if (reason !== undefined) {
      return reason;
    }
  }
  return null;
}

function childPath(base: string, key: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key)
    ? `${base}.${key}`
    : `${base}[${JSON.stringify(key)}]`;
}

function scanForbidden(node: unknown, path: string, out: ForbiddenFinding[]): void {
  if (Array.isArray(node)) {
    node.forEach((value, index) => scanForbidden(value, `${path}[${index}]`, out));
    return;
  }
  if (!isRecord(node)) {
    return;
  }
  for (const [key, value] of Object.entries(node)) {
    const child = childPath(path, key);
    const reason = forbiddenReason(key);
    if (reason !== null) {
      out.push({ path: child, key, reason });
    }
    scanForbidden(value, child, out);
  }
}

// ---------------------------------------------------------------------------
// JSON Schema (subset) evaluator — used only to detect divergence from Zod.
// ---------------------------------------------------------------------------

interface SchemaError {
  path: string;
  message: string;
}

function resolveJsonPointer(root: unknown, ref: string): unknown {
  if (!ref.startsWith("#/")) {
    return undefined;
  }
  const parts = ref
    .slice(2)
    .split("/")
    .map((part) => part.replace(/~1/g, "/").replace(/~0/g, "~"));
  let current: unknown = root;
  for (const part of parts) {
    if (!isRecord(current) && !Array.isArray(current)) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function jsonTypeOf(value: unknown): string {
  if (value === null) {
    return "null";
  }
  if (Array.isArray(value)) {
    return "array";
  }
  return typeof value;
}

function matchesJsonType(value: unknown, type: string): boolean {
  if (type === "integer") {
    return typeof value === "number" && Number.isInteger(value);
  }
  return jsonTypeOf(value) === type;
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function deepEqual(a: unknown, b: unknown): boolean {
  return stableStringify(a) === stableStringify(b);
}

// --- JSON Schema `format: date-time` (ajv-formats `full`-mode parity) -------
//
// The checked-in JSON Schema declares `updated_at` as `format: date-time`. A
// real `ajv` + `ajv-formats` run evaluates that format, so this subset
// evaluator mirrors it in order to keep its Zod-divergence signal honest
// instead of claiming an agreement it cannot check (review wave4-07 MINOR-1).
//
// It is deliberately NOT the same predicate as the authoritative Zod
// `z.string().datetime({ offset: true })` used by `AgentSignupDiscoverySchema`:
// ajv-formats accepts a lowercase `t`/`z` and a space separator and rejects an
// out-of-range offset, while Zod requires an uppercase `T` and a `Z`/numeric
// offset and (by regex) accepts `+25:00`. Where the two differ, Zod plus the
// written spec (§5.2) win, and the `schema.json-schema` check reports the
// divergence rather than overstating agreement.

const JSON_SCHEMA_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const JSON_SCHEMA_TIME_PATTERN =
  /^(\d{2}):(\d{2}):(\d{2}(?:\.\d+)?)(z|([+-])(\d{2})(?::?(\d{2}))?)?$/i;
const JSON_SCHEMA_DAYS_IN_MONTH = [0, 31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function isJsonSchemaFullDate(value: string): boolean {
  const match = JSON_SCHEMA_DATE_PATTERN.exec(value);
  if (match === null) {
    return false;
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const daysInMonth =
    month === 2 && isLeapYear(year) ? 29 : JSON_SCHEMA_DAYS_IN_MONTH[month] ?? 0;
  return month >= 1 && month <= 12 && day >= 1 && day <= daysInMonth;
}

function isJsonSchemaFullTime(value: string): boolean {
  const match = JSON_SCHEMA_TIME_PATTERN.exec(value);
  if (match === null) {
    return false;
  }
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  const second = Number(match[3]);
  const offset = match[4];
  const offsetSign = match[5] === "-" ? -1 : 1;
  const offsetHour = Number(match[6] ?? 0);
  const offsetMinute = Number(match[7] ?? 0);
  // `full` mode requires an explicit, range-checked timezone.
  if (offset === undefined || offsetHour > 23 || offsetMinute > 59) {
    return false;
  }
  if (hour <= 23 && minute <= 59 && second < 60) {
    return true;
  }
  // RFC 3339 permits a leap second only at 23:59:60 UTC.
  const utcMinute = minute - offsetMinute * offsetSign;
  const utcHour = hour - offsetHour * offsetSign - (utcMinute < 0 ? 1 : 0);
  return (
    (utcHour === 23 || utcHour === -1) &&
    (utcMinute === 59 || utcMinute === -1) &&
    second < 61
  );
}

function isJsonSchemaDateTime(value: string): boolean {
  const parts = value.split(/t|\s/i);
  return (
    parts.length === 2 &&
    isJsonSchemaFullDate(parts[0]) &&
    isJsonSchemaFullTime(parts[1])
  );
}

function validateJsonSchema(
  node: unknown,
  schema: unknown,
  root: unknown,
  path: string,
  errors: SchemaError[],
): void {
  if (schema === true || schema === undefined) {
    return;
  }
  if (schema === false) {
    errors.push({ path, message: "must not be present" });
    return;
  }
  if (!isRecord(schema)) {
    return;
  }

  if (typeof schema.$ref === "string") {
    validateJsonSchema(node, resolveJsonPointer(root, schema.$ref), root, path, errors);
    return;
  }

  if (typeof schema.type === "string" && !matchesJsonType(node, schema.type)) {
    errors.push({ path, message: `must be of type ${schema.type}` });
    return;
  }

  if ("const" in schema && !deepEqual(node, schema.const)) {
    errors.push({ path, message: `must equal ${JSON.stringify(schema.const)}` });
  }

  if (
    typeof schema.minLength === "number" &&
    typeof node === "string" &&
    node.length < schema.minLength
  ) {
    errors.push({ path, message: `must be at least ${schema.minLength} characters` });
  }

  if (typeof schema.pattern === "string" && typeof node === "string") {
    try {
      if (!new RegExp(schema.pattern).test(node)) {
        errors.push({ path, message: `must match pattern ${schema.pattern}` });
      }
    } catch {
      // Ignore malformed patterns in the checked-in schema.
    }
  }

  if (schema.format === "date-time" && typeof node === "string" && !isJsonSchemaDateTime(node)) {
    errors.push({ path, message: 'must match format "date-time"' });
  }

  if (Array.isArray(node)) {
    if (typeof schema.minItems === "number" && node.length < schema.minItems) {
      errors.push({ path, message: `must contain at least ${schema.minItems} items` });
    }
    if (schema.uniqueItems === true) {
      for (let i = 0; i < node.length; i += 1) {
        for (let j = i + 1; j < node.length; j += 1) {
          if (deepEqual(node[i], node[j])) {
            errors.push({ path, message: `items must be unique (duplicate at ${i} and ${j})` });
          }
        }
      }
    }
    if (isRecord(schema.items)) {
      node.forEach((item, index) =>
        validateJsonSchema(item, schema.items, root, `${path}[${index}]`, errors),
      );
    }
    if (isRecord(schema.contains)) {
      const anyMatch = node.some((item) => {
        const probeErrors: SchemaError[] = [];
        validateJsonSchema(item, schema.contains, root, path, probeErrors);
        return probeErrors.length === 0;
      });
      if (!anyMatch) {
        errors.push({ path, message: "must contain a matching item" });
      }
    }
  }

  if (isRecord(node)) {
    if (Array.isArray(schema.required)) {
      for (const required of schema.required) {
        if (typeof required === "string" && !(required in node)) {
          errors.push({ path, message: `missing required property "${required}"` });
        }
      }
    }
    const properties = isRecord(schema.properties) ? schema.properties : {};
    for (const [key, value] of Object.entries(node)) {
      const child = childPath(path, key);
      if (key in properties) {
        validateJsonSchema(value, properties[key], root, child, errors);
      } else if (schema.additionalProperties === false) {
        errors.push({ path, message: `additional property "${key}" is not allowed` });
      } else if (isRecord(schema.additionalProperties)) {
        validateJsonSchema(value, schema.additionalProperties, root, child, errors);
      }
    }
  }
}

function loadJsonSchema(): unknown | null {
  try {
    const schemaPath = fileURLToPath(
      new URL("../agent-signup.schema.json", import.meta.url),
    );
    return JSON.parse(readFileSync(schemaPath, "utf8"));
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Document checks.
// ---------------------------------------------------------------------------

/** Top-level fields defined by the identity-only v1 spec (§5.1/§5.2). */
const ALLOWED_TOP_LEVEL_FIELDS = new Set([
  "protocol",
  "spec",
  "audience",
  "provider_name",
  "provider_url",
  "contact",
  "updated_at",
  "issuer_allowlist",
  "required_scopes",
  "terms",
  "endpoints",
  "extensions",
]);

/** Reverse-DNS namespace: at least two dot-separated labels (for example `dev.vaporcloud`). */
const REVERSE_DNS_PATTERN =
  /^[a-z]([a-z0-9-]*[a-z0-9])?(\.[a-z]([a-z0-9-]*[a-z0-9])?)+$/i;

function addCheck(checks: Check[], check: Check): void {
  checks.push(check);
}

function ok(id: string, title: string, message: string, extra?: Partial<Check>): Check {
  return { id, title, status: "pass", message, ...extra };
}

function fail(id: string, title: string, message: string, extra?: Partial<Check>): Check {
  return { id, title, status: "fail", message, ...extra };
}

function warnCheck(id: string, title: string, message: string): Check {
  return { id, title, status: "warn", message };
}

function skip(id: string, title: string, message: string): Check {
  return { id, title, status: "skip", message };
}

function formatZodIssue(issue: { path: (string | number)[]; message: string }): string {
  const path = issue.path.length > 0 ? issue.path.join(".") : "(root)";
  return `${path}: ${issue.message}`;
}

function checkProtocol(document: Record<string, unknown>): Check {
  const value = document.protocol;
  if (value === "agent-identity-v1") {
    return ok("field.protocol", "protocol", "protocol is exactly `agent-identity-v1`");
  }
  return fail(
    "field.protocol",
    "protocol",
    `protocol must be exactly "agent-identity-v1" (any other value means unsupported, never best-effort)`,
    { expected: "agent-identity-v1", actual: JSON.stringify(value ?? null) },
  );
}

function checkAudience(document: Record<string, unknown>): Check {
  const value = document.audience;
  if (typeof value === "string" && value.length > 0 && !/\s/.test(value)) {
    return ok("field.audience", "audience", `audience is a stable service identifier (${value})`);
  }
  return fail(
    "field.audience",
    "audience",
    "audience must be a non-empty, whitespace-free string placed verbatim in the assertion `aud`",
    { actual: JSON.stringify(value ?? null) },
  );
}

function checkProviderName(document: Record<string, unknown>): Check {
  const value = document.provider_name;
  if (typeof value === "string" && value.length > 0) {
    return ok("field.provider_name", "provider_name", `provider_name is present (${value})`);
  }
  return fail(
    "field.provider_name",
    "provider_name",
    "provider_name must be a non-empty human-readable string",
    { actual: JSON.stringify(value ?? null) },
  );
}

function checkIssuerAllowlist(document: Record<string, unknown>): Check {
  const value = document.issuer_allowlist;
  if (!Array.isArray(value) || value.length === 0) {
    return fail(
      "field.issuer_allowlist",
      "issuer_allowlist",
      "issuer_allowlist must be a non-empty array of absolute issuer origins",
      { actual: JSON.stringify(value ?? null) },
    );
  }
  const problems: string[] = [];
  value.forEach((entry, index) => {
    if (!isAbsoluteOrigin(entry)) {
      problems.push(
        `[${index}] ${JSON.stringify(entry)} is not an absolute origin (https unless localhost; no path, query, fragment, or wildcard)`,
      );
    }
  });
  const normalized = value.map((entry) => normalizeOrigin(String(entry)));
  if (new Set(normalized).size !== normalized.length) {
    problems.push("entries must be unique after trailing-slash normalization");
  }
  if (problems.length > 0) {
    return fail(
      "field.issuer_allowlist",
      "issuer_allowlist",
      problems.join("; "),
    );
  }
  return ok(
    "field.issuer_allowlist",
    "issuer_allowlist",
    `issuer_allowlist has ${value.length} absolute issuer origin(s), no wildcards`,
  );
}

function checkRequiredScopes(document: Record<string, unknown>): Check {
  const value = document.required_scopes;
  if (!Array.isArray(value) || value.length === 0) {
    return fail(
      "field.required_scopes",
      "required_scopes",
      "required_scopes must be a non-empty array of unique, non-empty scope strings",
      { actual: JSON.stringify(value ?? null) },
    );
  }
  const problems: string[] = [];
  value.forEach((entry, index) => {
    if (typeof entry !== "string" || entry.length === 0) {
      problems.push(`[${index}] must be a non-empty string`);
    }
  });
  const strings = value.filter((entry): entry is string => typeof entry === "string");
  if (new Set(strings).size !== strings.length) {
    problems.push("entries must be unique");
  }
  if (!strings.includes("tos:accept")) {
    problems.push("must include `tos:accept`");
  }
  if (problems.length > 0) {
    return fail("field.required_scopes", "required_scopes", problems.join("; "));
  }
  return ok(
    "field.required_scopes",
    "required_scopes",
    `required_scopes is unique and includes \`tos:accept\` (${value.length} scope(s))`,
  );
}

function checkTerms(document: Record<string, unknown>): Check {
  const terms = document.terms;
  if (!isRecord(terms)) {
    return fail("field.terms", "terms", "terms must be an object with version, url, sha256, and text", {
      actual: JSON.stringify(terms ?? null),
    });
  }
  const problems: string[] = [];
  if (typeof terms.version !== "string" || terms.version.length === 0) {
    problems.push("terms.version must be a non-empty string");
  }
  if (!isAbsoluteProtocolUrl(terms.url)) {
    problems.push("terms.url must be an absolute protocol URL (https, localhost dev exception)");
  }
  if (typeof terms.sha256 !== "string" || !SHA256_HEX_PATTERN.test(terms.sha256)) {
    problems.push("terms.sha256 must use the form `sha256:<64 lowercase hex characters>`");
  }
  if (typeof terms.text !== "string" || terms.text.length === 0) {
    problems.push("terms.text must be the complete, non-empty ToS text");
  }
  if (problems.length > 0) {
    return fail("field.terms", "terms", problems.join("; "));
  }
  return ok("field.terms", "terms", "terms.version, terms.url, terms.sha256, and terms.text have valid shapes");
}

function checkTermsHash(document: Record<string, unknown>): Check {
  const terms = document.terms;
  if (!isRecord(terms) || typeof terms.text !== "string" || terms.text.length === 0) {
    return skip(
      "field.terms.sha256",
      "terms.sha256 recompute",
      "cannot recompute the digest: terms.text is missing or empty",
    );
  }
  if (typeof terms.sha256 !== "string") {
    return skip(
      "field.terms.sha256",
      "terms.sha256 recompute",
      "cannot compare the digest: terms.sha256 is missing",
    );
  }
  const expected = sha256Prefixed(terms.text);
  if (terms.sha256 === expected) {
    return ok(
      "field.terms.sha256",
      "terms.sha256 recompute",
      `terms.sha256 matches the SHA-256 of the exact UTF-8 bytes of terms.text (${expected})`,
    );
  }
  return fail(
    "field.terms.sha256",
    "terms.sha256 recompute",
    "terms.sha256 must equal the SHA-256 of the exact UTF-8 bytes of terms.text (no normalization, trimming, or HTML extraction)",
    { expected, actual: terms.sha256 },
  );
}

function checkAgentSignup(document: Record<string, unknown>): Check {
  const endpoints = document.endpoints;
  if (!isRecord(endpoints)) {
    return fail(
      "field.endpoints.agent_signup",
      "endpoints.agent_signup",
      "endpoints must be an object containing the absolute agent_signup URL",
      { actual: JSON.stringify(endpoints ?? null) },
    );
  }
  const value = endpoints.agent_signup;
  if (!isAbsoluteProtocolUrl(value)) {
    return fail(
      "field.endpoints.agent_signup",
      "endpoints.agent_signup",
      "endpoints.agent_signup must be an absolute protocol URL (https, localhost dev exception)",
      { actual: JSON.stringify(value ?? null) },
    );
  }
  return ok(
    "field.endpoints.agent_signup",
    "endpoints.agent_signup",
    `endpoints.agent_signup is an absolute URL (${String(value)})`,
  );
}

/**
 * Authoritative `updated_at` shape check. Reuses the exact field schema from
 * `AgentSignupDiscoverySchema` (`z.string().datetime({ offset: true })`), so the
 * `field.optional` verdict and message can never disagree with the `schema.zod`
 * check: a bare date, a naive local time (no offset), a human-readable string,
 * or any other non-RFC-3339 form fails both with the same wording.
 *
 * The JSON Schema expresses this field as `format: date-time`, which
 * `ajv-formats` interprets slightly differently (it accepts a lowercase `t`/`z`
 * and a space separator but rejects a missing timezone and an out-of-range
 * offset). The two are intentionally not forced into agreement: Zod and the
 * written spec are authoritative, and `isJsonSchemaDateTime` mirrors the JSON
 * Schema side so the `schema.json-schema` check surfaces divergence rather than
 * overstating agreement (review wave4-07 MINOR-1).
 */
function isValidUpdatedAt(value: unknown): boolean {
  return AgentSignupDiscoverySchema.shape.updated_at.safeParse(value).success;
}

function checkOptionalFields(document: Record<string, unknown>): Check {
  const problems: string[] = [];
  for (const field of ["spec", "provider_url"] as const) {
    if (field in document && !isAbsoluteProtocolUrl(document[field])) {
      problems.push(`${field} must be an absolute protocol URL when present`);
    }
  }
  if ("contact" in document) {
    const contact = document.contact;
    const validContact =
      typeof contact === "string" &&
      contact.length > 0 &&
      (EMAIL_PATTERN.test(contact) || isAbsoluteProtocolUrl(contact));
    if (!validContact) {
      problems.push("contact must be an email address or an absolute http(s) URL");
    }
  }
  if ("updated_at" in document) {
    if (!isValidUpdatedAt(document.updated_at)) {
      problems.push("updated_at must be a valid RFC 3339 date-time");
    }
  }
  if (problems.length > 0) {
    return fail("field.optional", "optional fields", problems.join("; "));
  }
  return ok(
    "field.optional",
    "optional fields",
    "optional spec, provider_url, contact, and updated_at have valid shapes",
  );
}

function checkScopeBoundary(findings: ForbiddenFinding[]): Check {
  if (findings.length === 0) {
    return ok(
      "scope.forbidden-fields",
      "scope boundary",
      "no forbidden vendor capability fields found at any depth (including under extensions)",
    );
  }
  const detail = findings
    .slice(0, 20)
    .map((finding) => `${finding.path} (${finding.reason})`)
    .join("; ");
  const suffix = findings.length > 20 ? `; and ${findings.length - 20} more` : "";
  return fail(
    "scope.forbidden-fields",
    "scope boundary",
    `forbidden vendor capability surface: ${detail}${suffix}. Vendor capabilities belong in the post-signup context guide, not discovery.`,
  );
}

function checkUnknownTopLevel(document: Record<string, unknown>, forbiddenTopLevel: Set<string>): Check {
  const unknown = Object.keys(document).filter(
    (key) => !ALLOWED_TOP_LEVEL_FIELDS.has(key) && !forbiddenTopLevel.has(key),
  );
  if (unknown.length === 0) {
    return ok("warn.unknown-top-level-fields", "unknown top-level fields", "no unknown top-level fields");
  }
  return warnCheck(
    "warn.unknown-top-level-fields",
    "unknown top-level fields",
    `unknown top-level field(s) ignored by conformant consumers: ${unknown.join(", ")}`,
  );
}

function checkExtensionsNamespace(document: Record<string, unknown>): Check {
  if (!("extensions" in document)) {
    return skip(
      "warn.extensions-namespace",
      "extensions namespaces",
      "no extensions object present",
    );
  }
  const extensions = document.extensions;
  if (!isRecord(extensions)) {
    return fail(
      "warn.extensions-namespace",
      "extensions namespaces",
      "extensions must be an object keyed by reverse-DNS namespace",
      { actual: JSON.stringify(extensions ?? null) },
    );
  }
  const bad = Object.keys(extensions).filter((key) => !REVERSE_DNS_PATTERN.test(key));
  if (bad.length === 0) {
    return ok(
      "warn.extensions-namespace",
      "extensions namespaces",
      "every extensions key is a reverse-DNS namespace",
    );
  }
  return warnCheck(
    "warn.extensions-namespace",
    "extensions namespaces",
    `extensions key(s) are not reverse-DNS namespaced (for example dev.vendor): ${bad.join(", ")}`,
  );
}

function checkUnknownEndpoints(document: Record<string, unknown>, forbiddenEndpoints: Set<string>): Check {
  const endpoints = document.endpoints;
  if (!isRecord(endpoints)) {
    return skip("warn.unknown-endpoint-fields", "unknown endpoint fields", "no endpoints object present");
  }
  const unknown = Object.keys(endpoints).filter(
    (key) => key !== "agent_signup" && !forbiddenEndpoints.has(key),
  );
  if (unknown.length === 0) {
    return ok(
      "warn.unknown-endpoint-fields",
      "unknown endpoint fields",
      "no unrecognized endpoint fields",
    );
  }
  return warnCheck(
    "warn.unknown-endpoint-fields",
    "unknown endpoint fields",
    `unknown endpoint field(s) ignored by conformant consumers: ${unknown.join(", ")}`,
  );
}

function buildMetadata(document: Record<string, unknown>): DocumentMetadata {
  const terms = isRecord(document.terms) ? document.terms : null;
  const endpoints = isRecord(document.endpoints) ? document.endpoints : null;
  return {
    protocol: typeof document.protocol === "string" ? document.protocol : null,
    audience: typeof document.audience === "string" ? document.audience : null,
    providerName: typeof document.provider_name === "string" ? document.provider_name : null,
    signupEndpoint:
      endpoints && typeof endpoints.agent_signup === "string" ? endpoints.agent_signup : null,
    terms: terms
      ? {
          version: typeof terms.version === "string" ? terms.version : null,
          url: typeof terms.url === "string" ? terms.url : null,
          sha256: typeof terms.sha256 === "string" ? terms.sha256 : null,
        }
      : null,
  };
}

/**
 * Runs every document-level check and the optional probes.
 *
 * `inputOrigin` is the origin of the top-level input the user supplied (or
 * `null` in file mode). It gates the probes' development exception: a
 * body-derived target on a loopback/link-local/private hostname, and any plain
 * `http://` target, is only probed when the input itself is a
 * localhost/127.0.0.1 origin (review wave4-07-03 MINOR-2 and wave4-07 MINOR-2).
 */
async function checkDocument(
  document: unknown,
  options: ParsedOptions,
  transportChecks: Check[],
  inputOrigin: URL | null,
): Promise<{ checks: Check[]; probes: Probe[]; metadata: DocumentMetadata | null }> {
  const checks: Check[] = [...transportChecks];

  const documentIsObject = isRecord(document);
  addCheck(
    checks,
    documentIsObject
      ? ok("json.parse", "json.parse", "parsed JSON object")
      : fail("json.parse", "json.parse", "the discovery document must be a JSON object"),
  );

  if (!documentIsObject) {
    return { checks, probes: [], metadata: null };
  }

  const zodResult = AgentSignupDiscoverySchema.safeParse(document);
  if (zodResult.success) {
    addCheck(checks, ok("schema.zod", "schema (Zod)", "matches AgentSignupDiscoverySchema"));
  } else {
    const issues = zodResult.error.issues.map(formatZodIssue);
    addCheck(
      checks,
      fail(
        "schema.zod",
        "schema (Zod)",
        `failed AgentSignupDiscoverySchema: ${issues.join("; ")}`,
      ),
    );
  }

  const jsonSchema = loadJsonSchema();
  if (jsonSchema === null) {
    addCheck(
      checks,
      skip("schema.json-schema", "schema (JSON Schema)", "checked-in JSON Schema could not be loaded"),
    );
  } else {
    const schemaErrors: SchemaError[] = [];
    validateJsonSchema(document, jsonSchema, jsonSchema, "$", schemaErrors);
    const jsonSchemaValid = schemaErrors.length === 0;
    const zodValid = zodResult.success;
    if (zodValid === jsonSchemaValid) {
      addCheck(
        checks,
        ok(
          "schema.json-schema",
          "schema (JSON Schema)",
          zodValid
            ? "checked-in JSON Schema agrees with Zod (valid under both)"
            : "checked-in JSON Schema agrees with Zod (rejected by both)",
        ),
      );
    } else {
      const detail = jsonSchemaValid
        ? "the checked-in JSON Schema accepts this document but the authoritative Zod schema rejects it"
        : "the authoritative Zod schema accepts this document but the checked-in JSON Schema rejects it";
      const errors = schemaErrors.slice(0, 10).map((error) => `${error.path}: ${error.message}`);
      const errorDetail =
        errors.length > 0
          ? ` JSON Schema errors: ${errors.join("; ")}.`
          : " (the JSON Schema reports no errors; Zod enforces a cross-field invariant the JSON Schema leaves to it).";
      addCheck(
        checks,
        warnCheck(
          "schema.json-schema",
          "schema (JSON Schema)",
          `${detail}; Zod + written spec win.${errorDetail}`,
        ),
      );
    }
  }

  addCheck(checks, checkProtocol(document));
  addCheck(checks, checkAudience(document));
  addCheck(checks, checkProviderName(document));
  addCheck(checks, checkIssuerAllowlist(document));
  addCheck(checks, checkRequiredScopes(document));
  addCheck(checks, checkTerms(document));
  addCheck(checks, checkTermsHash(document));
  addCheck(checks, checkAgentSignup(document));

  const findings: ForbiddenFinding[] = [];
  scanForbidden(document, "$", findings);
  const forbiddenTopLevel = new Set(
    Object.keys(document).filter((key) => forbiddenReason(key) !== null),
  );
  const forbiddenEndpoints = new Set(
    isRecord(document.endpoints)
      ? Object.keys(document.endpoints).filter((key) => forbiddenReason(key) !== null)
      : [],
  );

  addCheck(checks, checkOptionalFields(document));
  addCheck(checks, checkScopeBoundary(findings));
  addCheck(checks, checkUnknownTopLevel(document, forbiddenTopLevel));
  addCheck(checks, checkExtensionsNamespace(document));
  addCheck(checks, checkUnknownEndpoints(document, forbiddenEndpoints));

  const probes: Probe[] = [];
  if (options.probeJwks) {
    const allowlist = document.issuer_allowlist;
    if (Array.isArray(allowlist)) {
      for (const issuer of allowlist) {
        if (typeof issuer === "string" && isAbsoluteOrigin(issuer)) {
          probes.push(await probeJwks(issuer, options, inputOrigin));
        } else {
          probes.push({
            id: `probe.jwks:${String(issuer)}`,
            kind: "jwks",
            target: String(issuer),
            status: "skip",
            message: "issuer is not a valid absolute origin; probe skipped",
          });
        }
      }
    }
  }
  if (options.probeEndpoints) {
    const endpoints = document.endpoints;
    if (isRecord(endpoints) && typeof endpoints.agent_signup === "string") {
      probes.push(await probeEndpoint(endpoints.agent_signup, options, inputOrigin));
    }
  }

  return { checks, probes, metadata: buildMetadata(document) };
}

// ---------------------------------------------------------------------------
// Probes (opt-in, non-destructive).
// ---------------------------------------------------------------------------

/**
 * True when a hostname literal is loopback, link-local, or RFC 1918 private.
 * String-only: it never resolves DNS (see {@link probeTargetRefusal}).
 */
function isPrivateIpv4Literal(hostname: string): boolean {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(hostname);
  if (match === null) {
    return false;
  }
  const octets = match.slice(1).map(Number);
  if (octets.some((octet) => octet > 255)) {
    return false;
  }
  const a = octets[0] ?? 0;
  const b = octets[1] ?? 0;
  return (
    a === 0 || // 0.0.0.0/8 "this network" (includes 0.0.0.0)
    a === 10 || // 10.0.0.0/8 private
    a === 127 || // 127.0.0.0/8 loopback
    (a === 169 && b === 254) || // 169.254.0.0/16 link-local
    (a === 172 && b >= 16 && b <= 31) || // 172.16.0.0/12 private
    (a === 192 && b === 168) // 192.168.0.0/16 private
  );
}

/**
 * Scheme-independent loopback/private hostname guard: `localhost`, `*.localhost`,
 * `*.local`, the loopback/link-local/RFC 1918 IPv4 ranges, and the IPv6
 * loopback/unspecified/unique-local/link-local (and IPv4-mapped) literals. The
 * WHATWG URL parser has already normalized IPv4/IPv6 literals by the time this
 * runs, so no DNS lookup is required.
 */
function isLoopbackOrPrivateHostname(rawHostname: string): boolean {
  const hostname = rawHostname.toLowerCase().replace(/\.$/, "");
  if (hostname === "") {
    return false;
  }
  if (hostname === "localhost" || hostname.endsWith(".localhost")) {
    return true;
  }
  if (hostname.endsWith(".local")) {
    return true;
  }
  if (hostname.startsWith("[") && hostname.endsWith("]")) {
    const ipv6 = hostname.slice(1, -1);
    if (ipv6 === "::1" || ipv6 === "::") {
      return true; // loopback / unspecified
    }
    if (/^fe[89ab]/i.test(ipv6) || /^f[cd]/i.test(ipv6)) {
      return true; // fe80::/10 link-local, fc00::/7 unique-local
    }
    const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(ipv6);
    if (mapped !== null) {
      const high = Number.parseInt(mapped[1], 16);
      const low = Number.parseInt(mapped[2], 16);
      return isPrivateIpv4Literal(
        `${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`,
      );
    }
    return false;
  }
  return isPrivateIpv4Literal(hostname);
}

/**
 * Probes fetch targets taken from the **document body**. Two gates apply:
 *
 * 1. A plain `http:` target is refused unless the top-level input origin itself
 *    is a localhost/127.0.0.1 development origin *and* the target is a
 *    localhost/127.0.0.1 host (review wave4-07-03 MINOR-2).
 * 2. A target on a loopback/link-local/private hostname is refused **regardless
 *    of scheme** unless the top-level input origin itself is a
 *    localhost/127.0.0.1 development origin, so a document served from a public
 *    origin can never steer an opt-in probe at `https://127.0.0.1/`,
 *    `https://10.0.0.5/`, `https://169.254.169.254/`, `https://foo.local/`, etc.
 *    (review wave4-07 MINOR-2).
 *
 * This is a hostname-string check only: it does not resolve DNS, so it does not
 * defend against DNS rebinding (a public hostname that resolves to a private
 * address); redirects are separately constrained to the original origin by
 * {@link fetchResource}. Probes remain opt-in and non-destructive
 * (GET/HEAD/OPTIONS only). Returns a refusal message, or `null` when the target
 * may be probed.
 */
function probeTargetRefusal(
  target: string,
  inputOrigin: URL | null,
): string | null {
  const url = parseAbsoluteHttpUrl(target);
  if (url === null) {
    return null; // non-http(s)/malformed targets are reported by fetchResource.
  }
  const inputIsLocalhost =
    inputOrigin !== null && DEV_LOCALHOST_HOSTNAMES.has(inputOrigin.hostname);
  const targetIsDevHost = DEV_LOCALHOST_HOSTNAMES.has(url.hostname);
  const targetIsPrivate = isLoopbackOrPrivateHostname(url.hostname);

  if (url.protocol === "http:") {
    if (inputIsLocalhost && targetIsDevHost) {
      return null;
    }
    return (
      `refusing to probe plain http:// target from the document body (${url.origin}); ` +
      "only https targets are probed unless the input origin is localhost/127.0.0.1"
    );
  }

  if (targetIsPrivate && !inputIsLocalhost) {
    return (
      `refusing to probe loopback/private target from the document body (${url.origin}); ` +
      "probe targets must be public unless the input origin is localhost/127.0.0.1"
    );
  }

  return null;
}

function isUsableVerificationKey(key: unknown): boolean {
  if (!isRecord(key) || typeof key.kty !== "string") {
    return false;
  }
  if (key.use === "enc") {
    return false;
  }
  if ("key_ops" in key) {
    return Array.isArray(key.key_ops) && key.key_ops.includes("verify");
  }
  return true;
}

async function probeJwks(
  issuerOrigin: string,
  options: ParsedOptions,
  inputOrigin: URL | null,
): Promise<Probe> {
  const url = `${issuerOrigin.replace(/\/+$/, "")}/.well-known/jwks.json`;
  const id = `probe.jwks:${issuerOrigin}`;
  const refusal = probeTargetRefusal(issuerOrigin, inputOrigin);
  if (refusal !== null) {
    return { id, kind: "jwks", target: url, status: "skip", message: refusal };
  }
  const outcome = await fetchResource(url, {
    timeoutMs: options.timeoutMs,
    maxBytes: options.maxBytes,
    requireJson: true,
  });
  if (!outcome.ok) {
    return { id, kind: "jwks", target: url, status: "fail", message: `could not fetch JWKS: ${outcome.message}` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(outcome.text);
  } catch (error) {
    return {
      id,
      kind: "jwks",
      target: url,
      status: "fail",
      message: `JWKS is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  const keys = isRecord(parsed) && Array.isArray(parsed.keys) ? parsed.keys : null;
  if (keys === null) {
    return { id, kind: "jwks", target: url, status: "fail", message: "JWKS has no `keys` array" };
  }
  const usable = keys.filter(isUsableVerificationKey);
  if (usable.length === 0) {
    return {
      id,
      kind: "jwks",
      target: url,
      status: "fail",
      message: "JWKS contains no usable verification key (kty + use!=enc + optional key_ops verify)",
    };
  }
  return {
    id,
    kind: "jwks",
    target: url,
    status: "pass",
    message: `usable JWKS with ${usable.length} verification key(s)`,
  };
}

/**
 * Endpoint liveness: the route must actually exist. `404`/`410` (and any other
 * status outside the accepted set) fail, because `404` at the advertised signup
 * path signals the service does not implement it; `2xx`/`3xx`, `405`
 * (VaporCloud answers `HEAD` with `405`), and `401`/`403` (auth-gated but
 * routed) count as reachable. Review wave4-07-03 MINOR-1.
 */
function isEndpointProbeReachable(status: number): boolean {
  return (
    (status >= 200 && status < 400) ||
    status === 401 ||
    status === 403 ||
    status === 405
  );
}

async function probeEndpoint(
  rawUrl: string,
  options: ParsedOptions,
  inputOrigin: URL | null,
): Promise<Probe> {
  const id = `probe.endpoint:${rawUrl}`;
  const refusal = probeTargetRefusal(rawUrl, inputOrigin);
  if (refusal !== null) {
    return { id, kind: "endpoint", target: rawUrl, status: "skip", message: refusal };
  }

  // Non-destructive only: HEAD first, then OPTIONS. Never POST.
  for (const method of ["HEAD", "OPTIONS"] as const) {
    const outcome = await fetchResource(rawUrl, {
      timeoutMs: options.timeoutMs,
      maxBytes: options.maxBytes,
      requireJson: false,
      method,
      acceptStatus: isEndpointProbeReachable,
      followRedirects: false,
    });
    if (outcome.ok) {
      return {
        id,
        kind: "endpoint",
        target: rawUrl,
        status: "pass",
        message: `${method} ${outcome.status} (reachable; no side effect probed)`,
      };
    }
    if (outcome.kind !== "status") {
      // Network/timeout failure: try the next method once, then give up.
      if (method === "OPTIONS") {
        return { id, kind: "endpoint", target: rawUrl, status: "fail", message: `unreachable: ${outcome.message}` };
      }
    } else if (method === "OPTIONS") {
      return { id, kind: "endpoint", target: rawUrl, status: "fail", message: outcome.message };
    }
  }
  return { id, kind: "endpoint", target: rawUrl, status: "fail", message: "unreachable via HEAD or OPTIONS" };
}

// ---------------------------------------------------------------------------
// Transport checks (URL mode).
// ---------------------------------------------------------------------------

function buildTransportChecks(outcome: {
  headers: Headers;
  redirects: number;
  bytes: number;
  finalUrl: string;
}): Check[] {
  const checks: Check[] = [];
  addCheck(
    checks,
    ok("transport.status", "transport.status", "GET returned 200 OK"),
  );
  addCheck(
    checks,
    ok("transport.content-type", "transport.content-type", "Content-Type is application/json"),
  );
  addCheck(
    checks,
    ok(
      "transport.redirects",
      "transport.redirects",
      outcome.redirects === 0
        ? "no redirects (redirects SHOULD NOT be used)"
        : `${outcome.redirects} same-origin redirect(s), within the ${MAX_REDIRECTS}-hop limit`,
    ),
  );
  addCheck(
    checks,
    outcome.bytes <= DEFAULT_MAX_BYTES
      ? ok("transport.size", "transport.size", `body is ${outcome.bytes} byte(s), within the 1 MiB cap`)
      : fail("transport.size", "transport.size", `body is ${outcome.bytes} byte(s), over the 1 MiB cap`),
  );

  const cacheControl = outcome.headers.get("cache-control") ?? "";
  const maxAgeMatch = /max-age=(\d+)/i.exec(cacheControl);
  const maxAge = maxAgeMatch ? Number(maxAgeMatch[1]) : null;
  if (maxAge !== null && maxAge <= 300 && /public/i.test(cacheControl)) {
    addCheck(
      checks,
      ok("transport.cache-control", "transport.cache-control", `Cache-Control: ${cacheControl}`),
    );
  } else if (maxAge !== null && maxAge > 300) {
    addCheck(
      checks,
      warnCheck(
        "transport.cache-control",
        "transport.cache-control",
        `Cache-Control max-age=${maxAge} exceeds the recommended maximum of 300 (${cacheControl || "(none)"})`,
      ),
    );
  } else {
    addCheck(
      checks,
      warnCheck(
        "transport.cache-control",
        "transport.cache-control",
        `recommended Cache-Control: public, max-age=60 (maximum 300); received ${cacheControl || "(none)"}`,
      ),
    );
  }

  const cors = outcome.headers.get("access-control-allow-origin");
  if (cors === "*") {
    addCheck(
      checks,
      ok("transport.cors", "transport.cors", "Access-Control-Allow-Origin: *"),
    );
  } else {
    addCheck(
      checks,
      warnCheck(
        "transport.cors",
        "transport.cors",
        `recommended Access-Control-Allow-Origin: * for browser/agent inspectors; received ${cors ?? "(none)"}`,
      ),
    );
  }

  return checks;
}

// ---------------------------------------------------------------------------
// Modes.
// ---------------------------------------------------------------------------

function fetchFailureResult(
  mode: "file" | "url",
  input: string,
  message: string,
): RunResult {
  return {
    mode,
    source: input,
    input,
    valid: false,
    exitCode: 2,
    document: null,
    metadata: null,
    checks: [fail("source", "source", message)],
    probes: [],
    fetchFailure: message,
  };
}

async function runFileMode(options: ParsedOptions, input: string): Promise<RunResult> {
  let size: number;
  try {
    const info = await stat(input);
    size = info.size;
  } catch (error) {
    return fetchFailureResult(
      "file",
      input,
      `could not read file: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (size > options.maxBytes) {
    return fetchFailureResult(
      "file",
      input,
      `file exceeds the ${options.maxBytes}-byte cap (${size} bytes)`,
    );
  }
  let raw: string;
  try {
    raw = await readFile(input, "utf8");
  } catch (error) {
    return fetchFailureResult(
      "file",
      input,
      `could not read file: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  let document: unknown;
  try {
    document = JSON.parse(raw);
  } catch (error) {
    return fetchFailureResult(
      "file",
      input,
      `not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const sourceCheck = ok("source", "source", `read local file (${Buffer.byteLength(raw, "utf8")} bytes)`);
  // File mode has no input origin, so body-derived `http://` probe targets are
  // never treated as a localhost development origin.
  const { checks, probes, metadata } = await checkDocument(document, options, [sourceCheck], null);
  return finish("file", input, document, checks, probes, metadata);
}

async function runUrlMode(options: ParsedOptions, input: string): Promise<RunResult> {
  const outcome = await fetchResource(input, {
    timeoutMs: options.timeoutMs,
    maxBytes: options.maxBytes,
    requireJson: true,
  });
  if (!outcome.ok) {
    return fetchFailureResult("url", input, `${outcome.kind}: ${outcome.message}`);
  }
  let document: unknown;
  try {
    document = JSON.parse(outcome.text);
  } catch (error) {
    return fetchFailureResult(
      "url",
      input,
      `could not fetch a usable document: response body is not valid JSON (${error instanceof Error ? error.message : String(error)})`,
    );
  }
  const transportChecks = buildTransportChecks(outcome);
  // The top-level input origin gates the probes' localhost dev exception.
  const { checks, probes, metadata } = await checkDocument(
    document,
    options,
    transportChecks,
    parseAbsoluteHttpUrl(input),
  );
  return finish("url", input, document, checks, probes, metadata);
}

function finish(
  mode: "file" | "url",
  input: string,
  document: unknown,
  checks: Check[],
  probes: Probe[],
  metadata: DocumentMetadata | null,
): RunResult {
  const hasFailure =
    checks.some((check) => check.status === "fail") ||
    probes.some((probe) => probe.status === "fail");
  return {
    mode,
    source: input,
    input,
    valid: !hasFailure,
    exitCode: hasFailure ? 1 : 0,
    document,
    metadata,
    checks,
    probes,
    fetchFailure: null,
  };
}

// ---------------------------------------------------------------------------
// Output.
// ---------------------------------------------------------------------------

function summarize(result: RunResult): { passed: number; failed: number; warnings: number } {
  return {
    passed: result.checks.filter((check) => check.status === "pass").length,
    failed: result.checks.filter((check) => check.status === "fail").length,
    warnings: result.checks.filter((check) => check.status === "warn").length,
  };
}

function toJson(result: RunResult): Record<string, unknown> {
  const counts = summarize(result);
  const errors = [
    ...result.checks
      .filter((check) => check.status === "fail")
      .map((check) => `${check.id}: ${check.message}`),
    ...result.probes
      .filter((probe) => probe.status === "fail")
      .map((probe) => `${probe.id}: ${probe.message}`),
  ];
  const warnings = result.checks
    .filter((check) => check.status === "warn")
    .map((check) => `${check.id}: ${check.message}`);
  return {
    validator: VALIDATOR_ID,
    validatorVersion: VALIDATOR_VERSION,
    mode: result.mode,
    source: result.source,
    valid: result.valid,
    exitCode: result.exitCode,
    protocol: result.metadata?.protocol ?? null,
    audience: result.metadata?.audience ?? null,
    providerName: result.metadata?.providerName ?? null,
    signupEndpoint: result.metadata?.signupEndpoint ?? null,
    terms: result.metadata?.terms ?? null,
    fetchFailure: result.fetchFailure,
    counts: {
      passed: counts.passed,
      failed: counts.failed,
      warnings: counts.warnings,
      probes: result.probes.length,
    },
    checks: result.checks.map((check) => ({
      id: check.id,
      title: check.title,
      status: check.status,
      message: check.message,
      ...(check.expected !== undefined ? { expected: check.expected } : {}),
      ...(check.actual !== undefined ? { actual: check.actual } : {}),
      ...(check.path !== undefined ? { path: check.path } : {}),
    })),
    probes: result.probes.map((probe) => ({
      id: probe.id,
      kind: probe.kind,
      target: probe.target,
      status: probe.status,
      message: probe.message,
    })),
    errors,
    warnings,
  };
}

function statusLabel(status: CheckStatus): string {
  switch (status) {
    case "pass":
      return "PASS";
    case "fail":
      return "FAIL";
    case "warn":
      return "WARN";
    case "skip":
      return "SKIP";
  }
}

function printHuman(result: RunResult): void {
  const lines: string[] = [];
  lines.push(`agent-identity-v1 discovery conformance validator v${VALIDATOR_VERSION}`);
  lines.push("");
  lines.push(`Source  : ${result.source}`);
  lines.push(`Mode    : ${result.mode}`);
  if (result.metadata) {
    lines.push(`Protocol: ${result.metadata.protocol ?? "(missing)"}`);
    lines.push(`Audience: ${result.metadata.audience ?? "(missing)"}`);
  }
  lines.push("");

  const width = Math.max(...result.checks.map((check) => check.id.length), 4);
  lines.push("CHECKS");
  for (const check of result.checks) {
    lines.push(`  [${statusLabel(check.status)}] ${check.id.padEnd(width)}  ${check.message}`);
    if (check.expected !== undefined || check.actual !== undefined) {
      if (check.expected !== undefined) {
        lines.push(`         expected: ${check.expected}`);
      }
      if (check.actual !== undefined) {
        lines.push(`         actual:   ${check.actual}`);
      }
    }
  }

  lines.push("");
  lines.push("PROBES");
  if (result.probes.length === 0) {
    lines.push("  (none; pass --probe-jwks and/or --probe-endpoints to enable opt-in probes)");
  } else {
    for (const probe of result.probes) {
      lines.push(`  [${statusLabel(probe.status)}] ${probe.kind} ${probe.target} — ${probe.message}`);
    }
  }

  const counts = summarize(result);
  const verdict =
    result.exitCode === 0
      ? "VALID"
      : result.exitCode === 2
        ? "COULD NOT FETCH"
        : "INVALID";
  lines.push("");
  lines.push(
    `RESULT: ${verdict} — ${counts.failed} failure(s), ${counts.warnings} warning(s), exit ${result.exitCode}`,
  );
  console.log(lines.join("\n"));
}

// ---------------------------------------------------------------------------
// Entry point.
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  let options: ParsedOptions;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    console.error("Run `pnpm validate:discovery --help` for usage.");
    process.exitCode = 2;
    return;
  }

  if (options.help || options.input === null) {
    printHelp();
    process.exitCode = options.help ? 0 : 2;
    return;
  }

  const input = options.input;
  const isUrl = /^https?:\/\//i.test(input);
  const result = isUrl
    ? await runUrlMode(options, input)
    : await runFileMode(options, input);

  if (options.json) {
    console.log(JSON.stringify(toJson(result), null, 2));
  } else {
    printHuman(result);
  }
  process.exitCode = result.exitCode;
}

main().catch((error: unknown) => {
  console.error("Validator crashed:", error instanceof Error ? error.stack ?? error.message : error);
  process.exitCode = 2;
});
