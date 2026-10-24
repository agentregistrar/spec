/**
 * Contract G attestation verification (spec §5.2) — verifier-internal.
 *
 * This module is consumed by `src/validate-discovery.ts` and the fixture
 * harness. It is deliberately **not** exported from `src/index.ts`: it is a
 * validator building block, not the deferred verification SDK (D14-09).
 *
 * Verification order is normative and is enforced exactly:
 *
 * 1. parse the compact JWS and require `typ`, `alg: EdDSA`, exactly one `kid`;
 * 2. `iss` must be in the trusted RP-broker list — checked **before** any JWKS
 *    fetch, so an untrusted broker is never contacted;
 * 3. verify against the issuer JWKS (pinned `--jwks` wins for offline runs),
 *    selecting the key by `kid` (never trying all keys);
 * 4. `iat`/`exp` with 60s skew; `jti` pattern;
 * 5. `rp.origin` equals the fetched document origin;
 * 6. `rp.audience` equals `discovery.audience`;
 * 7. record `rp.verification.level`.
 */
import {
  createPublicKey,
  verify as verifySignature,
  type JsonWebKey as NodeJsonWebKey,
} from "node:crypto";
import { readFile } from "node:fs/promises";

import {
  ATTESTATION_JTI_PATTERN,
  ATTESTATION_LIFETIME_SECONDS,
  ATTESTATION_TYP,
  CLOCK_SKEW_SECONDS,
  ED25519_PUBLIC_KEY_PATTERN,
  KEY_ID_PATTERN,
  MAX_JWKS_CACHE_AGE_MS,
  MAX_METADATA_CACHE_AGE_MS,
  PROTOCOL_AUDIENCE,
} from "./constants";
import { fetchResource, isRecord, normalizeOrigin } from "./http";
import {
  BrokerMetadataSchema,
  parseRpAttestationVerifier,
  type RpAttestationClaims,
} from "./schema";

/** Statuses the validator itself can emit. `suspended` comes from the broker. */
export type AttestationVerificationStatus =
  | "verified"
  | "unverified"
  | "attested_untrusted_broker"
  | "invalid"
  | "expired"
  | "unavailable"
  | "not_checked";

export type AttestationCheckStatus = "pass" | "fail" | "warn" | "skip";

export interface AttestationCheck {
  id: string;
  status: AttestationCheckStatus;
  message: string;
}

export interface AttestationVerificationOptions {
  /** Effective trusted RP-broker list. Empty means nothing is trusted. */
  trustedBrokers: readonly string[];
  /** Pinned JWKS file path or URL for exactly one issuer; bypasses fetching. */
  jwks: string | null;
  /** Frozen clock in epoch seconds, or `null` for wall-clock time. */
  at: number | null;
  timeoutMs: number;
  maxBytes: number;
  /** `--require-attestation`: surfaces the requirement in the JSON evidence. */
  required: boolean;
  /** `--verify-attestation`: when false, an present field is `not_checked`. */
  check: boolean;
}

export interface AttestationVerificationContext {
  /** Origin of the discovery document actually fetched (file mode: fixture declaration). */
  documentOrigin: string | null;
  documentAudience: string | null;
}

export interface AttestationVerificationResult {
  present: boolean;
  checked: boolean;
  required: boolean;
  verified: boolean;
  status: AttestationVerificationStatus;
  reason: string | null;
  iss: string | null;
  jti: string | null;
  origin: string | null;
  audience: string | null;
  level: string | null;
  checked_at: string;
  jwks_source: string | null;
  checks: AttestationCheck[];
  errors: string[];
  warnings: string[];
}

export interface ParsedCompactJws {
  header: Record<string, unknown>;
  claims: unknown;
  signingInput: string;
  signature: Buffer;
}

export type ParseResult =
  | { ok: true; jws: ParsedCompactJws }
  | { ok: false; reason: string; message: string };

const BASE64URL_SEGMENT = /^[A-Za-z0-9_-]+$/;

/** Decodes one base64url segment as UTF-8 JSON. */
function decodeJsonSegment(segment: string): unknown {
  const text = Buffer.from(segment, "base64url").toString("utf8");
  return JSON.parse(text) as unknown;
}

/** Parses a compact JWS without trusting any of it. */
export function parseCompactJws(compact: unknown): ParseResult {
  if (typeof compact !== "string" || compact.length === 0) {
    return { ok: false, reason: "jws_parse", message: "value is not a non-empty string" };
  }
  const segments = compact.split(".");
  if (segments.length !== 3) {
    return {
      ok: false,
      reason: "jws_parse",
      message: `compact JWS must have exactly three segments (found ${segments.length})`,
    };
  }
  for (const segment of segments) {
    if (!BASE64URL_SEGMENT.test(segment)) {
      return {
        ok: false,
        reason: "jws_parse",
        message: "each compact JWS segment must be unpadded base64url ([A-Za-z0-9_-]+)",
      };
    }
  }
  let header: unknown;
  let claims: unknown;
  try {
    header = decodeJsonSegment(segments[0]);
  } catch (error) {
    return {
      ok: false,
      reason: "jws_parse",
      message: `JWS header is not base64url-encoded JSON (${error instanceof Error ? error.message : String(error)})`,
    };
  }
  try {
    claims = decodeJsonSegment(segments[1]);
  } catch (error) {
    return {
      ok: false,
      reason: "jws_parse",
      message: `JWS payload is not base64url-encoded JSON (${error instanceof Error ? error.message : String(error)})`,
    };
  }
  if (!isRecord(header)) {
    return { ok: false, reason: "jws_parse", message: "JWS header must be a JSON object" };
  }
  if (!isRecord(claims)) {
    return { ok: false, reason: "jws_parse", message: "JWS payload must be a JSON object" };
  }
  return {
    ok: true,
    jws: {
      header,
      claims,
      signingInput: `${segments[0]}.${segments[1]}`,
      signature: Buffer.from(segments[2], "base64url"),
    },
  };
}

/** Verifies a detached Ed25519 signature over the JWS signing input. */
export function verifyEd25519Jwk(
  jwk: unknown,
  signingInput: string,
  signature: Buffer,
): { ok: true } | { ok: false; message: string } {
  if (!isRecord(jwk)) {
    return { ok: false, message: "JWK is not a JSON object" };
  }
  if (jwk.kty !== "OKP" || jwk.crv !== "Ed25519") {
    return { ok: false, message: "JWK must be an Ed25519 `OKP` key" };
  }
  if (typeof jwk.x !== "string" || !ED25519_PUBLIC_KEY_PATTERN.test(jwk.x)) {
    return { ok: false, message: "JWK `x` must be a base64url 32-byte Ed25519 public key" };
  }
  let key: ReturnType<typeof createPublicKey>;
  try {
    key = createPublicKey({ key: jwk as NodeJsonWebKey, format: "jwk" });
  } catch (error) {
    return {
      ok: false,
      message: `JWK could not be imported (${error instanceof Error ? error.message : String(error)})`,
    };
  }
  try {
    const valid = verifySignature(
      null,
      Buffer.from(signingInput, "utf8"),
      key,
      signature,
    );
    return valid ? { ok: true } : { ok: false, message: "signature does not verify" };
  } catch (error) {
    return {
      ok: false,
      message: `signature verification failed (${error instanceof Error ? error.message : String(error)})`,
    };
  }
}

// ---------------------------------------------------------------------------
// JWKS resolution (per-issuer cache, never merged across issuers).
// ---------------------------------------------------------------------------

interface CachedJwks {
  keys: unknown[];
  fetchedAt: number;
}

const jwksCache = new Map<string, CachedJwks>();
const JWKS_CACHE_MAX_ENTRIES = 8;

export type JwksLoadResult =
  | { ok: true; keys: unknown[]; source: string; notes: string[] }
  | { ok: false; source: string; message: string };

function isHttpUrl(value: string): boolean {
  return /^https?:\/\//i.test(value);
}

function extractJwksKeys(text: string): { ok: true; keys: unknown[] } | { ok: false; message: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return {
      ok: false,
      message: `JWKS is not valid JSON (${error instanceof Error ? error.message : String(error)})`,
    };
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.keys)) {
    return { ok: false, message: "JWKS has no `keys` array" };
  }
  return { ok: true, keys: parsed.keys };
}

async function loadJwksSource(
  source: string,
  options: AttestationVerificationOptions,
): Promise<JwksLoadResult> {
  if (isHttpUrl(source)) {
    const outcome = await fetchResource(source, {
      timeoutMs: options.timeoutMs,
      maxBytes: options.maxBytes,
      requireJson: true,
    });
    if (!outcome.ok) {
      return { ok: false, source, message: `${outcome.kind}: ${outcome.message}` };
    }
    const keys = extractJwksKeys(outcome.text);
    if (!keys.ok) {
      return { ok: false, source, message: keys.message };
    }
    return { ok: true, keys: keys.keys, source, notes: [] };
  }
  let text: string;
  try {
    text = await readFile(source, "utf8");
  } catch (error) {
    return {
      ok: false,
      source,
      message: `could not read JWKS file (${error instanceof Error ? error.message : String(error)})`,
    };
  }
  const keys = extractJwksKeys(text);
  if (!keys.ok) {
    return { ok: false, source, message: keys.message };
  }
  return { ok: true, keys: keys.keys, source, notes: [] };
}

interface CachedMetadata {
  jwksUri: string | null;
  fetchedAt: number;
}

const metadataCache = new Map<string, CachedMetadata>();
const METADATA_CACHE_MAX_ENTRIES = 8;

function cacheMetadata(issuer: string, entry: CachedMetadata): void {
  if (metadataCache.size >= METADATA_CACHE_MAX_ENTRIES) {
    const oldest = metadataCache.keys().next();
    if (!oldest.done) {
      metadataCache.delete(oldest.value);
    }
  }
  metadataCache.set(issuer, entry);
}

/**
 * Resolves the JWKS source for a trusted issuer (spec §5.4, §16.1):
 *
 * 1. the broker metadata `jwks_uri`, but only when the metadata is fetched from
 *    the requested issuer, validates against `BrokerMetadataSchema`, declares
 *    that same `issuer`, and its `jwks_uri` is HTTPS and same-origin with it;
 * 2. otherwise `<issuer>/.well-known/jwks.json`.
 *
 * The metadata lookup happens only **after** the trusted-issuer check, is
 * bounded like every other fetch, and is cached for at most one hour. A
 * cross-origin or invalid `jwks_uri` is never followed.
 */
async function resolveJwksSource(
  issuer: string,
  options: AttestationVerificationOptions,
  notes: string[],
): Promise<string> {
  const base = normalizeOrigin(issuer);
  const fallback = `${base}/.well-known/jwks.json`;
  const now = Date.now();
  const cached = metadataCache.get(base);
  if (cached !== undefined && now - cached.fetchedAt <= MAX_METADATA_CACHE_AGE_MS) {
    return cached.jwksUri ?? fallback;
  }

  const metadataUrl = `${base}/.well-known/agent-broker.json`;
  const outcome = await fetchResource(metadataUrl, {
    timeoutMs: options.timeoutMs,
    maxBytes: options.maxBytes,
    requireJson: true,
  });
  let resolved: string | null = null;
  if (outcome.ok) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(outcome.text);
    } catch {
      notes.push(`broker metadata at ${metadataUrl} is not valid JSON; using ${fallback}`);
    }
    if (parsed !== undefined) {
      const metadata = BrokerMetadataSchema.safeParse(parsed);
      if (!metadata.success) {
        notes.push(`broker metadata at ${metadataUrl} is invalid; using ${fallback}`);
      } else if (metadata.data.issuer !== base) {
        notes.push(
          `broker metadata issuer ${metadata.data.issuer} does not equal ${base}; using ${fallback}`,
        );
      } else {
        resolved = metadata.data.jwks_uri;
      }
    }
  }
  cacheMetadata(base, { jwksUri: resolved, fetchedAt: now });
  return resolved ?? fallback;
}

/**
 * Loads the JWKS for exactly one issuer:
 *
 * - `--jwks <path-or-url>` pins that source for this run and is never cached or
 *   merged with another issuer;
 * - otherwise the issuer's broker metadata `jwks_uri` is preferred when it is
 *   valid and same-origin, else `<issuer>/.well-known/jwks.json` is fetched.
 * Both the metadata and the JWKS are cached per `iss` for at most one hour.
 */
export async function loadIssuerJwks(
  issuer: string,
  options: AttestationVerificationOptions,
): Promise<JwksLoadResult> {
  if (options.jwks !== null) {
    return loadJwksSource(options.jwks, options);
  }
  const notes: string[] = [];
  const source = await resolveJwksSource(issuer, options, notes);
  const now = Date.now();
  const cached = jwksCache.get(issuer);
  if (cached !== undefined && now - cached.fetchedAt <= MAX_JWKS_CACHE_AGE_MS) {
    return { ok: true, keys: cached.keys, source, notes };
  }
  const loaded = await loadJwksSource(source, options);
  if (!loaded.ok) {
    return loaded;
  }
  if (jwksCache.size >= JWKS_CACHE_MAX_ENTRIES) {
    const oldest = jwksCache.keys().next();
    if (!oldest.done) {
      jwksCache.delete(oldest.value);
    }
  }
  jwksCache.set(issuer, { keys: loaded.keys, fetchedAt: now });
  return { ok: true, keys: loaded.keys, source: loaded.source, notes };
}

// ---------------------------------------------------------------------------
// Clock helper.
// ---------------------------------------------------------------------------

/** Parses `--at <rfc3339|epoch>` into epoch seconds; `null` when invalid. */
export function parseClockValue(value: string): number | null {
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) {
    const seconds = Number(trimmed);
    return Number.isFinite(seconds) ? seconds : null;
  }
  const millis = Date.parse(trimmed);
  if (!Number.isFinite(millis)) {
    return null;
  }
  return Math.floor(millis / 1000);
}

// ---------------------------------------------------------------------------
// Verification.
// ---------------------------------------------------------------------------

function emptyResult(
  options: AttestationVerificationOptions,
  now: number,
): AttestationVerificationResult {
  return {
    present: false,
    checked: false,
    required: options.required,
    verified: false,
    status: "unverified",
    reason: "absent",
    iss: null,
    jti: null,
    origin: null,
    audience: null,
    level: null,
    checked_at: new Date(now * 1000).toISOString(),
    jwks_source: null,
    checks: [],
    errors: [],
    warnings: [],
  };
}

function push(
  result: AttestationVerificationResult,
  id: string,
  status: AttestationCheckStatus,
  message: string,
): void {
  result.checks.push({ id: `attestation.${id}`, status, message });
}

function failWith(
  result: AttestationVerificationResult,
  status: AttestationVerificationStatus,
  reason: string,
  message: string,
): AttestationVerificationResult {
  result.status = status;
  result.reason = reason;
  result.verified = false;
  result.errors.push(`${reason}: ${message}`);
  return result;
}

/** True when `iss` exactly matches (after trailing-slash normalization) a trusted broker. */
function isTrustedIssuer(issuer: string, trustedBrokers: readonly string[]): boolean {
  const normalized = normalizeOrigin(issuer);
  return trustedBrokers.some((entry) => normalizeOrigin(entry) === normalized);
}

/**
 * Verifies the optional `rp_attestation` field of a discovery document.
 *
 * `attestation` is the raw field value (or `undefined` when absent). The
 * function never throws; every outcome is a status plus a stable reason.
 */
export async function verifyRpAttestation(
  attestation: unknown,
  context: AttestationVerificationContext,
  options: AttestationVerificationOptions,
): Promise<AttestationVerificationResult> {
  const now = options.at ?? Math.floor(Date.now() / 1000);
  const result = emptyResult(options, now);

  if (attestation === undefined || attestation === null) {
    push(result, "field.present", "skip", "no rp_attestation field (optional; document is unverified)");
    // An absent optional field is never a failure, but a run that explicitly
    // asked for verification must say out loud that there was nothing to verify.
    if (options.check) {
      result.warnings.push(
        "rp_attestation is absent; the document is unverified (no attestation to verify; exit unchanged)",
      );
    }
    return result;
  }

  result.present = true;

  // A malformed field is a **conformance** error, not a verification verdict
  // (spec §5.3/§19.1): there is no JWS to verify. The document check fails the
  // run with exit 1; the attestation result reports `not_checked` rather than
  // mislabelling a non-token as `invalid`.
  if (typeof attestation !== "string") {
    push(result, "field.present", "pass", "rp_attestation is present");
    push(result, "field.format", "fail", "rp_attestation must be a string");
    result.status = "not_checked";
    result.reason = "field_malformed";
    return result;
  }
  if (attestation.length > 16_384 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(attestation)) {
    push(result, "field.present", "pass", "rp_attestation is present");
    push(
      result,
      "field.format",
      "fail",
      "rp_attestation must be three unpadded base64url segments separated by `.` and at most 16384 characters",
    );
    result.status = "not_checked";
    result.reason = "field_malformed";
    return result;
  }

  push(result, "field.present", "pass", "rp_attestation is present");
  push(result, "field.format", "pass", "rp_attestation is a compact JWS within the size bound");

  if (!options.check) {
    result.status = "not_checked";
    result.reason = "not_checked";
    push(
      result,
      "jws.parse",
      "skip",
      "attestation verification not requested (pass --verify-attestation)",
    );
    return result;
  }

  result.checked = true;

  const parsed = parseCompactJws(attestation);
  if (!parsed.ok) {
    push(result, "jws.parse", "fail", parsed.message);
    return failWith(result, "invalid", parsed.reason, parsed.message);
  }
  push(result, "jws.parse", "pass", "compact JWS parsed (header and claims are JSON objects)");

  const header = parsed.jws.header;

  if (header.typ !== ATTESTATION_TYP) {
    push(result, "typ", "fail", `typ must be exactly \`${ATTESTATION_TYP}\` (found ${JSON.stringify(header.typ ?? null)})`);
    return failWith(result, "invalid", "wrong_typ", `attestation typ is not ${ATTESTATION_TYP}`);
  }
  push(result, "typ", "pass", `typ is ${ATTESTATION_TYP}`);

  if (header.alg !== "EdDSA") {
    push(result, "alg", "fail", `alg must be exactly \`EdDSA\` (found ${JSON.stringify(header.alg ?? null)})`);
    return failWith(result, "invalid", "wrong_alg", "attestation alg is not EdDSA");
  }
  push(result, "alg", "pass", "alg is EdDSA");

  if (typeof header.kid !== "string" || !KEY_ID_PATTERN.test(header.kid)) {
    push(result, "kid", "fail", "the header must carry exactly one `kid` matching [A-Za-z0-9._-]{1,64}");
    return failWith(result, "invalid", "missing_kid", "attestation header has no usable `kid`");
  }
  const headerKid = header.kid;
  push(result, "kid", "pass", `kid is ${headerKid}`);

  let claims: RpAttestationClaims;
  try {
    claims = parseRpAttestationVerifier(parsed.jws.claims);
  } catch (error) {
    const issues =
      error !== null && typeof error === "object" && "issues" in error
        ? (error as { issues: { path: (string | number)[]; message: string }[] }).issues
            .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
            .join("; ")
        : String(error);
    push(result, "claims", "fail", `attestation claims are invalid: ${issues}`);
    return failWith(result, "invalid", "claims_invalid", `attestation claims are invalid: ${issues}`);
  }

  result.iss = claims.iss;
  result.jti = claims.jti;
  result.origin = claims.rp.origin;
  result.audience = claims.rp.audience;
  result.level = claims.rp.verification.level;
  push(
    result,
    "claims",
    "pass",
    `claims are structurally valid (iss ${claims.iss}, jti ${claims.jti}, level ${claims.rp.verification.level})`,
  );

  // Step 2: trust before any JWKS/status fetch.
  if (!isTrustedIssuer(claims.iss, options.trustedBrokers)) {
    push(result, "issuer_trusted", "fail", `iss ${claims.iss} is not in the trusted RP-broker list`);
    push(result, "jwks", "skip", "JWKS not fetched: the issuer is not trusted");
    result.status = "attested_untrusted_broker";
    result.reason = "rp_broker_untrusted";
    result.errors.push(
      `rp_broker_untrusted: ${claims.iss} is not in the trusted RP-broker list; no JWKS fetch was attempted`,
    );
    return result;
  }
  push(result, "issuer_trusted", "pass", `iss ${claims.iss} is trusted`);

  const jwks = await loadIssuerJwks(claims.iss, options);
  result.jwks_source = jwks.source;
  if (jwks.ok) {
    result.warnings.push(...jwks.notes);
  }
  if (!jwks.ok) {
    push(result, "jwks", "fail", `could not load JWKS: ${jwks.message}`);
    result.status = "unavailable";
    result.reason = "rp_broker_unavailable";
    result.errors.push(`rp_broker_unavailable: could not load JWKS from ${jwks.source}: ${jwks.message}`);
    return result;
  }
  push(result, "jwks", "pass", `loaded ${jwks.keys.length} JWK(s) from ${jwks.source}`);

  const matching = jwks.keys.filter(
    (key): key is Record<string, unknown> => isRecord(key) && key.kid === headerKid,
  );
  if (matching.length === 0) {
    push(result, "kid", "fail", `no JWKS key matches kid ${headerKid}`);
    return failWith(
      result,
      "invalid",
      "unknown_kid",
      `no key with kid ${headerKid} exists in the issuer JWKS`,
    );
  }
  if (matching.length > 1) {
    push(result, "kid", "fail", `the issuer JWKS publishes ${matching.length} keys with kid ${headerKid}`);
    return failWith(result, "invalid", "duplicate_jwk_kid", `JWKS contains duplicate kid ${headerKid}`);
  }

  const signature = verifyEd25519Jwk(matching[0], parsed.jws.signingInput, parsed.jws.signature);
  if (!signature.ok) {
    push(result, "signature", "fail", signature.message);
    return failWith(result, "invalid", "bad_signature", signature.message);
  }
  push(result, "signature", "pass", `signature verifies with kid ${headerKid}`);

  if (claims.exp - claims.iat !== ATTESTATION_LIFETIME_SECONDS) {
    // Defensive: the schema already enforces this cross-field rule.
    push(result, "window", "fail", "exp - iat is not exactly 86400 seconds");
    return failWith(result, "invalid", "claims_invalid", "exp - iat must be 86400 seconds");
  }
  if (now + CLOCK_SKEW_SECONDS < claims.iat) {
    push(result, "window", "fail", `attestation is not valid yet (iat ${claims.iat}, now ${now})`);
    return failWith(result, "invalid", "not_yet_valid", "attestation iat is in the future beyond 60s skew");
  }
  if (now - CLOCK_SKEW_SECONDS > claims.exp) {
    push(
      result,
      "window",
      "fail",
      `attestation expired at ${new Date(claims.exp * 1000).toISOString()} (now ${new Date(now * 1000).toISOString()})`,
    );
    result.status = "expired";
    result.reason = "attestation_expired";
    result.errors.push(`attestation_expired: exp ${claims.exp} is before now ${now} minus 60s skew`);
    return result;
  }
  push(
    result,
    "window",
    "pass",
    `attestation is current (iat ${claims.iat}, exp ${claims.exp}, now ${now}, skew ${CLOCK_SKEW_SECONDS}s)`,
  );

  if (!ATTESTATION_JTI_PATTERN.test(claims.jti)) {
    // Defensive: the schema already enforces the pattern.
    push(result, "claims", "fail", "jti does not match the frozen rpa_ pattern");
    return failWith(result, "invalid", "claims_invalid", "jti does not match the frozen rpa_ pattern");
  }

  // Step 5: origin binding to the document actually fetched.
  if (context.documentOrigin === null) {
    push(
      result,
      "origin",
      "skip",
      "cannot bind rp.origin: file mode has no fetch origin (declare `__fixture_origin` in fixtures, or validate the URL)",
    );
    result.status = "unavailable";
    result.reason = "origin_unverifiable";
    result.errors.push(
      "origin_unverifiable: no fetched document origin is available, so rp.origin cannot be checked",
    );
    return result;
  }
  if (normalizeOrigin(claims.rp.origin) !== normalizeOrigin(context.documentOrigin)) {
    push(
      result,
      "origin",
      "fail",
      `rp.origin ${claims.rp.origin} does not equal the fetched document origin ${context.documentOrigin}`,
    );
    return failWith(
      result,
      "invalid",
      "wrong_origin",
      `rp.origin ${claims.rp.origin} does not equal the fetched document origin ${context.documentOrigin}`,
    );
  }
  push(result, "origin", "pass", `rp.origin equals the fetched document origin (${context.documentOrigin})`);

  // Step 6: audience binding.
  if (context.documentAudience === null) {
    push(result, "audience", "fail", "the discovery document has no audience to bind");
    return failWith(result, "invalid", "audience_unverifiable", "the discovery document has no audience");
  }
  if (claims.rp.audience !== context.documentAudience) {
    push(
      result,
      "audience",
      "fail",
      `rp.audience ${claims.rp.audience} does not equal discovery.audience ${context.documentAudience}`,
    );
    return failWith(
      result,
      "invalid",
      "wrong_audience",
      `rp.audience ${claims.rp.audience} does not equal discovery.audience ${context.documentAudience}`,
    );
  }
  push(
    result,
    "audience",
    "pass",
    `rp.audience equals discovery.audience (${context.documentAudience})`,
  );

  result.status = "verified";
  result.reason = null;
  result.verified = true;
  return result;
}

/** Exposed for callers that need the audience label without importing constants. */
export const ATTESTATION_AUDIENCE = PROTOCOL_AUDIENCE;
