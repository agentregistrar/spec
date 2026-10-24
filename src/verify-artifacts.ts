/**
 * Contract E / D.2 / I artifact checks for the fixture harness
 * (`pnpm validate:fixtures`) — verifier-internal, not exported from
 * `src/index.ts`.
 *
 * These are the *named rules* from the specification, applied to the standalone
 * JWS fixtures so each negative fixture fails for exactly one reason. They are
 * not a second implementation of Contract F or D.2: the broker-side flows live
 * in the private monorepo (Issues 13/14). The harness needs just enough to prove
 * the fixtures exercise the frozen rules.
 */
import {
  ABUSE_REPORT_LIFETIME_SECONDS,
  ABUSE_TYP,
  ATTESTATION_STATUS_LIFETIME_SECONDS,
  ATTESTATION_STATUS_TYP,
  CLOCK_SKEW_SECONDS,
  RECEIPT_TYP,
} from "./constants";
import { isRecord } from "./http";
import { AttestationStatusClaimsSchema } from "./schema";
import {
  loadIssuerJwks,
  parseCompactJws,
  verifyEd25519Jwk,
  type AttestationVerificationOptions,
} from "./validate-attestation";

export interface ArtifactVerification {
  valid: boolean;
  /** Stable rule id when invalid (`null` when valid). */
  rule: string | null;
  message: string;
}

function ok(): ArtifactVerification {
  return { valid: true, rule: null, message: "all named rules pass" };
}

function fail(rule: string, message: string): ArtifactVerification {
  return { valid: false, rule, message };
}

function decodeClaims(parsed: { claims: unknown }): Record<string, unknown> | null {
  return isRecord(parsed.claims) ? parsed.claims : null;
}

function headerKid(header: Record<string, unknown>): string | null {
  return typeof header.kid === "string" ? header.kid : null;
}

function checkHeader(
  header: Record<string, unknown>,
  expectedTyp: string,
): ArtifactVerification | null {
  if (header.alg !== "EdDSA") {
    return fail("alg", `header alg must be EdDSA (found ${JSON.stringify(header.alg ?? null)})`);
  }
  if (header.typ !== expectedTyp) {
    return fail("typ", `header typ must be ${expectedTyp} (found ${JSON.stringify(header.typ ?? null)})`);
  }
  if (headerKid(header) === null) {
    return fail("kid", "header must carry a string `kid`");
  }
  return null;
}

interface AttestationLike {
  jti: string;
  iat: number;
  exp: number;
  keys: { kid: string; x: string; purposes: string[] }[];
  rp: { origin: string; audience: string };
}

function asAttestationLike(value: unknown): AttestationLike | null {
  if (!isRecord(value) || !isRecord(value.rp) || !Array.isArray(value.keys)) {
    return null;
  }
  const keys = value.keys.filter(
    (key): key is { kid: string; x: string; purposes: string[] } =>
      isRecord(key) &&
      typeof key.kid === "string" &&
      typeof key.x === "string" &&
      Array.isArray(key.purposes),
  );
  if (
    typeof value.jti !== "string" ||
    typeof value.iat !== "number" ||
    typeof value.exp !== "number" ||
    typeof value.rp.origin !== "string" ||
    typeof value.rp.audience !== "string"
  ) {
    return null;
  }
  return {
    jti: value.jti,
    iat: value.iat,
    exp: value.exp,
    keys,
    rp: { origin: value.rp.origin, audience: value.rp.audience },
  };
}

function findKey(
  attestation: AttestationLike,
  kid: string,
): { kid: string; x: string; purposes: string[] } | null {
  return attestation.keys.find((key) => key.kid === kid) ?? null;
}

// ---------------------------------------------------------------------------
// Contract E — receipt v1.2.
// ---------------------------------------------------------------------------

/**
 * Checks the receipt rules that cannot be expressed by its JSON Schema:
 * typ/alg/kid, `header.kid === service.key_id`, key membership + `receipt`
 * purpose, origin/audience/attestation binding, and the historical window.
 * A legacy `exp` is deliberately ignored (it can never cause rejection).
 */
export function verifyReceiptFixture(
  jwt: string,
  attestationClaimsValue: unknown,
  at: number,
): ArtifactVerification {
  const attestation = asAttestationLike(attestationClaimsValue);
  if (attestation === null) {
    return fail("attestation", "the referenced attestation fixture is not parseable");
  }
  const parsed = parseCompactJws(jwt);
  if (!parsed.ok) {
    return fail("jws_parse", parsed.message);
  }
  const header = parsed.jws.header;
  const headerFailure = checkHeader(header, RECEIPT_TYP);
  if (headerFailure !== null) {
    return headerFailure;
  }
  const claims = decodeClaims(parsed.jws);
  if (claims === null) {
    return fail("claims", "receipt claims are not a JSON object");
  }
  const service = isRecord(claims.service) ? claims.service : null;
  if (service === null) {
    return fail("claims", "receipt has no `service` object");
  }
  if (typeof service.key_id !== "string") {
    return fail("missing_key_id", "service.key_id is required to name the signing key");
  }
  if (service.key_id !== header.kid) {
    return fail(
      "header_kid_mismatch",
      `header kid ${String(header.kid)} must equal service.key_id ${service.key_id}`,
    );
  }
  const key = findKey(attestation, service.key_id);
  if (key === null) {
    return fail(
      "key_not_in_attestation",
      `service.key_id ${service.key_id} is not in the attestation keys[]`,
    );
  }
  if (!key.purposes.includes("receipt")) {
    return fail("key_purpose", `key ${key.kid} lacks the receipt purpose`);
  }
  const signature = verifyEd25519Jwk(key, parsed.jws.signingInput, parsed.jws.signature);
  if (!signature.ok) {
    return fail("signature", signature.message);
  }
  if (claims.iss !== service.origin || claims.iss !== attestation.rp.origin) {
    return fail(
      "origin",
      `iss (${String(claims.iss)}), service.origin (${String(service.origin)}), and attestation rp.origin (${attestation.rp.origin}) must be equal`,
    );
  }
  if (service.audience !== attestation.rp.audience) {
    return fail(
      "audience",
      `service.audience (${String(service.audience)}) must equal attestation rp.audience (${attestation.rp.audience})`,
    );
  }
  if (service.attestation_jti !== attestation.jti) {
    return fail(
      "attestation_jti",
      `service.attestation_jti (${String(service.attestation_jti)}) must name the presented attestation (${attestation.jti})`,
    );
  }
  const iat = claims.iat;
  const signedUpAt = claims.signed_up_at;
  if (typeof iat !== "number" || typeof signedUpAt !== "number") {
    return fail("window", "iat and signed_up_at must be integer seconds");
  }
  if (iat < attestation.iat || iat > attestation.exp) {
    return fail(
      "window",
      `iat ${iat} is outside the attestation [${attestation.iat}, ${attestation.exp}] window`,
    );
  }
  if (signedUpAt < attestation.iat || signedUpAt > attestation.exp) {
    return fail(
      "window",
      `signed_up_at ${signedUpAt} is outside the attestation [${attestation.iat}, ${attestation.exp}] window`,
    );
  }
  // A legacy `exp` is ignored on purpose: no check is performed on `claims.exp`.
  void at;
  return ok();
}

// ---------------------------------------------------------------------------
// Contract D.2 — authenticated abuse report.
// ---------------------------------------------------------------------------

export function verifyAbuseFixture(
  jwt: string,
  attestationClaimsValue: unknown,
  brokerIssuer: string,
  at: number,
): ArtifactVerification {
  const attestation = asAttestationLike(attestationClaimsValue);
  if (attestation === null) {
    return fail("attestation", "the referenced attestation fixture is not parseable");
  }
  const parsed = parseCompactJws(jwt);
  if (!parsed.ok) {
    return fail("jws_parse", parsed.message);
  }
  const header = parsed.jws.header;
  const headerFailure = checkHeader(header, ABUSE_TYP);
  if (headerFailure !== null) {
    return headerFailure;
  }
  const claims = decodeClaims(parsed.jws);
  if (claims === null) {
    return fail("claims", "abuse report claims are not a JSON object");
  }
  const key = findKey(attestation, headerKid(header) ?? "");
  if (key === null) {
    return fail("key_not_in_attestation", "the report kid must be in the attestation keys[]");
  }
  if (!key.purposes.includes("abuse")) {
    return fail("key_purpose", `key ${key.kid} lacks the abuse purpose`);
  }
  const signature = verifyEd25519Jwk(key, parsed.jws.signingInput, parsed.jws.signature);
  if (!signature.ok) {
    return fail("signature", signature.message);
  }
  if (claims.iss !== attestation.rp.origin) {
    return fail("origin", `iss (${String(claims.iss)}) must equal attestation rp.origin (${attestation.rp.origin})`);
  }
  if (claims.aud !== brokerIssuer) {
    return fail("audience", `aud (${String(claims.aud)}) must equal the human broker issuer ${brokerIssuer}`);
  }
  if (typeof claims.iat !== "number" || typeof claims.exp !== "number") {
    return fail("claims", "iat and exp must be integer seconds");
  }
  if (claims.exp - claims.iat !== ABUSE_REPORT_LIFETIME_SECONDS) {
    return fail("lifetime", `exp - iat must equal ${ABUSE_REPORT_LIFETIME_SECONDS} seconds`);
  }
  if (at < claims.iat - CLOCK_SKEW_SECONDS) {
    return fail("not_yet_valid", `report iat ${claims.iat} is in the future beyond 60s skew`);
  }
  if (at > claims.exp) {
    return fail("expired", `report expired at ${claims.exp} (now ${at}); the 300s bound is never extended`);
  }
  return ok();
}

// ---------------------------------------------------------------------------
// Contract I — attestation status JWS.
// ---------------------------------------------------------------------------

export interface StatusVerificationOptions {
  expectedSub: string;
  jwks: string | null;
  issuer: string;
  at: number;
  timeoutMs: number;
  maxBytes: number;
}

export async function verifyStatusFixture(
  jwt: string,
  options: StatusVerificationOptions,
): Promise<ArtifactVerification & { claims: unknown | null }> {
  const parsed = parseCompactJws(jwt);
  if (!parsed.ok) {
    return { valid: false, rule: "jws_parse", message: parsed.message, claims: null };
  }
  const header = parsed.jws.header;
  const headerFailure = checkHeader(header, ATTESTATION_STATUS_TYP);
  if (headerFailure !== null) {
    return { ...headerFailure, claims: null };
  }
  const claimsResult = AttestationStatusClaimsSchema.safeParse(parsed.jws.claims);
  if (!claimsResult.success) {
    return {
      valid: false,
      rule: "claims",
      message: claimsResult.error.issues.map((issue) => issue.message).join("; "),
      claims: parsed.jws.claims,
    };
  }
  const claims = claimsResult.data;
  if (claims.sub !== options.expectedSub) {
    return {
      valid: false,
      rule: "wrong_sub",
      message: `sub ${claims.sub} must equal the queried attestation jti ${options.expectedSub}`,
      claims: parsed.jws.claims,
    };
  }
  const verificationOptions: AttestationVerificationOptions = {
    trustedBrokers: [options.issuer],
    jwks: options.jwks,
    at: options.at,
    timeoutMs: options.timeoutMs,
    maxBytes: options.maxBytes,
    required: false,
    check: true,
  };
  const jwks = await loadIssuerJwks(options.issuer, verificationOptions);
  if (!jwks.ok) {
    return { valid: false, rule: "jwks", message: jwks.message, claims: parsed.jws.claims };
  }
  const kid = headerKid(header) ?? "";
  const jwk = jwks.keys.find((entry) => isRecord(entry) && entry.kid === kid);
  if (!isRecord(jwk)) {
    return {
      valid: false,
      rule: "unknown_kid",
      message: `no JWKS key matches kid ${kid}`,
      claims: parsed.jws.claims,
    };
  }
  const signature = verifyEd25519Jwk(jwk, parsed.jws.signingInput, parsed.jws.signature);
  if (!signature.ok) {
    return { valid: false, rule: "bad_signature", message: signature.message, claims: parsed.jws.claims };
  }
  if (claims.exp - claims.iat !== ATTESTATION_STATUS_LIFETIME_SECONDS) {
    return {
      valid: false,
      rule: "lifetime",
      message: `exp - iat must equal ${ATTESTATION_STATUS_LIFETIME_SECONDS} seconds`,
      claims: parsed.jws.claims,
    };
  }
  return { valid: true, rule: null, message: "all named rules pass", claims: parsed.jws.claims };
}
