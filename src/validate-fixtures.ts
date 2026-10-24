/**
 * Standalone fixture harness (`pnpm validate:fixtures [fixtures/expected.json]`).
 *
 * This is a **manual harness, not a test framework**: it reads the expected
 * result for every fixture from `fixtures/expected.json`, exercises the same
 * code the CLI uses, and exits `0` (all rows match) or `1` (at least one row
 * differs). It exists because `AGENTS.md` forbids tests in this repository and
 * because standalone JWS fixtures cannot be checked by the discovery CLI alone.
 *
 * It checks four things per row:
 *
 * 1. the discovery validator's outcome (exit code, conformance, attestation);
 * 2. Contract G verification status and the producer/verifier schema split;
 * 3. the named rule for Contract E / D.2 / I artifacts;
 * 4. that every fixture validates (or is rejected) by its checked-in JSON
 *    Schema, and that Zod agrees with that schema.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import {
  ATTESTATION_JTI_PATTERN,
  COMPACT_JWS_PATTERN,
  KEY_ID_PATTERN,
  RP_KEY_PURPOSES,
} from "./constants";
import {
  checkAgainstRootSchema,
  loadRootSchema,
  stripUnknownToSchema,
} from "./json-schema";
import {
  BrokerMetadataSchema,
  AttestationStatusClaimsSchema,
  RpAttestationClaimsSchema,
  RpAttestationClaimsVerifierSchema,
} from "./schema";
import {
  parseClockValue,
  parseCompactJws,
  verifyRpAttestation,
  type AttestationVerificationOptions,
} from "./validate-attestation";
import { validateDiscoveryInput } from "./validate-discovery";
import { verifyAbuseFixture, verifyReceiptFixture, verifyStatusFixture } from "./verify-artifacts";

const ROOT = process.cwd();
const DEFAULT_EXPECTED = "fixtures/expected.json";
const CLOCK = 1_792_800_000;
const A_ISSUER = "https://agentregistrar.dev";
const BROKER_ISSUER = "https://rp-broker.example";

interface CaseOptions {
  verifyAttestation?: boolean;
  requireAttestation?: boolean;
  trustedBrokers?: string[];
  jwks?: string | null;
  at?: string;
}

interface FixtureCase {
  id: string;
  kind: "discovery" | "attestation" | "receipt" | "abuse" | "status" | "metadata" | "provider";
  path?: string;
  jwt?: string;
  attestation?: string;
  expectedSubFrom?: string;
  documentOrigin?: string;
  options?: CaseOptions;
  expect: Record<string, unknown>;
}

interface ExpectedMatrix {
  clock: string;
  defaults: CaseOptions;
  cases: FixtureCase[];
}

interface CaseOutcome {
  id: string;
  passed: boolean;
  detail: string;
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

async function readText(path: string): Promise<string> {
  return (await readFile(join(ROOT, path), "utf8")).trim();
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(join(ROOT, path), "utf8")) as unknown;
}

function asOptions(base: CaseOptions, override: CaseOptions | undefined) {
  return { ...base, ...(override ?? {}) };
}

function optionClock(options: CaseOptions): number {
  if (options.at === undefined) {
    return CLOCK;
  }
  const parsed = parseClockValue(options.at);
  if (parsed === null) {
    throw new Error(`invalid --at value in expected.json: ${options.at}`);
  }
  return parsed;
}

function verificationOptions(options: CaseOptions, required: boolean): AttestationVerificationOptions {
  return {
    trustedBrokers: options.trustedBrokers ?? [],
    jwks: options.jwks ?? null,
    at: optionClock(options),
    timeoutMs: 5_000,
    maxBytes: 256 * 1024,
    required,
    check: true,
  };
}

function claimsOf(jwt: string): unknown {
  const parsed = parseCompactJws(jwt);
  if (!parsed.ok) {
    throw new Error(`fixture JWS does not parse: ${parsed.message}`);
  }
  return parsed.jws.claims;
}

function compare(
  expected: unknown,
  actual: unknown,
  label: string,
  problems: string[],
): void {
  if (expected === undefined) {
    return;
  }
  if (JSON.stringify(expected) !== JSON.stringify(actual)) {
    problems.push(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

/** Validates claims in producer mode (closed) and verifier mode (known fields only). */
function schemaModes(
  claims: unknown,
  schemaFile: string,
  producer: boolean,
  verifier: boolean,
  problems: string[],
): void {
  const producerJson = checkAgainstRootSchema(claims, schemaFile).ok;
  if (producerJson !== producer) {
    problems.push(`${schemaFile} producer mode: expected valid=${producer}, got ${producerJson}`);
  }
  const loaded = loadRootSchema(schemaFile);
  if (loaded === null) {
    problems.push(`could not load ${schemaFile}`);
    return;
  }
  const projected = stripUnknownToSchema(claims, loaded);
  const verifierJson = checkAgainstRootSchema(projected, schemaFile).ok;
  if (verifierJson !== verifier) {
    problems.push(`${schemaFile} verifier mode: expected valid=${verifier}, got ${verifierJson}`);
  }
}

async function runDiscoveryCase(
  fixture: FixtureCase,
  defaults: CaseOptions,
): Promise<CaseOutcome> {
  const problems: string[] = [];
  const options = asOptions(defaults, fixture.options);
  const path = fixture.path;
  if (path === undefined) {
    return { id: fixture.id, passed: false, detail: "discovery case has no path" };
  }
  const result = await validateDiscoveryInput(path, {
    verifyAttestation: options.verifyAttestation ?? false,
    requireAttestation: options.requireAttestation ?? false,
    trustedBrokers: options.trustedBrokers ?? [],
    jwks: options.jwks ?? null,
    at: optionClock(options),
  });
  compare(fixture.expect.exitCode, result.exitCode, "exitCode", problems);
  compare(fixture.expect.status, result.attestation.status, "attestation.status", problems);
  compare(fixture.expect.level, result.attestation.level, "attestation.level", problems);
  compare(fixture.expect.conformance, result.conformance.valid, "conformance.valid", problems);
  compare(fixture.expect.verified, result.attestation.verified, "attestation.verified", problems);
  return {
    id: fixture.id,
    passed: problems.length === 0,
    detail: problems.length === 0 ? `exit ${result.exitCode}, ${result.attestation.status}` : problems.join("; "),
  };
}

async function runAttestationCase(
  fixture: FixtureCase,
  defaults: CaseOptions,
): Promise<CaseOutcome> {
  const problems: string[] = [];
  const options = asOptions(defaults, fixture.options);
  if (fixture.jwt === undefined) {
    return { id: fixture.id, passed: false, detail: "attestation case has no jwt" };
  }
  const jwt = await readText(fixture.jwt);
  const claims = claimsOf(jwt);

  const producerExpected = fixture.expect.producer === true;
  const verifierExpected = fixture.expect.verifier === true;

  // Producer mode: Zod is authoritative because it also enforces the cross-field
  // rules JSON Schema cannot express (exp-iat, rp.id, unique kid, entity fields).
  // The JSON Schema must therefore never reject something Zod accepts; it MAY
  // accept a document Zod rejects only for a documented cross-field rule.
  const producerJson = checkAgainstRootSchema(claims, "rp-attestation.schema.json").ok;
  const producerZod = RpAttestationClaimsSchema.safeParse(claims).success;
  if (producerZod !== producerExpected) {
    problems.push(`producer mode (Zod): expected valid=${producerExpected}, got ${producerZod}`);
  }
  if (producerZod && !producerJson) {
    problems.push("producer mode: the JSON Schema rejects a document Zod accepts");
  }
  if (!producerZod && producerJson && fixture.expect.crossFieldOnly !== true) {
    problems.push(
      "producer mode: the JSON Schema accepts a document Zod rejects for a non-cross-field reason",
    );
  }

  // Verifier mode: known fields are still checked; unknown additive fields ignored.
  const verifierZod = RpAttestationClaimsVerifierSchema.safeParse(claims).success;
  const schema = loadRootSchema("rp-attestation.schema.json");
  const verifierJson =
    schema === null
      ? false
      : checkAgainstRootSchema(stripUnknownToSchema(claims, schema), "rp-attestation.schema.json").ok;
  if (verifierZod !== verifierExpected) {
    problems.push(`verifier mode (Zod): expected valid=${verifierExpected}, got ${verifierZod}`);
  }
  if (verifierZod && !verifierJson) {
    problems.push("verifier mode: the projected JSON Schema rejects a document Zod accepts");
  }

  const result = await verifyRpAttestation(
    jwt,
    { documentOrigin: fixture.documentOrigin ?? "https://vaporcloud.example", documentAudience: "vaporcloud" },
    verificationOptions(options, false),
  );
  compare(fixture.expect.status, result.status, "status", problems);
  compare(fixture.expect.reason, result.reason, "reason", problems);

  return {
    id: fixture.id,
    passed: problems.length === 0,
    detail:
      problems.length === 0
        ? `${result.status}${result.reason ? ` (${result.reason})` : ""}, producer=${producerZod}, verifier=${verifierZod}`
        : problems.join("; "),
  };
}

async function attestationClaimsFor(fixture: FixtureCase): Promise<unknown> {
  if (fixture.attestation === undefined) {
    return null;
  }
  return claimsOf(await readText(fixture.attestation));
}

async function runReceiptCase(
  fixture: FixtureCase,
  defaults: CaseOptions,
): Promise<CaseOutcome> {
  const problems: string[] = [];
  if (fixture.jwt === undefined) {
    return { id: fixture.id, passed: false, detail: "receipt case has no jwt" };
  }
  const jwt = await readText(fixture.jwt);
  const claims = claimsOf(jwt);
  const modeExpected = fixture.expect.schema === true;
  schemaModes(claims, "signup-receipt.schema.json", modeExpected, modeExpected, problems);

  const attestation = await attestationClaimsFor(fixture);
  const result = verifyReceiptFixture(jwt, attestation, optionClock(asOptions(defaults, fixture.options)));
  compare(fixture.expect.valid, result.valid, "rules.valid", problems);
  compare(fixture.expect.rule, result.rule, "rules.rule", problems);
  return {
    id: fixture.id,
    passed: problems.length === 0,
    detail: problems.length === 0 ? (result.valid ? "pass" : `fails ${String(result.rule)}`) : problems.join("; "),
  };
}

async function runAbuseCase(
  fixture: FixtureCase,
  defaults: CaseOptions,
): Promise<CaseOutcome> {
  const problems: string[] = [];
  if (fixture.jwt === undefined) {
    return { id: fixture.id, passed: false, detail: "abuse case has no jwt" };
  }
  const jwt = await readText(fixture.jwt);
  const claims = claimsOf(jwt);
  schemaModes(
    claims,
    "abuse-report.schema.json",
    fixture.expect.schema === true,
    fixture.expect.verifier === true,
    problems,
  );
  const attestation = await attestationClaimsFor(fixture);
  const result = verifyAbuseFixture(
    jwt,
    attestation,
    A_ISSUER,
    optionClock(asOptions(defaults, fixture.options)),
  );
  compare(fixture.expect.valid, result.valid, "rules.valid", problems);
  compare(fixture.expect.rule, result.rule, "rules.rule", problems);
  return {
    id: fixture.id,
    passed: problems.length === 0,
    detail: problems.length === 0 ? (result.valid ? "pass" : `fails ${String(result.rule)}`) : problems.join("; "),
  };
}

async function runStatusCase(
  fixture: FixtureCase,
  defaults: CaseOptions,
): Promise<CaseOutcome> {
  const problems: string[] = [];
  if (fixture.jwt === undefined) {
    return { id: fixture.id, passed: false, detail: "status case has no jwt" };
  }
  const options = asOptions(defaults, fixture.options);
  const jwt = await readText(fixture.jwt);
  const claims = claimsOf(jwt);
  schemaModes(
    claims,
    "attestation-status.schema.json",
    fixture.expect.schema === true,
    fixture.expect.schema === true,
    problems,
  );
  const zod = AttestationStatusClaimsSchema.safeParse(claims).success;
  const json = checkAgainstRootSchema(claims, "attestation-status.schema.json").ok;
  if (zod !== json) {
    problems.push(`status schema divergence: JSON Schema valid=${json}, Zod valid=${zod}`);
  }
  const expectedSub =
    fixture.expectedSubFrom !== undefined
      ? String(readRecord(claimsOf(await readText(fixture.expectedSubFrom)))?.jti ?? "")
      : String(fixture.expect.sub ?? "");
  const result = await verifyStatusFixture(jwt, {
    expectedSub,
    jwks: options.jwks ?? null,
    issuer: BROKER_ISSUER,
    at: optionClock(options),
    timeoutMs: 5_000,
    maxBytes: 256 * 1024,
  });
  compare(fixture.expect.valid, result.valid, "rules.valid", problems);
  compare(fixture.expect.rule, result.rule, "rules.rule", problems);
  return {
    id: fixture.id,
    passed: problems.length === 0,
    detail: problems.length === 0 ? (result.valid ? "pass" : `fails ${String(result.rule)}`) : problems.join("; "),
  };
}

function isAbsoluteHttps(value: unknown): boolean {
  if (typeof value !== "string") {
    return false;
  }
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

function checkProviderFixture(name: string, value: unknown): string[] {
  const problems: string[] = [];
  const record = readRecord(value);
  if (record === null) {
    return [`${name}: provider fixture must be a JSON object`];
  }
  if (name.endsWith("origin-challenge-https.json")) {
    if (typeof record.challenge_id !== "string" || record.challenge_id.length === 0) {
      problems.push("origin challenge requires challenge_id");
    }
    if (record.method !== "https") {
      problems.push('origin challenge method must be "https"');
    }
    if (!isAbsoluteHttps(record.file_url)) {
      problems.push("origin challenge file_url must be an absolute HTTPS URL");
    }
    if (typeof record.file_content !== "string" || !/^[A-Za-z0-9_-]{32,128}$/.test(record.file_content)) {
      problems.push("origin challenge file_content must match [A-Za-z0-9_-]{32,128}");
    }
    if (typeof record.expires_at !== "string" || !Number.isFinite(Date.parse(record.expires_at))) {
      problems.push("origin challenge expires_at must be an RFC 3339 timestamp");
    }
  } else if (name.endsWith("key-pop-claims.json")) {
    if (typeof record.iss !== "string" || !isAbsoluteHttps(record.iss)) {
      problems.push("PoP iss must be an https origin");
    }
    if (typeof record.aud !== "string" || !isAbsoluteHttps(record.aud)) {
      problems.push("PoP aud must be the broker issuer");
    }
    if (typeof record.sub !== "string" || record.sub.length === 0) {
      problems.push("PoP sub must be the provider UUID");
    }
    if (typeof record.iat !== "number" || typeof record.exp !== "number" || record.exp - record.iat !== 600) {
      problems.push("PoP exp - iat must equal 600");
    }
    if (typeof record.nonce !== "string" || record.nonce.length === 0) {
      problems.push("PoP nonce must be the unconsumed challenge");
    }
    const jwk = readRecord(record.jwk);
    if (jwk === null || jwk.kty !== "OKP" || jwk.crv !== "Ed25519" || typeof jwk.x !== "string") {
      problems.push("PoP jwk must be a public Ed25519 OKP JWK");
    } else if (typeof jwk.kid !== "string" || !KEY_ID_PATTERN.test(jwk.kid)) {
      problems.push("PoP jwk.kid must match the key id grammar");
    }
    if (
      !Array.isArray(record.purposes) ||
      record.purposes.length !== RP_KEY_PURPOSES.length ||
      record.purposes.some((purpose, index) => purpose !== RP_KEY_PURPOSES[index])
    ) {
      problems.push('PoP purposes must be exactly ["receipt","abuse"]');
    }
  } else if (name.endsWith("attestation-issuance.json")) {
    if (typeof record.jti !== "string" || !ATTESTATION_JTI_PATTERN.test(record.jti)) {
      problems.push("issuance jti must match rpa_ + 26 Crockford characters");
    }
    if (typeof record.origin !== "string" || !isAbsoluteHttps(record.origin)) {
      problems.push("issuance origin must be an https origin");
    }
    if (typeof record.audience !== "string" || record.audience.length === 0) {
      problems.push("issuance audience is required");
    }
    if (record.verification_level !== "domain" && record.verification_level !== "entity") {
      problems.push("issuance verification_level must be domain or entity");
    }
    if (typeof record.issued_at !== "string" || typeof record.expires_at !== "string") {
      problems.push("issuance issued_at and expires_at are required");
    } else if (Date.parse(record.expires_at) - Date.parse(record.issued_at) !== 86_400_000) {
      problems.push("issuance expires_at must be exactly 24h after issued_at");
    }
    if (record.renewed_from_jti !== null && (typeof record.renewed_from_jti !== "string" || !ATTESTATION_JTI_PATTERN.test(record.renewed_from_jti))) {
      problems.push("issuance renewed_from_jti must be null or an rpa_ jti");
    }
    if (typeof record.attestation !== "string" || !COMPACT_JWS_PATTERN.test(record.attestation)) {
      problems.push("issuance attestation must be a compact JWS");
    }
    if (typeof record.attestation === "string") {
      const header = (() => {
        const parsed = parseCompactJws(record.attestation);
        return parsed.ok ? parsed.jws.header : null;
      })();
      if (header === null || header.typ !== "agent-rp-attestation+jwt" || header.alg !== "EdDSA") {
        problems.push("issuance attestation header must be EdDSA + agent-rp-attestation+jwt");
      }
    }
  } else {
    problems.push(`${name}: no normative provider check is defined for this fixture`);
  }
  return problems;
}

async function runProviderCase(
  fixture: FixtureCase,
  _defaults: CaseOptions,
): Promise<CaseOutcome> {
  if (fixture.path === undefined) {
    return { id: fixture.id, passed: false, detail: "provider case has no path" };
  }
  const value = await readJson(fixture.path);
  const problems = checkProviderFixture(fixture.path, value);
  compare(fixture.expect.valid, problems.length === 0, "provider rules", problems);
  return {
    id: fixture.id,
    passed: problems.length === 0,
    detail: problems.length === 0 ? "pass" : problems.join("; "),
  };
}

async function runMetadataCase(
  fixture: FixtureCase,
  _defaults: CaseOptions,
): Promise<CaseOutcome> {
  const problems: string[] = [];
  if (fixture.path === undefined) {
    return { id: fixture.id, passed: false, detail: "metadata case has no path" };
  }
  const value = await readJson(fixture.path);
  const schema = checkAgainstRootSchema(value, "broker-metadata.schema.json");
  compare(fixture.expect.schema, schema.ok, "schema.valid", problems);

  // Zod adds the cross-field rule JSON Schema cannot express: `jwks_uri` must be
  // same-origin with `issuer`.
  const zod = BrokerMetadataSchema.safeParse(value).success;
  compare(fixture.expect.zod, zod, "zod.valid", problems);

  // Document validity also requires `issuer` to equal the origin of the document
  // itself (spec §5.4), which only the caller knows.
  const record = readRecord(value);
  const issuerMatches =
    fixture.documentOrigin === undefined ||
    (record !== null && record.issuer === fixture.documentOrigin);
  const documentValid = schema.ok && zod && issuerMatches;
  compare(fixture.expect.valid, documentValid, "document.valid", problems);
  if (fixture.documentOrigin !== undefined) {
    compare(
      fixture.expect.issuerMatchesDocumentOrigin,
      record !== null && record.issuer === fixture.documentOrigin,
      "issuer == document origin",
      problems,
    );
  }
  return {
    id: fixture.id,
    passed: problems.length === 0,
    detail:
      problems.length === 0
        ? documentValid
          ? "valid"
          : "invalid as expected"
        : problems.join("; "),
  };
}

async function runCase(fixture: FixtureCase, defaults: CaseOptions): Promise<CaseOutcome> {
  switch (fixture.kind) {
    case "discovery":
      return runDiscoveryCase(fixture, defaults);
    case "attestation":
      return runAttestationCase(fixture, defaults);
    case "receipt":
      return runReceiptCase(fixture, defaults);
    case "abuse":
      return runAbuseCase(fixture, defaults);
    case "status":
      return runStatusCase(fixture, defaults);
    case "metadata":
      return runMetadataCase(fixture, defaults);
    case "provider":
      return runProviderCase(fixture, defaults);
    default:
      return { id: fixture.id, passed: false, detail: `unknown fixture kind: ${String((fixture as { kind: unknown }).kind)}` };
  }
}

async function main(): Promise<void> {
  const expectedPath = process.argv.slice(2).find((arg) => !arg.startsWith("-")) ?? DEFAULT_EXPECTED;
  const matrix = JSON.parse(await readFile(join(ROOT, expectedPath), "utf8")) as ExpectedMatrix;
  const outcomes: CaseOutcome[] = [];
  for (const fixture of matrix.cases) {
    outcomes.push(await runCase(fixture, matrix.defaults));
  }
  const failed = outcomes.filter((outcome) => !outcome.passed);
  console.log(`Fixture matrix (${expectedPath}) — manual harness, not a test framework`);
  console.log(`Clock: ${matrix.clock}`);
  console.log("");
  for (const outcome of outcomes) {
    console.log(`  [${outcome.passed ? "PASS" : "FAIL"}] ${outcome.id} — ${outcome.detail}`);
  }
  console.log("");
  console.log(`Summary: ${outcomes.length - failed.length} passed, ${failed.length} failed`);
  if (failed.length > 0) {
    process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  console.error("Fixture harness crashed:", error instanceof Error ? error.stack ?? error.message : error);
  process.exitCode = 1;
});
