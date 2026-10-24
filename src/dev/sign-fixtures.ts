/**
 * Fixture signing harness (`pnpm sign:fixtures`) — a developer script, not a
 * test suite.
 *
 * It regenerates every checked-in JWS fixture from:
 *
 * - the hardcoded Ed25519 **test seeds** in `fixtures/keys/fixture-seed.json`
 *   (a warning-marked test vector, never a credential), and
 * - the claim templates below, with a frozen clock.
 *
 * Ed25519 is deterministic (RFC 8032), so a fixed seed + fixed claims + fixed
 * `iat` produce byte-identical JWS. After running this script,
 * `git diff --exit-code fixtures/` MUST be clean.
 *
 * It also refreshes `rp_attestation` inside the discovery fixtures that declare
 * a `__fixture_attestation_source`, so the published field and the standalone
 * attestation fixture can never drift.
 */
import { createHash, createPrivateKey, createPublicKey, sign } from "node:crypto";
import type { KeyObject, JsonWebKey as NodeJsonWebKey } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const FIXTURES = join(ROOT, "fixtures");

/** 2026-10-24T00:00:00.000Z — the frozen fixture clock. */
const FIXTURE_IAT = 1_792_800_000;
const DAY = 86_400;
const CROCKFORD = "0123456789abcdefghjkmnpqrstvwxyz";

const BROKER_1_ISSUER = "https://rp-broker.example";
const BROKER_2_ISSUER = "https://other-broker.example";
const RP_ORIGIN = "https://vaporcloud.example";
const A_ISSUER = "https://agentregistrar.dev";
const PROVIDER_ID = "0f3d2c1b-4a59-4e6f-8a7b-2c1d0e9f8a7b";
const AGENT_ID = "agt_01j8z9x4m2n7p5q3r6s8t0vwxy";
const ASSERTION_JTI = "jti_01j8z9x4m2n7p5q3r6s8t0vwxy";
const HUMAN_ID = "550e8400-e29b-41d4-a716-446655440000";

interface SeedEntry {
  kid: string;
  d: string;
  x: string;
}

interface Seeds {
  comment: string;
  algorithm: string;
  keys: Record<string, SeedEntry>;
}

type Json = Record<string, unknown>;

function base64url(value: string | Buffer): string {
  return Buffer.from(value).toString("base64url");
}

function digest(label: string): Buffer {
  return createHash("sha256").update(`agent-identity-fixture:${label}`, "utf8").digest();
}

/** Deterministic 26-character lowercase Crockford base32 id from a label. */
function ulid(label: string): string {
  const hash = digest(`ulid:${label}`);
  let out = "";
  for (let index = 0; index < 26; index += 1) {
    out += CROCKFORD[hash[index] % 32];
  }
  return out;
}

/** Deterministic UUID-shaped id from a label. */
function uuid(label: string): string {
  const hash = digest(`uuid:${label}`).subarray(0, 16);
  const bytes = Buffer.from(hash);
  bytes[6] = (bytes[6] & 0x0f) | 0x40; // version 4
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // variant 10
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const attestationJti = (label: string): string => `rpa_${ulid(`attestation:${label}`)}`;
const receiptJti = (label: string): string => `srp_${ulid(`receipt:${label}`)}`;
const abuseJti = (label: string): string => `abr_${ulid(`abuse:${label}`)}`;

const ATTESTATION_JTI = {
  domain: attestationJti("valid-domain"),
  entity: attestationJti("valid-entity"),
  rotated: attestationJti("valid-domain-rotated"),
  expired: attestationJti("expired"),
  untrusted: attestationJti("untrusted-broker"),
  additive: attestationJti("unknown-additive-claim"),
  badSignature: attestationJti("bad-signature"),
  wrongOrigin: attestationJti("wrong-origin"),
  wrongAudience: attestationJti("wrong-audience"),
  wrongTyp: attestationJti("wrong-typ"),
  unknownKid: attestationJti("unknown-kid"),
  duplicateKid: attestationJti("duplicate-kid"),
  missingExp: attestationJti("missing-exp"),
} as const;

const RECEIPT_JTI = {
  valid: receiptJti("valid"),
  legacyExp: receiptJti("legacy-exp"),
  rotated: receiptJti("rotated-key"),
  badKey: receiptJti("bad-key"),
  wrongOrigin: receiptJti("wrong-origin"),
  outsideWindow: receiptJti("outside-window"),
  missingKeyId: receiptJti("missing-key-id"),
} as const;

const ABUSE_JTI = {
  valid: abuseJti("valid"),
  expired: abuseJti("expired"),
  wrongAud: abuseJti("wrong-aud"),
  additive: abuseJti("unknown-additive-claim"),
} as const;

function privateKeyFor(seed: SeedEntry): KeyObject {
  return createPrivateKey({
    key: { kty: "OKP", crv: "Ed25519", d: seed.d, x: seed.x } as NodeJsonWebKey,
    format: "jwk",
  });
}

function publicJwk(seed: SeedEntry): Json {
  const jwk = createPublicKey(privateKeyFor(seed)).export({ format: "jwk" }) as Json;
  return { kid: seed.kid, kty: jwk.kty, crv: jwk.crv, x: jwk.x, alg: "EdDSA", use: "sig" };
}

function signJws(header: Json, claims: Json, seed: SeedEntry): string {
  const encodedHeader = base64url(JSON.stringify(header));
  const encodedClaims = base64url(JSON.stringify(claims));
  const signingInput = `${encodedHeader}.${encodedClaims}`;
  const signature = sign(null, Buffer.from(signingInput, "utf8"), privateKeyFor(seed));
  return `${signingInput}.${base64url(signature)}`;
}

function attestationHeader(seed: SeedEntry, typ = "agent-rp-attestation+jwt"): Json {
  return { alg: "EdDSA", typ, kid: seed.kid };
}

function rpKey(seed: SeedEntry): Json {
  return {
    kid: seed.kid,
    kty: "OKP",
    crv: "Ed25519",
    x: seed.x,
    alg: "EdDSA",
    purposes: ["receipt", "abuse"],
  };
}

function rpBlock(overrides: Json = {}): Json {
  return {
    id: PROVIDER_ID,
    origin: RP_ORIGIN,
    audience: "vaporcloud",
    name: "VaporCloud",
    legal_name: "VaporCloud Inc.",
    contact: { email: "security@vaporcloud.example", name: "VaporCloud Security" },
    verification: {
      level: "domain",
      method: "https",
      origin_verified_at: "2026-10-23T00:00:00.000Z",
      entity_reviewed_at: null,
    },
    ...overrides,
  };
}

function attestationClaims(options: {
  jti: string;
  iat?: number;
  iss?: string;
  rp?: Json;
  keys: Json[];
  extra?: Json;
}): Json {
  const iat = options.iat ?? FIXTURE_IAT;
  return {
    iss: options.iss ?? BROKER_1_ISSUER,
    sub: PROVIDER_ID,
    aud: "agent-identity-v1",
    jti: options.jti,
    iat,
    exp: iat + DAY,
    rp: options.rp ?? rpBlock(),
    keys: options.keys,
    ...(options.extra ?? {}),
  };
}

const TOS_SHA256 = "sha256:6357f96f625964c2eea9d04e24edfc5098bd9aae3623f5d96e0a441df0025967";
const GUIDE_SHA256 = "sha256:1f2e3d4c5b6a79880a1b2c3d4e5f60718293a4b5c6d7e8f9012345678abcdef0";

function receiptClaims(options: {
  jti: string;
  attestationJti: string;
  keyId: string;
  iat?: number;
  iss?: string;
  origin?: string;
  exp?: number;
  omitKeyId?: boolean;
}): Json {
  const iat = options.iat ?? FIXTURE_IAT;
  const service: Json = {
    audience: "vaporcloud",
    origin: options.origin ?? RP_ORIGIN,
    provider_name: "VaporCloud",
    provider_url: RP_ORIGIN,
    account_id: "acct_01j8z9x4m2n7p5q3r6s8t0vwxy",
    attestation_jti: options.attestationJti,
  };
  if (!options.omitKeyId) {
    service.key_id = options.keyId;
  }
  return {
    iss: options.iss ?? options.origin ?? RP_ORIGIN,
    aud: A_ISSUER,
    sub: AGENT_ID,
    jti: options.jti,
    iat,
    signed_up_at: iat,
    assertion_jti: ASSERTION_JTI,
    ...(options.exp !== undefined ? { exp: options.exp } : {}),
    service,
    agent: {
      id: AGENT_ID,
      name: "opencode-macbook",
      email: "agt-01j@agents.agentregistrar.dev",
    },
    human: {
      id: HUMAN_ID,
      name: "Alexey",
      email: "alexey@example.com",
      verified: true,
    },
    tos: {
      version: "2026.1",
      url: "https://vaporcloud.example/terms",
      sha256: TOS_SHA256,
      master_tos_version: "2026-10-01",
    },
    context: {
      url: "https://vaporcloud.example/docs/SKILL.md",
      sha256: GUIDE_SHA256,
    },
  };
}

function abuseClaims(options: {
  jti: string;
  iat?: number;
  aud?: string;
  extra?: Json;
}): Json {
  const iat = options.iat ?? FIXTURE_IAT;
  return {
    iss: RP_ORIGIN,
    aud: options.aud ?? A_ISSUER,
    jti: options.jti,
    iat,
    exp: iat + 300,
    agent_id: AGENT_ID,
    reason: "Cryptomining on a provisioned instance",
    evidence: {
      assertion_jti: ASSERTION_JTI,
      signup_token_jti: RECEIPT_JTI.valid,
    },
    ...(options.extra ?? {}),
  };
}

function statusClaims(options: {
  jti: string;
  sub: string;
  status: string;
  iat?: number;
  changedAt?: string;
}): Json {
  const iat = options.iat ?? FIXTURE_IAT;
  return {
    iss: BROKER_1_ISSUER,
    aud: "agent-identity-v1",
    jti: options.jti,
    sub: options.sub,
    iat,
    exp: iat + 300,
    status: options.status,
    status_changed_at: options.changedAt ?? "2026-10-23T00:00:00.000Z",
  };
}

function statusHeader(seed: SeedEntry): Json {
  return { alg: "EdDSA", typ: "agent-rp-attestation-status+jwt", kid: seed.kid };
}

function receiptHeader(seed: SeedEntry, typ = "agent-signup-receipt+jwt"): Json {
  return { alg: "EdDSA", typ, kid: seed.kid };
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function writeText(path: string, value: string): Promise<void> {
  await writeFile(path, `${value}\n`, "utf8");
}

async function main(): Promise<void> {
  const seeds = JSON.parse(
    await readFile(join(FIXTURES, "keys", "fixture-seed.json"), "utf8"),
  ) as Seeds;
  const broker1 = seeds.keys["broker-1"];
  const broker2 = seeds.keys["broker-2"];
  const rp1 = seeds.keys["rp-key-1"];
  const rp2 = seeds.keys["rp-key-2"];
  const rogue = seeds.keys["rogue-key"];
  for (const [name, seed] of Object.entries({ broker1, broker2, rp1, rp2, rogue })) {
    if (seed === undefined) {
      throw new Error(`fixture-seed.json is missing the ${name} key`);
    }
  }

  await writeJson(join(FIXTURES, "keys", "fixture-jwks-broker-1.json"), {
    issuer: BROKER_1_ISSUER,
    comment: "TEST VECTOR ONLY — public JWKS for fixture attestations; never a production broker.",
    keys: [publicJwk(broker1)],
  });
  await writeJson(join(FIXTURES, "keys", "fixture-jwks-broker-2.json"), {
    issuer: BROKER_2_ISSUER,
    comment: "TEST VECTOR ONLY — public JWKS for the untrusted-broker fixture; never a production broker.",
    keys: [publicJwk(broker2)],
  });

  const attestations = join(FIXTURES, "attestations");
  const receipts = join(FIXTURES, "receipts");
  const statusDir = join(FIXTURES, "status");
  const abuseDir = join(FIXTURES, "abuse");

  const domainClaims = attestationClaims({
    jti: ATTESTATION_JTI.domain,
    keys: [rpKey(rp1)],
  });
  const entityClaims = attestationClaims({
    jti: ATTESTATION_JTI.entity,
    rp: rpBlock({
      verification: {
        level: "entity",
        method: "https",
        origin_verified_at: "2026-10-23T00:00:00.000Z",
        entity_reviewed_at: "2026-10-24T00:00:00.000Z",
      },
    }),
    keys: [rpKey(rp1)],
  });
  const rotatedClaims = attestationClaims({
    jti: ATTESTATION_JTI.rotated,
    keys: [rpKey(rp1), rpKey(rp2)],
  });
  const expiredClaims = attestationClaims({
    jti: ATTESTATION_JTI.expired,
    iat: FIXTURE_IAT - 45 * DAY,
    keys: [rpKey(rp1)],
  });
  const untrustedClaims = attestationClaims({
    jti: ATTESTATION_JTI.untrusted,
    iss: BROKER_2_ISSUER,
    keys: [rpKey(rp1)],
  });
  const additiveClaims = attestationClaims({
    jti: ATTESTATION_JTI.additive,
    keys: [rpKey(rp1)],
    extra: { future_claim: { note: "added by a later additive minor revision" } },
  });
  const badSignatureClaims = attestationClaims({
    jti: ATTESTATION_JTI.badSignature,
    keys: [rpKey(rp1)],
  });
  const wrongOriginClaims = attestationClaims({
    jti: ATTESTATION_JTI.wrongOrigin,
    rp: rpBlock({ origin: "https://evil.example" }),
    keys: [rpKey(rp1)],
  });
  const wrongAudienceClaims = attestationClaims({
    jti: ATTESTATION_JTI.wrongAudience,
    rp: rpBlock({ audience: "another-service" }),
    keys: [rpKey(rp1)],
  });
  const wrongTypClaims = attestationClaims({
    jti: ATTESTATION_JTI.wrongTyp,
    keys: [rpKey(rp1)],
  });
  const unknownKidClaims = attestationClaims({
    jti: ATTESTATION_JTI.unknownKid,
    keys: [rpKey(rp1)],
  });
  const duplicateKidClaims = attestationClaims({
    jti: ATTESTATION_JTI.duplicateKid,
    keys: [rpKey(rp1), rpKey({ ...rp2, kid: rp1.kid })],
  });
  const missingExpClaims: Json = (() => {
    const claims = attestationClaims({
      jti: ATTESTATION_JTI.missingExp,
      keys: [rpKey(rp1)],
    });
    delete claims.exp;
    return claims;
  })();

  const attestationFiles: [string, string][] = [
    ["valid-domain.jwt", signJws(attestationHeader(broker1), domainClaims, broker1)],
    ["valid-entity.jwt", signJws(attestationHeader(broker1), entityClaims, broker1)],
    ["valid-domain-rotated.jwt", signJws(attestationHeader(broker1), rotatedClaims, broker1)],
    ["expired.jwt", signJws(attestationHeader(broker1), expiredClaims, broker1)],
    [
      "untrusted-broker.jwt",
      signJws(
        { alg: "EdDSA", typ: "agent-rp-attestation+jwt", kid: broker2.kid },
        untrustedClaims,
        broker2,
      ),
    ],
    ["unknown-additive-claim.jwt", signJws(attestationHeader(broker1), additiveClaims, broker1)],
    // Signed by broker-2 while naming broker-1's kid: the pinned broker-1 JWKS
    // selects a key that cannot verify this signature.
    ["bad-signature.jwt", signJws(attestationHeader(broker1), badSignatureClaims, broker2)],
    ["wrong-origin.jwt", signJws(attestationHeader(broker1), wrongOriginClaims, broker1)],
    ["wrong-audience.jwt", signJws(attestationHeader(broker1), wrongAudienceClaims, broker1)],
    [
      "wrong-typ.jwt",
      signJws(attestationHeader(broker1, "agent-id+jwt"), wrongTypClaims, broker1),
    ],
    [
      "unknown-kid.jwt",
      signJws({ alg: "EdDSA", typ: "agent-rp-attestation+jwt", kid: "broker-unknown-key" }, unknownKidClaims, broker1),
    ],
    ["duplicate-kid.jwt", signJws(attestationHeader(broker1), duplicateKidClaims, broker1)],
    ["missing-exp.jwt", signJws(attestationHeader(broker1), missingExpClaims, broker1)],
  ];
  for (const [name, jws] of attestationFiles) {
    await writeText(join(attestations, name), jws);
  }

  const receiptFiles: [string, string][] = [
    [
      "valid-receipt.jwt",
      signJws(
        receiptHeader(rp1),
        receiptClaims({
          jti: RECEIPT_JTI.valid,
          attestationJti: ATTESTATION_JTI.domain,
          keyId: rp1.kid,
        }),
        rp1,
      ),
    ],
    [
      "valid-receipt-legacy-exp.jwt",
      signJws(
        receiptHeader(rp1),
        receiptClaims({
          jti: RECEIPT_JTI.legacyExp,
          attestationJti: ATTESTATION_JTI.domain,
          keyId: rp1.kid,
          exp: FIXTURE_IAT - DAY,
        }),
        rp1,
      ),
    ],
    [
      "valid-receipt-rotated-key.jwt",
      signJws(
        receiptHeader(rp2),
        receiptClaims({
          jti: RECEIPT_JTI.rotated,
          attestationJti: ATTESTATION_JTI.rotated,
          keyId: rp2.kid,
        }),
        rp2,
      ),
    ],
    [
      "invalid-receipt-bad-key.jwt",
      signJws(
        receiptHeader(rogue),
        receiptClaims({
          jti: RECEIPT_JTI.badKey,
          attestationJti: ATTESTATION_JTI.domain,
          keyId: rogue.kid,
        }),
        rogue,
      ),
    ],
    [
      "wrong-origin.jwt",
      signJws(
        receiptHeader(rp1),
        receiptClaims({
          jti: RECEIPT_JTI.wrongOrigin,
          attestationJti: ATTESTATION_JTI.domain,
          keyId: rp1.kid,
          iss: "https://other.example",
          origin: "https://other.example",
        }),
        rp1,
      ),
    ],
    [
      "outside-window.jwt",
      signJws(
        receiptHeader(rp1),
        receiptClaims({
          jti: RECEIPT_JTI.outsideWindow,
          attestationJti: ATTESTATION_JTI.domain,
          keyId: rp1.kid,
          iat: FIXTURE_IAT + 2 * DAY,
        }),
        rp1,
      ),
    ],
    [
      "missing-key-id.jwt",
      signJws(
        receiptHeader(rp1),
        receiptClaims({
          jti: RECEIPT_JTI.missingKeyId,
          attestationJti: ATTESTATION_JTI.domain,
          keyId: rp1.kid,
          omitKeyId: true,
        }),
        rp1,
      ),
    ],
  ];
  for (const [name, jws] of receiptFiles) {
    await writeText(join(receipts, name), jws);
  }

  const statusFiles: [string, string][] = [
    [
      "status-active.jwt",
      signJws(
        statusHeader(broker1),
        statusClaims({ jti: uuid("status:active"), sub: ATTESTATION_JTI.domain, status: "active" }),
        broker1,
      ),
    ],
    [
      "status-suspended.jwt",
      signJws(
        statusHeader(broker1),
        statusClaims({
          jti: uuid("status:suspended"),
          sub: ATTESTATION_JTI.domain,
          status: "suspended",
        }),
        broker1,
      ),
    ],
    [
      "status-revoked.jwt",
      signJws(
        statusHeader(broker1),
        statusClaims({ jti: uuid("status:revoked"), sub: ATTESTATION_JTI.domain, status: "revoked" }),
        broker1,
      ),
    ],
    [
      "status-wrong-sub.jwt",
      signJws(
        statusHeader(broker1),
        statusClaims({ jti: uuid("status:wrong-sub"), sub: ATTESTATION_JTI.entity, status: "active" }),
        broker1,
      ),
    ],
    [
      "status-bad-signature.jwt",
      signJws(
        statusHeader(broker1),
        statusClaims({ jti: uuid("status:bad-signature"), sub: ATTESTATION_JTI.domain, status: "active" }),
        broker2,
      ),
    ],
  ];
  for (const [name, jws] of statusFiles) {
    await writeText(join(statusDir, name), jws);
  }

  const abuseFiles: [string, string][] = [
    [
      "valid-abuse-report.jwt",
      signJws(receiptHeader(rp1, "agent-rp-abuse+jwt"), abuseClaims({ jti: ABUSE_JTI.valid }), rp1),
    ],
    [
      "invalid-abuse-expired.jwt",
      signJws(
        receiptHeader(rp1, "agent-rp-abuse+jwt"),
        abuseClaims({ jti: ABUSE_JTI.expired, iat: FIXTURE_IAT - 3600 }),
        rp1,
      ),
    ],
    [
      "wrong-aud.jwt",
      signJws(
        receiptHeader(rp1, "agent-rp-abuse+jwt"),
        abuseClaims({ jti: ABUSE_JTI.wrongAud, aud: "https://other.example" }),
        rp1,
      ),
    ],
    [
      "unknown-additive-claim.jwt",
      signJws(
        receiptHeader(rp1, "agent-rp-abuse+jwt"),
        abuseClaims({
          jti: ABUSE_JTI.additive,
          extra: { future_hint: { schema_revision: 3 } },
        }),
        rp1,
      ),
    ],
  ];
  for (const [name, jws] of abuseFiles) {
    await writeText(join(abuseDir, name), jws);
  }

  // Refresh the discovery `rp_attestation` field from the standalone fixture so
  // the two can never drift. Only documents that declare a source are touched.
  const topLevel = await readdir(FIXTURES);
  let refreshed = 0;
  for (const name of topLevel) {
    if (!name.endsWith(".json")) {
      continue;
    }
    const path = join(FIXTURES, name);
    const document = JSON.parse(await readFile(path, "utf8")) as Json;
    const source = document.__fixture_attestation_source;
    if (typeof source !== "string") {
      continue;
    }
    const jws = (await readFile(join(FIXTURES, source), "utf8")).trim();
    document.rp_attestation = jws;
    await writeJson(path, document);
    refreshed += 1;
  }

  console.log(
    [
      "Fixture signing complete (test vectors only; frozen clock 2026-10-24T00:00:00Z).",
      `  attestations: ${attestationFiles.length}`,
      `  receipts:     ${receiptFiles.length}`,
      `  status:       ${statusFiles.length}`,
      `  abuse:        ${abuseFiles.length}`,
      `  discovery documents refreshed from __fixture_attestation_source: ${refreshed}`,
      "  next: git diff --exit-code fixtures/",
    ].join("\n"),
  );
}

main().catch((error: unknown) => {
  console.error("Fixture signing failed:", error instanceof Error ? error.stack ?? error.message : error);
  process.exitCode = 1;
});
