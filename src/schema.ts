/**
 * Contract D.1 — Relying Party Discovery (identity-only v1).
 *
 * Published by a relying party at `GET /.well-known/agent-signup.json` and
 * consumed by agents to drive brokered signup. The normative definition lives in
 * `agent-identity-v1.md`; this Zod schema is the canonical implementation
 * source of truth for that identity-only v1 document. Consumers (the private
 * monorepo, future npm users of `@agentregistrar/discovery`) depend on this
 * package, so the public copy here is authoritative.
 *
 * The document is a **parameter document, not a capability catalog**. Vendor
 * capability surface (product catalogs/SKUs, provisioning endpoints, legacy
 * email/OTP endpoints, and broker receipt callbacks) is forbidden and is
 * actively rejected by {@link AgentSignupDiscoverySchema}.
 *
 * Field-preservation policy (spec §5.4 and §13):
 * - Unknown *additive* fields are allowed and **preserved** (`.passthrough()`),
 *   so v1 can evolve additively without silent data loss.
 * - Non-capability vendor metadata SHOULD be namespaced under
 *   `extensions.<reverse-dns-namespace>`; the conformance validator warns about
 *   unknown non-namespaced fields so typos stay visible.
 * - Only the explicitly removed vendor fields are rejected; a blanket `.strict()`
 *   would make additive evolution impossible.
 */
import { createHash } from "node:crypto";

import { z } from "zod";

import {
  ABUSE_JTI_PATTERN,
  ABUSE_REPORT_LIFETIME_SECONDS,
  ATTESTATION_FIELD_MAX_LENGTH,
  ATTESTATION_JTI_PATTERN,
  ATTESTATION_LIFETIME_SECONDS,
  ATTESTATION_STATUS_LIFETIME_SECONDS,
  COMPACT_JWS_PATTERN,
  ED25519_PUBLIC_KEY_PATTERN,
  KEY_ID_PATTERN,
  MAX_ATTESTATION_KEYS,
  PROTOCOL_AUDIENCE,
  PROTOCOL_VERSION,
  RECEIPT_JTI_PATTERN,
  UUID_PATTERN,
} from "./constants";
import { isHttpsCanonicalOrigin } from "./http";

/**
 * Computes the canonical `sha256:<64 lowercase hex>` content hash used to
 * reference immutable content (the relying party terms text, the Master ToS,
 * etc.) over the exact UTF-8 bytes of `content`.
 */
function computeSha256Prefixed(content: string): string {
  const digest = createHash("sha256").update(content, "utf8").digest("hex");
  return `sha256:${digest}`;
}

/** Hostnames that may use plain `http://` as the documented development exception. */
const DEV_LOCALHOST_HOSTNAMES = new Set(["localhost", "127.0.0.1"]);

/** Parses `value` as an absolute `http(s)` URL, returning `null` otherwise. */
function parseAbsoluteHttpUrl(value: string): URL | null {
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

/** True for `http://localhost` / `http://127.0.0.1` development origins. */
function isDevelopmentOrigin(url: URL): boolean {
  return url.protocol === "http:" && DEV_LOCALHOST_HOSTNAMES.has(url.hostname);
}

/**
 * Absolute protocol URL: `https://` everywhere, with the documented
 * `http://localhost` / `http://127.0.0.1` development exception (spec §5.4).
 */
function isAbsoluteProtocolUrl(value: string): boolean {
  const url = parseAbsoluteHttpUrl(value);
  if (url === null) {
    return false;
  }
  return url.protocol === "https:" || isDevelopmentOrigin(url);
}

/**
 * Absolute issuer origin: scheme + host (optional port), no path, query,
 * fragment, or wildcard. A single trailing slash is tolerated (normalized away).
 */
function isAbsoluteOrigin(value: string): boolean {
  if (value.includes("*")) {
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

/** Normalizes an origin for duplicate detection (trailing slashes removed). */
function normalizeOrigin(value: string): string {
  return value.replace(/\/+$/, "");
}

/** True when every entry of `values` (after normalization) is unique. */
function hasNoDuplicates(values: readonly string[]): boolean {
  const normalized = values.map(normalizeOrigin);
  return new Set(normalized).size === normalized.length;
}

/** Minimal email shape accepted for the optional `contact` field. */
const EMAIL_PATTERN = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/** Absolute `http(s)` protocol URL, with the localhost development exception. */
const absoluteProtocolUrl = z
  .string()
  .min(1)
  .refine(isAbsoluteProtocolUrl, {
    message:
      "must be an absolute http(s) URL (https required except http://localhost / http://127.0.0.1)",
  });

/** Absolute issuer origin with no path/query/fragment/wildcard (spec §5.4). */
const issuerOrigin = z
  .string()
  .min(1)
  .refine(isAbsoluteOrigin, {
    message:
      "must be an absolute issuer origin with no path, query, fragment, or wildcard",
  });

/** `sha256:<64 lowercase hex characters>` (spec §6). */
const sha256Hash = z
  .string()
  .regex(
    /^sha256:[0-9a-f]{64}$/,
    "must use the form `sha256:<64 lowercase hex characters>`",
  );

/** Non-empty, whitespace-free service identifier (spec §5.1). */
const audience = z
  .string()
  .min(1)
  .refine((value) => !/\s/.test(value), {
    message: "must be a stable, whitespace-free service identifier",
  });

/** Email address or absolute `http(s)` URL (spec §5.2). */
const contact = z
  .string()
  .min(1)
  .refine((value) => EMAIL_PATTERN.test(value) || isAbsoluteProtocolUrl(value), {
    message: "must be an email address or an absolute http(s) URL",
  });

/**
 * Strict RFC 3339 / ISO 8601 date-time for human/debuggability (spec §5.2).
 * `offset: true` accepts an explicit `Z` or numeric offset and rejects bare
 * dates and implementation-specific strings that `Date.parse` would accept, so
 * Zod agrees with the checked-in JSON Schema's `format: date-time`.
 */
const iso8601Timestamp = z
  .string()
  .datetime({ offset: true, message: "must be a valid RFC 3339 date-time" });

/**
 * Identity-only v1 discovery document served at `/.well-known/agent-signup.json`.
 *
 * Required: `protocol`, `audience`, `provider_name`, `issuer_allowlist`,
 * `required_scopes`, `terms` (`version`/`url`/`sha256`/`text`), and
 * `endpoints.agent_signup` — the only endpoint.
 *
 * The removed vendor fields (`instance_catalog`, `endpoints.provision`,
 * `endpoints.email_signup`, `endpoints.verify_otp`, and
 * `endpoints.broker_signup_receipt`) are declared as `z.never()` so the schema
 * *rejects* them, while genuinely unknown additive identity fields and
 * `extensions` data are allowed and preserved.
 */
export const AgentSignupDiscoverySchema = z
  .object({
    protocol: z.literal("agent-identity-v1"),

    audience,
    provider_name: z.string().min(1),

    // Contract G carrier (spec §5.3): an OPTIONAL compact JWS. Presence changes
    // no other field; absence is conformant and means "unverified".
    rp_attestation: z
      .string()
      .max(
        ATTESTATION_FIELD_MAX_LENGTH,
        `rp_attestation must be at most ${ATTESTATION_FIELD_MAX_LENGTH} characters`,
      )
      .regex(
        COMPACT_JWS_PATTERN,
        "rp_attestation must be a compact JWS: three base64url segments separated by `.`",
      )
      .optional(),

    // Optional identity metadata.
    spec: absoluteProtocolUrl.optional(),
    provider_url: absoluteProtocolUrl.optional(),
    contact: contact.optional(),
    updated_at: iso8601Timestamp.optional(),

    issuer_allowlist: z
      .array(issuerOrigin)
      .min(1, "issuer_allowlist must contain at least one issuer origin")
      .refine(hasNoDuplicates, "issuer_allowlist entries must be unique"),

    required_scopes: z
      .array(z.string().min(1))
      .min(1, "required_scopes must contain at least one scope")
      .refine(hasNoDuplicates, "required_scopes entries must be unique")
      .refine(
        (scopes) => scopes.includes("tos:accept"),
        "required_scopes must include `tos:accept`",
      ),

    terms: z
      .object({
        version: z.string().min(1),
        url: absoluteProtocolUrl,
        sha256: sha256Hash,
        text: z.string().min(1),
      })
      .passthrough()
      .superRefine((value, ctx) => {
        // spec §6: the advertised hash MUST be the SHA-256 of the exact UTF-8
        // bytes of `text` (no normalization, trimming, or HTML extraction).
        const expected = computeSha256Prefixed(value.text);
        if (value.sha256 !== expected) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["sha256"],
            message:
              "terms.sha256 must equal the SHA-256 of the exact UTF-8 bytes " +
              `of terms.text (expected ${expected})`,
          });
        }
      }),

    // `agent_signup` is the only v1 endpoint. The removed vendor endpoints are
    // forbidden and rejected; unknown additive endpoints are preserved.
    endpoints: z
      .object({
        agent_signup: absoluteProtocolUrl,

        // Forbidden vendor endpoints (removed from v1).
        provision: z.never().optional(),
        email_signup: z.never().optional(),
        verify_otp: z.never().optional(),
        broker_signup_receipt: z.never().optional(),
      })
      .passthrough(),

    // Non-capability vendor metadata keyed by reverse-DNS namespace.
    extensions: z.record(z.unknown()).optional(),

    // Forbidden vendor capability surface (removed from v1).
    instance_catalog: z.never().optional(),
  })
  .passthrough();

export type AgentSignupDiscovery = z.infer<typeof AgentSignupDiscoverySchema>;

// ===========================================================================
// Contract G — RP attestation (`agent-rp-attestation+jwt`)
// ===========================================================================
//
// Two modes are frozen (spec §5.12, ledger §3.12):
//
// - **Producer mode** (`RpAttestationClaimsSchema`) is closed at every object
//   level. A v1.2 producer MUST NOT emit unknown fields.
// - **Verifier mode** validates every known field and ignores unknown additive
//   fields, so a future additive minor revision does not break an older
//   verifier. Ignoring an unknown field is not permission to skip a known check.
//
// The published JSON Schema (`rp-attestation.schema.json`) is producer mode; the
// named parser `parseRpAttestationVerifier` is the verifier gate.

/** `domain` or `entity` (spec §5.10). No `enhanced` in v1.2. */
export const AssuranceLevelSchema = z.enum(["domain", "entity"]);
export type AssuranceLevel = z.infer<typeof AssuranceLevelSchema>;

/** Attestation status values from Contract I (spec §5.5). */
export const AttestationStatusValueSchema = z.enum(["active", "suspended", "revoked"]);
export type AttestationStatusValue = z.infer<typeof AttestationStatusValueSchema>;

/** The JWS header of a Contract G attestation. */
export const RpAttestationHeaderSchema = z
  .object({
    alg: z.literal("EdDSA"),
    typ: z.literal("agent-rp-attestation+jwt"),
    kid: z
      .string()
      .regex(KEY_ID_PATTERN, "kid must be 1-64 characters of [A-Za-z0-9._-]"),
  })
  .strict();
export type RpAttestationHeader = z.infer<typeof RpAttestationHeaderSchema>;

/** One public RP signing key carried in the attestation. */
export const RpAttestationKeySchema = z
  .object({
    kid: z
      .string()
      .regex(KEY_ID_PATTERN, "kid must be 1-64 characters of [A-Za-z0-9._-]"),
    kty: z.literal("OKP"),
    crv: z.literal("Ed25519"),
    x: z
      .string()
      .regex(ED25519_PUBLIC_KEY_PATTERN, "x must be a base64url 32-byte Ed25519 public key"),
    alg: z.literal("EdDSA"),
    purposes: z.tuple([z.literal("receipt"), z.literal("abuse")]),
  })
  .strict();
export type RpAttestationKey = z.infer<typeof RpAttestationKeySchema>;

/**
 * A canonical **HTTPS** origin for a signed identity artifact. The localhost
 * development exception applies to discovery/terms/endpoint URLs, never to the
 * broker `iss`, the attested `rp.origin`, or the metadata `issuer` (spec §14.1,
 * §16.1; the published JSON Schemas agree).
 */
function httpsCanonicalOriginString(message: string) {
  return z.string().min(1).refine(isHttpsCanonicalOrigin, { message });
}

const emailAddress = z
  .string()
  .min(1)
  .refine((value) => EMAIL_PATTERN.test(value), { message: "must be a single email address" });

const utcTimestamp = z
  .string()
  .datetime({ offset: true, message: "must be a valid RFC 3339 date-time" });

type SchemaMode = "producer" | "verifier";

function objectForMode<T extends z.ZodRawShape>(shape: T, mode: SchemaMode) {
  const object = z.object(shape);
  return mode === "producer" ? object.strict() : object.passthrough();
}

function buildRpAttestationClaimsSchema(mode: SchemaMode) {
  const object = <T extends z.ZodRawShape>(shape: T) => objectForMode(shape, mode);

  const contact = object({
    email: emailAddress,
    name: z.string().min(1).max(128).optional(),
  });

  const verification = object({
    level: AssuranceLevelSchema,
    method: z.enum(["https", "dns"]),
    origin_verified_at: utcTimestamp,
    entity_reviewed_at: utcTimestamp.nullable(),
  });

  const rp = object({
    id: z.string().regex(UUID_PATTERN, "rp.id must be the provider UUID"),
    origin: httpsCanonicalOriginString(
      "rp.origin must be a canonical HTTPS origin (lowercase, no path, query, fragment, or trailing slash)",
    ),
    audience: z
      .string()
      .min(1)
      .max(256)
      .regex(/^\S+$/, "rp.audience must be a non-empty, whitespace-free service identifier"),
    name: z.string().min(1).max(128),
    legal_name: z.string().min(1).max(256).optional(),
    contact,
    verification,
  });

  return object({
    iss: httpsCanonicalOriginString(
      "iss must be the broker issuer HTTPS origin (lowercase, no path, query, fragment, or trailing slash)",
    ),
    sub: z.string().regex(UUID_PATTERN, "sub must be the provider UUID"),
    aud: z.literal(PROTOCOL_AUDIENCE),
    jti: z.string().regex(ATTESTATION_JTI_PATTERN, "jti must be `rpa_` + 26-character lowercase Crockford base32"),
    iat: z.number().int(),
    exp: z.number().int(),
    rp,
    keys: z
      .array(RpAttestationKeySchema)
      .min(1)
      .max(MAX_ATTESTATION_KEYS, `keys must contain at most ${MAX_ATTESTATION_KEYS} entries`),
  }).superRefine((value, ctx) => {
    // Cross-field rules JSON Schema cannot express (spec §5.2, §5.12).
    if (value.exp - value.iat !== ATTESTATION_LIFETIME_SECONDS) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["exp"],
        message: `exp - iat must equal exactly ${ATTESTATION_LIFETIME_SECONDS} seconds`,
      });
    }
    if (value.rp.id !== value.sub) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["rp", "id"],
        message: "rp.id must equal sub (the provider UUID)",
      });
    }
    const kids = value.keys.map((key) => key.kid);
    if (new Set(kids).size !== kids.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["keys"],
        message: "keys[].kid must be unique within one attestation",
      });
    }
    if (value.rp.verification.level === "domain") {
      if (value.rp.verification.entity_reviewed_at !== null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["rp", "verification", "entity_reviewed_at"],
          message: "entity_reviewed_at must be null at `domain` level",
        });
      }
    } else {
      if (value.rp.verification.entity_reviewed_at === null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["rp", "verification", "entity_reviewed_at"],
          message: "entity_reviewed_at is required at `entity` level",
        });
      }
      if (value.rp.legal_name === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["rp", "legal_name"],
          message: "legal_name is required at `entity` level",
        });
      }
    }
  });
}

/** Producer mode: closed, for v1.2 producers and document conformance. */
export const RpAttestationClaimsSchema = buildRpAttestationClaimsSchema("producer");
export type RpAttestationClaims = z.infer<typeof RpAttestationClaimsSchema>;

/** Verifier mode: validates known fields, ignores unknown additive fields. */
export const RpAttestationClaimsVerifierSchema = buildRpAttestationClaimsSchema("verifier");

/**
 * Strict producer parser. Throws `ZodError` when the claims are not exactly a
 * v1.2 producer document (unknown fields are rejected).
 */
export function parseRpAttestationProducer(value: unknown): RpAttestationClaims {
  return RpAttestationClaimsSchema.parse(value);
}

/**
 * Tolerant verifier parser. Validates every known field, ignores unknown
 * additive fields, and throws `ZodError` only on a known-field violation.
 */
export function parseRpAttestationVerifier(value: unknown): RpAttestationClaims {
  return RpAttestationClaimsVerifierSchema.parse(value);
}

// ===========================================================================
// Contract I — broker metadata and attestation status
// ===========================================================================

const absoluteHttpsUrl = z.string().min(1).refine((value) => {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.username === "" && url.password === "";
  } catch {
    return false;
  }
}, { message: "must be an absolute HTTPS URL" });

const metadataContact = z.string().min(1).refine(
  (value) => EMAIL_PATTERN.test(value) || absoluteHttpsUrl.safeParse(value).success,
  { message: "contact must be an email address or an absolute HTTPS URL" },
);

/**
 * `GET /.well-known/agent-broker.json` (spec §5.4). All six fields are REQUIRED.
 * `jwks_uri` must be same-origin with `issuer`; a cross-origin value invalidates
 * the document.
 */
export const BrokerMetadataSchema = z
  .object({
    issuer: httpsCanonicalOriginString(
      "issuer must be the canonical HTTPS origin of the document itself",
    ),
    jwks_uri: absoluteHttpsUrl,
    attestation_status_uri: absoluteHttpsUrl,
    abuse_endpoint: absoluteHttpsUrl,
    protocol_versions: z
      .array(z.string().min(1))
      .min(1)
      .refine((values) => new Set(values).size === values.length, "entries must be unique")
      .refine(
        (values) => values.includes(PROTOCOL_VERSION),
        `must contain "${PROTOCOL_VERSION}"`,
      ),
    contact: metadataContact,
  })
  .strict()
  .superRefine((value, ctx) => {
    let jwksOrigin: string | null = null;
    try {
      jwksOrigin = new URL(value.jwks_uri).origin;
    } catch {
      jwksOrigin = null;
    }
    if (jwksOrigin !== value.issuer) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["jwks_uri"],
        message: "jwks_uri must be on the same origin as issuer",
      });
    }
  });
export type BrokerMetadata = z.infer<typeof BrokerMetadataSchema>;

/**
 * Contract I status JWS claims (spec §5.5). `sub` is the queried attestation
 * `jti`; `exp - iat` is exactly 300 seconds; `status_changed_at <= iat`.
 *
 * Like the attestation, the status JWS has a producer and a verifier mode
 * (ledger §3.15): the published JSON Schema is producer mode; an older verifier
 * validates every known field and ignores additive claims it does not know.
 */
function buildAttestationStatusClaimsSchema(mode: SchemaMode) {
  const base = z
    .object({
      iss: httpsCanonicalOriginString("iss must be the broker issuer HTTPS origin"),
      aud: z.literal(PROTOCOL_AUDIENCE),
      jti: z.string().regex(UUID_PATTERN, "jti must be a UUIDv4"),
      sub: z
        .string()
        .regex(ATTESTATION_JTI_PATTERN, "sub must be the queried attestation jti (`rpa_` + 26)"),
      iat: z.number().int(),
      exp: z.number().int(),
      status: AttestationStatusValueSchema,
      status_changed_at: utcTimestamp,
    });
  const object = mode === "producer" ? base.strict() : base.passthrough();
  return object.superRefine((value, ctx) => {
    if (value.exp - value.iat !== ATTESTATION_STATUS_LIFETIME_SECONDS) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["exp"],
        message: `exp - iat must equal exactly ${ATTESTATION_STATUS_LIFETIME_SECONDS} seconds`,
      });
    }
    const changedAt = Date.parse(value.status_changed_at);
    if (Number.isFinite(changedAt) && changedAt > value.iat * 1000) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["status_changed_at"],
        message: "status_changed_at must not be after iat",
      });
    }
  });
}

/** Producer mode: closed, for v1.2 producers and the published JSON Schema. */
export const AttestationStatusClaimsSchema = buildAttestationStatusClaimsSchema("producer");
export type AttestationStatusClaims = z.infer<typeof AttestationStatusClaimsSchema>;

/** Verifier mode: validates known fields, ignores unknown additive claims. */
export const AttestationStatusClaimsVerifierSchema =
  buildAttestationStatusClaimsSchema("verifier");

/**
 * Tolerant status-JWS verifier parser (producer/verifier parity with the
 * attestation parsers). Throws only on a known-field violation.
 */
export function parseAttestationStatusVerifier(value: unknown): AttestationStatusClaims {
  return AttestationStatusClaimsVerifierSchema.parse(value);
}

/**
 * The status endpoint response body (spec §5.5). `attestation_jti` is advisory:
 * clients MUST verify the JWS and use its `sub`.
 */
export const AttestationStatusResponseSchema = z
  .object({
    attestation_jti: z.string().regex(ATTESTATION_JTI_PATTERN),
    status_jwt: z.string().max(ATTESTATION_FIELD_MAX_LENGTH).regex(COMPACT_JWS_PATTERN),
  })
  .strict();
export type AttestationStatusResponse = z.infer<typeof AttestationStatusResponseSchema>;

// Patterns re-exported for callers that mirror the receipt/abuse rules in this
// package's fixtures without importing the private monorepo Zod schemas.
export const ReceiptJtiPattern = RECEIPT_JTI_PATTERN;
export const AbuseJtiPattern = ABUSE_JTI_PATTERN;
export const AbuseReportLifetimeSeconds = ABUSE_REPORT_LIFETIME_SECONDS;
