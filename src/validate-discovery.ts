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
 * Safety (spec §3.6 / §8.1): only the top-level URL provided by the user and
 * explicitly requested targets (`--probe-*`, and the `attestation.uri` source
 * under `--verify-attestation`) are ever fetched. A source URI is fetched only
 * after the conformance host binding passes. Provider terms are never fetched
 * by the validator; the broker fetches `terms.url` at signup time. Every fetch
 * applies a timeout, a bounded read, and a same-origin redirect limit.
 */
import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  DEV_LOCALHOST_HOSTNAMES,
  MAX_REDIRECTS,
  fetchResource,
  isAbsoluteOrigin,
  isAbsoluteProtocolUrl,
  isCanonicalOrigin,
  isDevelopmentOrigin,
  isRecord,
  normalizeOrigin,
  parseAbsoluteHttpUrl,
} from "./http";
import { loadRootSchema, validateJsonSchema, type SchemaError } from "./json-schema";
import {
  AgentSignupDiscoverySchema,
  AttestationSourceSchema,
  type AttestationMode,
} from "./schema";
import {
  parseClockValue,
  verifyRpAttestation,
  verifyRpAttestationSource,
  type AttestationVerificationOptions,
  type AttestationVerificationResult,
} from "./validate-attestation";
import { VALIDATOR_ID, VALIDATOR_VERSION } from "./version";

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_BYTES = 1024 * 1024; // spec §4: 1 MiB cap

// ---------------------------------------------------------------------------
// Shared mirror helpers (kept in lockstep with ./schema.ts).
// ---------------------------------------------------------------------------

const EMAIL_PATTERN = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

// ---------------------------------------------------------------------------
// Result model.
// ---------------------------------------------------------------------------

type CheckStatus = "pass" | "fail" | "warn" | "skip";

interface Check {
  id: string;
  title: string;
  status: CheckStatus;
  message: string;
  /** Stable machine-readable reason code for a failure (or an unchecked rule). */
  reason?: string;
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
  terms: { version: string | null; url: string | null } | null;
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
  /**
   * Document-only conformance verdict. `valid` is `null` and `evaluated` is
   * `false` when the run never obtained a document (exit `2`), because a fetch
   * failure is not a conformance verdict.
   */
  conformance: {
    valid: boolean | null;
    evaluated: boolean;
    errors: string[];
    warnings: string[];
  };
  attestation: AttestationVerificationResult;
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
  verifyAttestation: boolean;
  requireAttestation: boolean;
  trustedBrokers: string[];
  jwks: string | null;
  at: number | null;
  /** Fixture-only: a local source response used instead of a network fetch. */
  sourceResponse: InjectedAttestationSourceResponse | null;
  /** Fixture-only: path to a JSON file holding that response. */
  sourceResponsePath: string | null;
}

/** A stand-in for the `attestation.uri` HTTP response (fixture runs, no network). */
export interface InjectedAttestationSourceResponse {
  status: number;
  body: unknown;
  /** `Content-Type` of the stand-in response (default `application/json`). */
  contentType?: string;
}

/** Env fallback for the trusted RP-broker list (spec §5.14). */
const TRUSTED_BROKERS_ENV = "AGENT_IDENTITY_TRUSTED_RP_BROKERS";

function parseBrokerList(value: string | undefined): string[] {
  if (value === undefined) {
    return [];
  }
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
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
    verifyAttestation: false,
    requireAttestation: false,
    trustedBrokers: [],
    jwks: null,
    at: null,
    sourceResponse: null,
    sourceResponsePath: null,
  };

  let brokerFlagSeen = false;
  const brokerFlags: string[] = [];

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
    } else if (arg === "--verify-attestation") {
      options.verifyAttestation = true;
    } else if (arg === "--require-attestation") {
      options.requireAttestation = true;
      options.verifyAttestation = true;
    } else if (arg === "--trusted-rp-broker") {
      const value = argv[i + 1];
      i += 1;
      if (value === undefined || value.startsWith("-")) {
        throw new UsageError("--trusted-rp-broker expects an issuer origin");
      }
      brokerFlagSeen = true;
      brokerFlags.push(value);
    } else if (arg.startsWith("--trusted-rp-broker=")) {
      brokerFlagSeen = true;
      brokerFlags.push(arg.slice("--trusted-rp-broker=".length));
    } else if (arg === "--jwks") {
      const value = argv[i + 1];
      i += 1;
      if (value === undefined) {
        throw new UsageError("--jwks expects a path or URL");
      }
      options.jwks = value;
    } else if (arg.startsWith("--jwks=")) {
      options.jwks = arg.slice("--jwks=".length);
    } else if (arg === "--source-response") {
      const value = argv[i + 1];
      i += 1;
      if (value === undefined || value.startsWith("-")) {
        throw new UsageError("--source-response expects a path");
      }
      options.sourceResponsePath = value;
    } else if (arg.startsWith("--source-response=")) {
      options.sourceResponsePath = arg.slice("--source-response=".length);
    } else if (arg === "--at") {
      const value = argv[i + 1];
      i += 1;
      if (value === undefined) {
        throw new UsageError("--at expects an RFC 3339 timestamp or epoch seconds");
      }
      const parsed = parseClockValue(value);
      if (parsed === null) {
        throw new UsageError("--at expects an RFC 3339 timestamp or epoch seconds");
      }
      options.at = parsed;
    } else if (arg.startsWith("--at=")) {
      const parsed = parseClockValue(arg.slice("--at=".length));
      if (parsed === null) {
        throw new UsageError("--at expects an RFC 3339 timestamp or epoch seconds");
      }
      options.at = parsed;
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

  // Flags override the env fallback: if any --trusted-rp-broker is present the
  // env list is ignored entirely (an empty effective list means nothing trusted).
  options.trustedBrokers = brokerFlagSeen
    ? brokerFlags
    : parseBrokerList(process.env[TRUSTED_BROKERS_ENV]);

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
    "  --verify-attestation",
    "                      fetch and verify the source named by `attestation.uri`",
    "                      (opt-in). Absent `attestation` = unverified. Typed",
    "                      broker failures are verification results.",
    "  --require-attestation",
    "                      implies --verify-attestation; a non-verified result fails",
    "  --trusted-rp-broker <issuer>",
    "                      repeatable trusted RP-broker origin. Flags override the",
    "                      env fallback; an empty effective list trusts nothing.",
    "  --jwks <path-or-url>",
    "                      pin exactly one issuer's JWKS for offline runs (never",
    "                      bypasses signature checks, never merges issuers)",
    "  --source-response <path>",
    "                      fixture-only: read the attestation source response from",
    "                      a local JSON file `{ status, body }` instead of fetching",
    "                      (offline runs; the body is never echoed)",
    "  --at <rfc3339|epoch>",
    "                      freeze the clock for deterministic runs (fixtures only)",
    "  --timeout <ms>      per-fetch timeout (default " + DEFAULT_TIMEOUT_MS + ")",
    "  --max-bytes <n>     bounded read size per fetch (default " + DEFAULT_MAX_BYTES + ")",
    "  -h, --help          show this help",
    "",
    "Environment:",
    `  ${TRUSTED_BROKERS_ENV}  comma-separated trusted RP-broker origins`,
    "                      (used only when no --trusted-rp-broker flag is present)",
    "",
    "Exit codes:",
    "  0  valid conformant document; no required check failed",
    "  1  conformance failure, or a required attestation check failed",
    "  2  could not obtain what the run needed (document fetch, or JWKS under",
    "     --require-attestation). Never a conformance verdict.",
    "",
    "Safety: only the URL you provide and explicitly requested probe targets are",
    "fetched. URLs found in the document body (including under `extensions`) are",
    "never followed. `terms.url` is never fetched by this validator.",
  ];
  console.log(lines.join("\n"));
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
  "attestation",
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

function skip(id: string, title: string, message: string, extra?: Partial<Check>): Check {
  return { id, title, status: "skip", message, ...extra };
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
    return fail("field.terms", "terms", "terms must be an object with version and url", {
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
  if (problems.length > 0) {
    return fail("field.terms", "terms", problems.join("; "));
  }
  return ok(
    "field.terms",
    "terms",
    "terms.version and terms.url have valid shapes (the broker fetches terms.url at signup)",
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
 * overstating agreement.
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

// ---------------------------------------------------------------------------
// Attestation publication checks (v1.3.0; spec §5.4 and §14).
// ---------------------------------------------------------------------------

/**
 * Frozen v1.3.0 `--json` reason codes. I02/I06 consume these names; do not
 * rename one without a contract decision.
 *
 * Conformance checks (`Check.reason`):
 *   - `attestation_mode_invalid`, `attestation_uri_invalid`
 *   - `attestation_uri_host_untrusted`, `attestation_uri_host_unbound`
 *   - `attestation_binding_unchecked`, `rp_attestation_removed`
 *
 * Verification (`attestation.reason`), in addition to the unchanged JWT reasons
 * (`jws_parse`, `wrong_typ`, `wrong_alg`, `missing_kid`, `claims_invalid`,
 * `unknown_kid`, `duplicate_jwk_kid`, `bad_signature`, `not_yet_valid`,
 * `wrong_origin`, `wrong_audience`, `audience_unverifiable`,
 * `rp_broker_untrusted`, `rp_broker_unavailable`):
 *   - `absent`, `not_checked`, `field_malformed`, `binding_failed`
 *   - `attestation_expired`, `origin_unverifiable`
 *   - `provider_suspended` (403), `attestation_not_found` (404),
 *     `attestation_revoked` (410), `invalid_request` (400), `rate_limited` (429),
 *     `broker_unavailable` (5xx)
 *   - `source_unavailable`, `source_document_invalid`,
 *     `source_response_unreadable`, `source_uri_invalid`,
 *     `attestation_issuer_mismatch`
 */

/** Mirrors the frozen mode enum (`AttestationModeSchema`). */
const ATTESTATION_MODES: ReadonlySet<string> = new Set(["broker", "provider"]);

/**
 * Mirrors `isAttestationSourceUri` in ./schema.ts: absolute HTTPS (localhost
 * development exception), no userinfo, no fragment, no whitespace.
 */
function attestationUriProblem(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0) {
    return "attestation.uri must be a non-empty string";
  }
  if (/\s/.test(value)) {
    return "attestation.uri must not contain whitespace";
  }
  const url = parseAbsoluteHttpUrl(value);
  if (url === null) {
    return "attestation.uri must be an absolute https URL (a relative or non-URL value is rejected)";
  }
  if (url.protocol !== "https:" && !isDevelopmentOrigin(url)) {
    return "attestation.uri must be HTTPS (http://localhost / http://127.0.0.1 is the development exception)";
  }
  if (url.username !== "" || url.password !== "") {
    return "attestation.uri must not carry userinfo";
  }
  if (url.hash !== "") {
    return "attestation.uri must not carry a fragment";
  }
  return null;
}

function checkAttestationMode(raw: unknown): Check {
  const id = "field.attestation.mode";
  const title = "attestation.mode";
  if (raw === undefined) {
    return skip(id, title, "no attestation object (OPTIONAL; absence is conformant and unverified)");
  }
  if (!isRecord(raw)) {
    return fail(id, title, "attestation must be an object with `mode` and `uri`", {
      reason: "attestation_mode_invalid",
      actual: JSON.stringify(raw ?? null),
    });
  }
  const mode = raw.mode;
  if (typeof mode !== "string" || !ATTESTATION_MODES.has(mode)) {
    return fail(id, title, "attestation.mode must be exactly `broker` or `provider`", {
      reason: "attestation_mode_invalid",
      expected: "broker | provider",
      actual: JSON.stringify(mode ?? null),
    });
  }
  return ok(id, title, `attestation.mode is \`${mode}\``);
}

function checkAttestationUri(raw: unknown): Check {
  const id = "field.attestation.uri";
  const title = "attestation.uri";
  if (raw === undefined) {
    return skip(id, title, "no attestation object (OPTIONAL; absence is conformant and unverified)");
  }
  if (!isRecord(raw)) {
    return fail(id, title, "attestation.uri is unreachable: attestation must be an object", {
      reason: "attestation_uri_invalid",
    });
  }
  const problem = attestationUriProblem(raw.uri);
  if (problem !== null) {
    return fail(id, title, problem, {
      reason: "attestation_uri_invalid",
      actual: JSON.stringify(raw.uri ?? null),
    });
  }
  return ok(id, title, `attestation.uri is a stable absolute source URL (${String(raw.uri)})`);
}

/** Canonical origin form (`new URL(value).origin`), or `null` when unparseable. */
function canonicalOrigin(value: string): string | null {
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

/** True when `uri` has the same scheme/port and the same host or a subdomain of it. */
function isSameOrSubdomainOrigin(uri: URL, documentOrigin: string): boolean {
  let origin: URL;
  try {
    origin = new URL(documentOrigin);
  } catch {
    return false;
  }
  if (uri.protocol !== origin.protocol || uri.port !== origin.port) {
    return false;
  }
  const host = uri.hostname.toLowerCase();
  const base = origin.hostname.toLowerCase();
  return host === base || host.endsWith(`.${base}`);
}

/**
 * Host binding for the source URI (spec §5.4; ledger §3.1):
 *
 * - `broker`: the URI origin MUST be a member of the discovery `issuer_allowlist`
 *   and, when a trusted broker list was supplied, a trusted broker origin.
 * - `provider`: the URI origin MUST equal the discovery origin or be a subdomain
 *   of it. In file mode there is no fetch origin, so the binding is unchecked
 *   (`__fixture_origin` restores it) and never a pass.
 */
function checkAttestationBinding(
  document: Record<string, unknown>,
  raw: unknown,
  options: ParsedOptions,
  documentOrigin: string | null,
): Check {
  const id = "field.attestation.binding";
  const title = "attestation host binding";
  if (raw === undefined) {
    return skip(id, title, "no attestation object (OPTIONAL; absence is conformant and unverified)");
  }
  if (!isRecord(raw) || typeof raw.mode !== "string" || !ATTESTATION_MODES.has(raw.mode)) {
    return skip(id, title, "binding not checked: attestation.mode is invalid");
  }
  const url = parseAbsoluteHttpUrl(raw.uri);
  if (url === null || attestationUriProblem(raw.uri) !== null) {
    return skip(id, title, "binding not checked: attestation.uri is not a valid source URL");
  }
  const uriOrigin = url.origin;

  if (raw.mode === "broker") {
    const allowlist = Array.isArray(document.issuer_allowlist)
      ? document.issuer_allowlist.filter((entry): entry is string => typeof entry === "string")
      : [];
    // Canonicalize each entry exactly like the source URI origin, so an
    // allowlist written as `https://host:443` still matches `https://host`.
    const allowlistOrigins = allowlist
      .map((entry) => canonicalOrigin(entry))
      .filter((entry): entry is string => entry !== null);
    const inAllowlist = allowlistOrigins.includes(uriOrigin);
    if (!inAllowlist) {
      return fail(
        id,
        title,
        `attestation.uri origin ${uriOrigin} is not a member of issuer_allowlist (${allowlist.join(", ") || "(none)"})`,
        { reason: "attestation_uri_host_untrusted", actual: uriOrigin },
      );
    }
    if (
      options.trustedBrokers.length > 0 &&
      !options.trustedBrokers.some((entry) => normalizeOrigin(entry) === uriOrigin)
    ) {
      return fail(
        id,
        title,
        `attestation.uri origin ${uriOrigin} is not a trusted broker origin (--trusted-rp-broker)`,
        { reason: "attestation_uri_host_untrusted", actual: uriOrigin },
      );
    }
    const trustNote =
      options.trustedBrokers.length > 0
        ? "a trusted broker origin"
        : "in issuer_allowlist (no trusted broker list configured, so broker trust was not cross-checked)";
    return ok(id, title, `attestation.uri origin ${uriOrigin} is ${trustNote}`);
  }

  if (documentOrigin === null) {
    return skip(
      id,
      title,
      "binding unchecked: file mode has no fetch origin (declare `__fixture_origin` or validate the URL)",
      { reason: "attestation_binding_unchecked" },
    );
  }
  if (!isSameOrSubdomainOrigin(url, documentOrigin)) {
    return fail(
      id,
      title,
      `attestation.uri origin ${uriOrigin} is neither the discovery origin ${documentOrigin} nor a subdomain of it`,
      { reason: "attestation_uri_host_unbound", expected: documentOrigin, actual: uriOrigin },
    );
  }
  return ok(
    id,
    title,
    `attestation.uri origin ${uriOrigin} is the discovery origin ${documentOrigin} or a subdomain of it`,
  );
}

/**
 * `rp_attestation` was removed in v1.3.0. A document that still carries it is
 * non-conformant: there is no compatibility field, embedded fallback, or dual
 * publication. Contract F receipt/abuse bodies keep the historical field name.
 */
function checkRpAttestationRemoved(document: Record<string, unknown>): Check {
  if (!("rp_attestation" in document)) {
    return skip(
      "field.rp_attestation",
      "rp_attestation (removed in v1.3.0)",
      "no rp_attestation field (removed in v1.3.0; absence is conformant)",
    );
  }
  return fail(
    "field.rp_attestation",
    "rp_attestation (removed in v1.3.0)",
    "rp_attestation was removed in v1.3.0: discovery MUST publish `attestation: { mode, uri }` instead. Contract F receipt and abuse bodies keep `rp_attestation`.",
    { reason: "rp_attestation_removed" },
  );
}

function verificationOptions(options: ParsedOptions): AttestationVerificationOptions {
  return {
    trustedBrokers: options.trustedBrokers,
    jwks: options.jwks,
    at: options.at,
    timeoutMs: options.timeoutMs,
    maxBytes: options.maxBytes,
    required: options.requireAttestation,
    check: options.verifyAttestation || options.requireAttestation,
  };
}

/** A present source with a known non-verified outcome (no JWT fields to report). */
function sourceStatusResult(
  options: ParsedOptions,
  status: AttestationVerificationResult["status"],
  reason: string,
  message: string | null,
  mode: AttestationMode | null,
  sourceUri: string | null,
): AttestationVerificationResult {
  const result = emptyAttestation(options, reason);
  result.present = true;
  result.checked = true;
  result.status = status;
  result.mode = mode;
  result.source_uri = sourceUri;
  if (message !== null) {
    result.errors.push(`${reason}: ${message}`);
  }
  return result;
}

/** Broker-managed statuses this validator maps to typed verification results. */
function isBrokerSourceStatus(status: number): boolean {
  return (
    status === 200 ||
    status === 400 ||
    status === 403 ||
    status === 404 ||
    status === 410 ||
    status === 429 ||
    (status >= 500 && status < 600)
  );
}

type SourceResolution =
  | { ok: true; document: unknown }
  | {
      ok: false;
      status: AttestationVerificationResult["status"];
      reason: string;
      message: string;
    };

/** Extracts only a well-shaped broker error code; never echoes the body. */
function brokerErrorCode(text: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) {
    return null;
  }
  const candidate =
    typeof parsed.code === "string"
      ? parsed.code
      : typeof parsed.error === "string"
        ? parsed.error
        : null;
  return candidate !== null && /^[a-z][a-z0-9_]{0,63}$/.test(candidate) ? candidate : null;
}

/** Maps a typed broker HTTP answer to a verification result (never a conformance error). */
function typedBrokerFailure(status: number, text: string): SourceResolution {
  const table: Record<string, { status: AttestationVerificationResult["status"]; reason: string }> = {
    "400": { status: "invalid", reason: "invalid_request" },
    "403": { status: "suspended", reason: "provider_suspended" },
    "404": { status: "unverified", reason: "attestation_not_found" },
    "410": { status: "invalid", reason: "attestation_revoked" },
    "429": { status: "unavailable", reason: "rate_limited" },
  };
  const mapped =
    status >= 500 && status < 600
      ? { status: "unavailable" as const, reason: "broker_unavailable" }
      : table[String(status)] ?? { status: "unavailable" as const, reason: "broker_unavailable" };
  const code = brokerErrorCode(text);
  return {
    ok: false,
    status: mapped.status,
    reason: mapped.reason,
    message: `the broker source returned HTTP ${status}${code !== null ? ` (${code})` : ""}`,
  };
}

/** Reads an injected fixture response (programmatic object or a JSON file). */
async function injectedSourceResponse(
  options: ParsedOptions,
): Promise<{ response: InjectedAttestationSourceResponse | null; error: string | null }> {
  if (options.sourceResponse !== null) {
    return { response: options.sourceResponse, error: null };
  }
  const path = options.sourceResponsePath;
  if (path === null) {
    return { response: null, error: null };
  }
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    return {
      response: null,
      error: `could not read --source-response file: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (Buffer.byteLength(raw, "utf8") > options.maxBytes) {
    return { response: null, error: `--source-response file exceeds the ${options.maxBytes}-byte cap` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { response: null, error: "--source-response file is not valid JSON" };
  }
  if (!isRecord(parsed) || typeof parsed.status !== "number" || !("body" in parsed)) {
    return {
      response: null,
      error: '--source-response file must be `{ "status": <number>, "body": <json> }`',
    };
  }
  if (parsed.contentType !== undefined && typeof parsed.contentType !== "string") {
    return {
      response: null,
      error: '--source-response `contentType` must be a string when present',
    };
  }
  return {
    response: {
      status: parsed.status,
      body: parsed.body,
      ...(typeof parsed.contentType === "string" ? { contentType: parsed.contentType } : {}),
    },
    error: null,
  };
}

/**
 * Obtains the source document for `attestation.uri`:
 *
 * - an injected fixture response, otherwise
 * - a bounded fetch (timeout, size cap, same-origin redirects only).
 *
 * Broker-managed typed answers are verification results; provider outages are
 * `unavailable`; a malformed source body is `invalid`. The source body is never
 * echoed into an error.
 */
async function resolveAttestationSource(
  source: { mode: AttestationMode; uri: string },
  options: ParsedOptions,
): Promise<SourceResolution> {
  const injected = await injectedSourceResponse(options);
  if (injected.error !== null) {
    return {
      ok: false,
      status: "unavailable",
      reason: "source_response_unreadable",
      message: injected.error,
    };
  }

  let status: number;
  let text: string | null = null;
  let body: unknown = null;
  // Injected responses default to `application/json`; a real fetch must send it.
  let contentType = "application/json";

  if (injected.response !== null) {
    status = injected.response.status;
    body = injected.response.body;
    contentType = injected.response.contentType ?? "application/json";
  } else {
    const outcome = await fetchResource(source.uri, {
      timeoutMs: options.timeoutMs,
      maxBytes: options.maxBytes,
      requireJson: false,
      acceptStatus: source.mode === "broker" ? isBrokerSourceStatus : (value) => value === 200,
    });
    if (!outcome.ok) {
      const detail =
        outcome.kind === "status" && outcome.status !== undefined
          ? `the source returned HTTP ${outcome.status}`
          : outcome.message;
      return source.mode === "broker"
        ? {
            ok: false,
            status: "unavailable",
            reason: "broker_unavailable",
            message: `could not fetch the broker source: ${detail}`,
          }
        : {
            ok: false,
            status: "unavailable",
            reason: "source_unavailable",
            message: `could not fetch the provider source: ${detail}`,
          };
    }
    status = outcome.status;
    text = outcome.text;
    contentType = outcome.headers.get("content-type") ?? "";
  }

  if (status === 200) {
    const mime = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
    if (mime !== "application/json") {
      return {
        ok: false,
        status: "invalid",
        reason: "source_document_invalid",
        message: `the source document must be served as application/json (received ${mime || "(none)"})`,
      };
    }
    if (text !== null) {
      try {
        body = JSON.parse(text);
      } catch {
        return {
          ok: false,
          status: "invalid",
          reason: "source_document_invalid",
          message: "the source document is not valid JSON",
        };
      }
    }
    return { ok: true, document: body };
  }

  if (source.mode === "broker") {
    return typedBrokerFailure(status, text ?? "");
  }
  return {
    ok: false,
    status: "unavailable",
    reason: "source_unavailable",
    message: `the provider source returned HTTP ${status}`,
  };
}

/**
 * Evaluates the optional `attestation` object end to end: field checks and host
 * binding (conformance), then the opt-in source fetch and JWT verification
 * (never a conformance error).
 */
async function evaluateAttestation(
  document: Record<string, unknown>,
  options: ParsedOptions,
  documentOrigin: string | null,
  inputOrigin: URL | null,
): Promise<{ checks: Check[]; result: AttestationVerificationResult }> {
  const raw = document.attestation;
  const modeCheck = checkAttestationMode(raw);
  const uriCheck = checkAttestationUri(raw);
  const bindingCheck = checkAttestationBinding(document, raw, options, documentOrigin);
  const checks = [modeCheck, uriCheck, bindingCheck];
  const context = {
    documentOrigin,
    documentAudience: typeof document.audience === "string" ? document.audience : null,
  };

  if (raw === undefined) {
    return {
      checks,
      result: await verifyRpAttestation(undefined, context, verificationOptions(options)),
    };
  }

  const parsed = AttestationSourceSchema.safeParse(raw);
  if (!parsed.success) {
    // A malformed object is a conformance error and never a fetch attempt: there
    // is nothing to select. Report `not_checked` rather than mislabelling a
    // non-source as `invalid` verification evidence.
    const result = sourceStatusResult(
      options,
      "not_checked",
      "field_malformed",
      null,
      null,
      null,
    );
    result.checked = false;
    result.checks.push({
      id: "attestation.field.present",
      status: "fail",
      message: "attestation must be an object `{ mode, uri }`",
    });
    return { checks, result };
  }

  const source = parsed.data;
  if (!options.verifyAttestation && !options.requireAttestation) {
    const result = sourceStatusResult(options, "not_checked", "not_checked", null, source.mode, source.uri);
    result.checked = false;
    result.checks.push({
      id: "attestation.source",
      status: "skip",
      message: "source verification not requested (pass --verify-attestation)",
    });
    return { checks, result };
  }

  const binding = bindingCheck;
  if (binding.status === "fail") {
    // Never fetch an untrusted or unbound URI. The conformance check is the
    // authoritative failure; the attestation result records why no token exists.
    return {
      checks,
      result: sourceStatusResult(
        options,
        "not_checked",
        "binding_failed",
        binding.message,
        source.mode,
        source.uri,
      ),
    };
  }

  // Reuse the document-derived probe guard: a public document cannot steer this
  // opt-in fetch at a loopback/link-local/private target, and a plain http
  // target is refused unless the input origin is localhost/127.0.0.1. An
  // injected `--source-response` performs no fetch, so the guard does not apply.
  if (options.sourceResponse === null && options.sourceResponsePath === null) {
    const refusal = probeTargetRefusal(source.uri, inputOrigin);
    if (refusal !== null) {
      return {
        checks,
        result: sourceStatusResult(
          options,
          "unavailable",
          source.mode === "broker" ? "broker_unavailable" : "source_unavailable",
          `the attestation source was not fetched: ${refusal}`,
          source.mode,
          source.uri,
        ),
      };
    }
  }

  const resolved = await resolveAttestationSource(source, options);
  if (!resolved.ok) {
    return {
      checks,
      result: sourceStatusResult(
        options,
        resolved.status,
        resolved.reason,
        resolved.message,
        source.mode,
        source.uri,
      ),
    };
  }

  return {
    checks,
    result: await verifyRpAttestationSource(
      resolved.document,
      { ...context, mode: source.mode, sourceUri: source.uri },
      verificationOptions(options),
    ),
  };
}

/** A synthetic attestation result for runs where the document never arrived. */
function emptyAttestation(
  options: ParsedOptions,
  reason: string,
): AttestationVerificationResult {
  const now = options.at ?? Math.floor(Date.now() / 1000);
  return {
    present: false,
    checked: false,
    required: options.requireAttestation,
    verified: false,
    status: "unverified",
    reason,
    mode: null,
    source_uri: null,
    iss: null,
    jti: null,
    origin: null,
    audience: null,
    level: null,
    expires_at: null,
    checked_at: new Date(now * 1000).toISOString(),
    jwks_source: null,
    checks: [],
    errors: [],
    warnings: [],
  };
}

/**
 * In URL mode the fetch origin is authoritative. In file mode there is no
 * fetch, so a fixture MAY declare `__fixture_origin`; without it the origin
 * binding cannot be checked and the attestation is `unavailable` rather than
 * falsely `verified` (never skip a known check).
 */
function declaredOrigin(document: unknown): string | null {
  if (!isRecord(document)) {
    return null;
  }
  const value = document.__fixture_origin;
  return typeof value === "string" && isCanonicalOrigin(value) ? value : null;
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

/**
 * Top-level fields handled by a dedicated check. They MUST NOT also appear in
 * `warn.unknown-top-level-fields`: `rp_attestation` is removed in v1.3.0 and is
 * a hard conformance failure (`field.rp_attestation`), so describing it as an
 * ignored additive field in the same transcript would contradict the verdict.
 */
const DEDICATED_TOP_LEVEL_FIELDS: ReadonlySet<string> = new Set(["rp_attestation"]);

function checkUnknownTopLevel(document: Record<string, unknown>, forbiddenTopLevel: Set<string>): Check {
  const unknown = Object.keys(document).filter(
    (key) =>
      !ALLOWED_TOP_LEVEL_FIELDS.has(key) &&
      !forbiddenTopLevel.has(key) &&
      !DEDICATED_TOP_LEVEL_FIELDS.has(key),
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
 * localhost/127.0.0.1 origin.
 */
async function checkDocument(
  document: unknown,
  options: ParsedOptions,
  transportChecks: Check[],
  inputOrigin: URL | null,
  documentOrigin: string | null,
): Promise<{
  checks: Check[];
  probes: Probe[];
  metadata: DocumentMetadata | null;
  attestation: AttestationVerificationResult;
}> {
  const checks: Check[] = [...transportChecks];

  const documentIsObject = isRecord(document);
  addCheck(
    checks,
    documentIsObject
      ? ok("json.parse", "json.parse", "parsed JSON object")
      : fail("json.parse", "json.parse", "the discovery document must be a JSON object"),
  );

  if (!documentIsObject) {
    return {
      checks,
      probes: [],
      metadata: null,
      attestation: emptyAttestation(options, "document_invalid"),
    };
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

  const jsonSchema = loadRootSchema("agent-signup.schema.json");
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
  addCheck(checks, checkRpAttestationRemoved(document));
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

  const attestationEvaluation = await evaluateAttestation(
    document,
    options,
    documentOrigin,
    inputOrigin,
  );
  for (const check of attestationEvaluation.checks) {
    addCheck(checks, check);
  }

  return {
    checks,
    probes,
    metadata: buildMetadata(document),
    attestation: attestationEvaluation.result,
  };
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
 *    localhost/127.0.0.1 host.
 * 2. A target on a loopback/link-local/private hostname is refused **regardless
 *    of scheme** unless the top-level input origin itself is a
 *    localhost/127.0.0.1 development origin, so a document served from a public
 *    origin can never steer an opt-in probe at `https://127.0.0.1/`,
 *    `https://10.0.0.5/`, `https://169.254.169.254/`, `https://foo.local/`,
 *    etc.
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
 * routed) count as reachable.
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

/**
 * Exit-2 result: the run never obtained the document (missing file, read error,
 * network/status/size failure). This is an operational result, **not** a
 * conformance verdict, so `conformance.valid` stays `null` and `evaluated` is
 * `false`. The operational error is recorded in `fetchFailure`.
 */
function fetchFailureResult(
  mode: "file" | "url",
  input: string,
  message: string,
  options: ParsedOptions,
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
    conformance: { valid: null, evaluated: false, errors: [], warnings: [] },
    attestation: emptyAttestation(options, "document_unavailable"),
    fetchFailure: message,
  };
}

/**
 * Exit-1 result: the document arrived but its body is not JSON. Unparseable
 * JSON is a **conformance** error (spec §5.14), not a fetch failure, so this
 * reports a real `conformance.valid: false` verdict and leaves `fetchFailure`
 * null. Exit `2` stays reserved for "could not obtain" (read/network/status/
 * size) failures.
 */
function parseFailureResult(
  mode: "file" | "url",
  input: string,
  message: string,
  options: ParsedOptions,
  transportChecks: Check[],
): RunResult {
  const checks = [...transportChecks, fail("json.parse", "json.parse", message)];
  const errors = checks
    .filter((check) => check.status === "fail")
    .map((check) => `${check.id}: ${check.message}`);
  const warnings = checks
    .filter((check) => check.status === "warn")
    .map((check) => `${check.id}: ${check.message}`);
  return {
    mode,
    source: input,
    input,
    valid: false,
    exitCode: 1,
    document: null,
    metadata: null,
    checks,
    probes: [],
    conformance: { valid: false, evaluated: true, errors, warnings },
    attestation: emptyAttestation(options, "document_unparsed"),
    fetchFailure: null,
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
      options,
    );
  }
  if (size > options.maxBytes) {
    return fetchFailureResult(
      "file",
      input,
      `file exceeds the ${options.maxBytes}-byte cap (${size} bytes)`,
      options,
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
      options,
    );
  }
  const sourceCheck = ok("source", "source", `read local file (${Buffer.byteLength(raw, "utf8")} bytes)`);
  let document: unknown;
  try {
    document = JSON.parse(raw);
  } catch (error) {
    return parseFailureResult(
      "file",
      input,
      `not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      options,
      [sourceCheck],
    );
  }

  // File mode has no input origin, so body-derived `http://` probe targets are
  // never treated as a localhost development origin.
  const { checks, probes, metadata, attestation } = await checkDocument(
    document,
    options,
    [sourceCheck],
    null,
    declaredOrigin(document),
  );
  return finish("file", input, document, checks, probes, metadata, attestation, options);
}

async function runUrlMode(options: ParsedOptions, input: string): Promise<RunResult> {
  const outcome = await fetchResource(input, {
    timeoutMs: options.timeoutMs,
    maxBytes: options.maxBytes,
    requireJson: true,
  });
  if (!outcome.ok) {
    return fetchFailureResult("url", input, `${outcome.kind}: ${outcome.message}`, options);
  }
  const transportChecks = buildTransportChecks(outcome);
  let document: unknown;
  try {
    document = JSON.parse(outcome.text);
  } catch (error) {
    return parseFailureResult(
      "url",
      input,
      `the response body is not valid JSON (${error instanceof Error ? error.message : String(error)})`,
      options,
      transportChecks,
    );
  }
  // The top-level input origin gates the probes' localhost dev exception.
  const { checks, probes, metadata, attestation } = await checkDocument(
    document,
    options,
    transportChecks,
    parseAbsoluteHttpUrl(input),
    parseAbsoluteHttpUrl(outcome.finalUrl)?.origin ?? null,
  );
  return finish("url", input, document, checks, probes, metadata, attestation, options);
}

function finish(
  mode: "file" | "url",
  input: string,
  document: unknown,
  checks: Check[],
  probes: Probe[],
  metadata: DocumentMetadata | null,
  attestation: AttestationVerificationResult,
  options: ParsedOptions,
): RunResult {
  const conformanceErrors = checks
    .filter((check) => check.status === "fail")
    .map((check) => `${check.id}: ${check.message}`)
    .concat(
      probes
        .filter((probe) => probe.status === "fail")
        .map((probe) => `${probe.id}: ${probe.message}`),
    );
  const conformanceWarnings = checks
    .filter((check) => check.status === "warn")
    .map((check) => `${check.id}: ${check.message}`);
  const conformanceValid = conformanceErrors.length === 0;

  // Exit mapping (spec §5.14): conformance or a failed required verification is
  // `1`; a required run that could not obtain its evidence is `2`; everything
  // else is `0` (an unverified/expired/invalid attestation is a warning only
  // unless `--require-attestation` was requested).
  let exitCode = 0;
  if (!conformanceValid) {
    exitCode = 1;
  } else if (options.requireAttestation && attestation.status !== "verified") {
    exitCode = attestation.status === "unavailable" ? 2 : 1;
  }

  return {
    mode,
    source: input,
    input,
    valid: exitCode === 0,
    exitCode,
    document,
    metadata,
    checks,
    probes,
    conformance: {
      valid: conformanceValid,
      evaluated: true,
      errors: conformanceErrors,
      warnings: conformanceWarnings,
    },
    attestation,
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
  const attestationWarnings =
    result.attestation.status === "verified" ||
    result.attestation.status === "unverified" ||
    result.attestation.status === "not_checked"
      ? [...result.attestation.warnings]
      : [
          ...result.attestation.errors.map((error) => `attestation: ${error}`),
          ...result.attestation.warnings,
        ];
  return {
    validator: VALIDATOR_ID,
    validatorVersion: VALIDATOR_VERSION,
    mode: result.mode,
    source: result.source,
    valid: result.valid,
    exitCode: result.exitCode,
    conformance: {
      valid: result.conformance.valid,
      evaluated: result.conformance.evaluated,
      errors: result.conformance.errors,
      warnings: result.conformance.warnings,
    },
    attestation: {
      present: result.attestation.present,
      checked: result.attestation.checked,
      required: result.attestation.required,
      verified: result.attestation.verified,
      status: result.attestation.status,
      reason: result.attestation.reason,
      mode: result.attestation.mode,
      source_uri: result.attestation.source_uri,
      iss: result.attestation.iss,
      jti: result.attestation.jti,
      origin: result.attestation.origin,
      audience: result.attestation.audience,
      level: result.attestation.level,
      expires_at: result.attestation.expires_at,
      checked_at: result.attestation.checked_at,
      jwks_source: result.attestation.jwks_source,
      checks: result.attestation.checks,
      errors: result.attestation.errors,
      warnings: result.attestation.warnings,
    },
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
      ...(check.reason !== undefined ? { reason: check.reason } : {}),
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
    warnings: [...warnings, ...attestationWarnings],
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

  lines.push("");
  lines.push(
    `ATTESTATION: ${result.attestation.status}${result.attestation.reason ? ` (${result.attestation.reason})` : ""}`,
  );
  if (result.attestation.mode !== null) {
    lines.push(`  mode: ${result.attestation.mode}`);
  }
  if (result.attestation.source_uri !== null) {
    lines.push(`  source: ${result.attestation.source_uri}`);
  }
  if (result.attestation.checks.length > 0) {
    for (const check of result.attestation.checks) {
      lines.push(`  [${statusLabel(check.status)}] ${check.id}  ${check.message}`);
    }
  }
  for (const warning of result.attestation.warnings) {
    lines.push(`  [WARN] attestation.warning  ${warning}`);
  }

  const counts = summarize(result);
  const documentVerdict =
    result.conformance.valid === null
      ? "NOT CHECKED (n/a: no document, so no conformance verdict)"
      : result.conformance.valid
        ? "VALID"
        : "INVALID";
  const resultVerdict =
    result.exitCode === 0 ? "OK" : result.exitCode === 2 ? "COULD NOT FETCH" : "FAILED";
  lines.push("");
  lines.push(`DOCUMENT: ${documentVerdict}`);
  lines.push(
    `RESULT: ${resultVerdict} — ${counts.failed} failure(s), ${counts.warnings} warning(s), exit ${result.exitCode}`,
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

/**
 * Programmatic entry point used by the fixture harness (`pnpm validate:fixtures`).
 * It is not part of the published package's `src/index.ts` surface; it exists so
 * the manual harness exercises the same code path as the CLI without spawning a
 * process per fixture and without inventing a test framework.
 */
export interface DiscoveryValidationOptions {
  verifyAttestation?: boolean;
  requireAttestation?: boolean;
  trustedBrokers?: string[];
  jwks?: string | null;
  at?: number | null;
  timeoutMs?: number;
  maxBytes?: number;
  probeJwks?: boolean;
  probeEndpoints?: boolean;
  /** Fixture-only: a local source response used instead of a network fetch. */
  sourceResponse?: InjectedAttestationSourceResponse | null;
}

export type DiscoveryRunResult = RunResult;

export async function validateDiscoveryInput(
  input: string,
  overrides: DiscoveryValidationOptions = {},
): Promise<RunResult> {
  const options: ParsedOptions = {
    input,
    json: false,
    help: false,
    probeJwks: overrides.probeJwks ?? false,
    probeEndpoints: overrides.probeEndpoints ?? false,
    timeoutMs: overrides.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    maxBytes: overrides.maxBytes ?? DEFAULT_MAX_BYTES,
    verifyAttestation: overrides.verifyAttestation ?? false,
    requireAttestation: overrides.requireAttestation ?? false,
    trustedBrokers: overrides.trustedBrokers ?? [],
    jwks: overrides.jwks ?? null,
    at: overrides.at ?? null,
    sourceResponse: overrides.sourceResponse ?? null,
    sourceResponsePath: null,
  };
  const isUrl = /^https?:\/\//i.test(input);
  return isUrl ? runUrlMode(options, input) : runFileMode(options, input);
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  main().catch((error: unknown) => {
    console.error("Validator crashed:", error instanceof Error ? error.stack ?? error.message : error);
    process.exitCode = 2;
  });
}
