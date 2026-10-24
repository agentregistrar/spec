/**
 * Frozen numeric bounds, patterns, and clock constants for `agent-identity-v1`
 * `v1.2.0` (Contracts G, I, E, D.2). These mirror the normative text in
 * `agent-identity-v1.md` §5 and are shared by the Zod schemas, the attestation
 * verifier, and the fixture harness so no two copies can drift.
 */

/** `rp_attestation` in discovery is a compact JWS capped at 16 KiB (spec §5.3). */
export const ATTESTATION_FIELD_MAX_LENGTH = 16384;

/** A compact JWS: exactly three base64url segments separated by `.`. */
export const COMPACT_JWS_PATTERN = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

/** Lowercase Crockford base32 ULID (no `i`, `l`, `o`, `u`). */
export const CROCKFORD_ULID = "[0-9a-hjkmnp-tv-z]{26}";
export const ATTESTATION_JTI_PATTERN = new RegExp(`^rpa_${CROCKFORD_ULID}$`);
export const RECEIPT_JTI_PATTERN = new RegExp(`^srp_${CROCKFORD_ULID}$`);
export const ABUSE_JTI_PATTERN = new RegExp(`^abr_${CROCKFORD_ULID}$`);

/** RP key ids and broker `kid`s. */
export const KEY_ID_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;

/** base64url-encoded 32-byte Ed25519 public key (43 characters, no padding). */
export const ED25519_PUBLIC_KEY_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/** Provider ids are UUIDs (ledger §3.9). */
export const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** `exp - iat = 86400` for attestations (spec §5.2). */
export const ATTESTATION_LIFETIME_SECONDS = 86_400;
/** `exp - iat = 300` for attestation status responses (spec §5.5). */
export const ATTESTATION_STATUS_LIFETIME_SECONDS = 300;
/** `exp - iat = 300` for abuse reports (spec §5.9). */
export const ABUSE_REPORT_LIFETIME_SECONDS = 300;
/** Clock skew allowance for current-time comparisons (spec §5.2). */
export const CLOCK_SKEW_SECONDS = 60;

/** At most 8 simultaneous (active + retiring) RP keys (spec §5.2). */
export const MAX_ATTESTATION_KEYS = 8;

/** Broker metadata cache bound (spec §5.4) and JWKS cache bound (spec §5.2). */
export const MAX_METADATA_CACHE_AGE_MS = 60 * 60 * 1000;
export const MAX_JWKS_CACHE_AGE_MS = 60 * 60 * 1000;

/** v1.2 emits exactly these key purposes, in this order (spec §5.2). */
export const RP_KEY_PURPOSES = ["receipt", "abuse"] as const;

/** JWS `typ` values frozen in ledger §3.3. */
export const ATTESTATION_TYP = "agent-rp-attestation+jwt";
export const ATTESTATION_STATUS_TYP = "agent-rp-attestation-status+jwt";
export const KEY_POP_TYP = "agent-rp-key-pop+jwt";
export const ABUSE_TYP = "agent-rp-abuse+jwt";
export const RECEIPT_TYP = "agent-signup-receipt+jwt";

/** The assertion/attestation audience label; never the human broker issuer. */
export const PROTOCOL_AUDIENCE = "agent-identity-v1";

/** Broker metadata `protocol_versions` must contain this value (spec §5.4). */
export const PROTOCOL_VERSION = "agent-identity-v1";
