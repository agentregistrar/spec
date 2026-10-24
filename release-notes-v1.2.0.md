# Release Notes — `agent-identity-v1` `v1.2.0`

- **Protocol identifier:** `agent-identity-v1` (unchanged)
- **Specification version:** `v1.2.0`
- **Release date:** 2026-10-24 (target; this branch is the reviewed artifact — see §6)
- **Normative specification:** [`agent-identity-v1.md`](./agent-identity-v1.md)
- **Change process:** [`release-notes-v1.0.0.md`](./release-notes-v1.0.0.md) §3
- **Previous release:** [`release-notes-v1.1.0.md`](./release-notes-v1.1.0.md)

`v1.2.0` is the **two-sided trust** release: it gives relying parties a portable, broker-issued
identity, lets agents verify that identity locally before signup, and makes receipts and abuse
reports authenticated. It adds two new contracts (G, H) and a metadata/status surface (I), updates
Contracts D.1, D.2, E, and F, and defines the trust model, assurance levels, verification rules, and
status/error taxonomy.

The wire protocol id stays `agent-identity-v1`. `rp_attestation` is **OPTIONAL**: a `v1.0.0` or
`v1.1.0` discovery document remains conformant and is simply **unverified**.

---

## 1. What `v1.2.0` adds

| Contract | Change | Where |
| :--- | :--- | :--- |
| **G — RP attestation** | New broker-signed JWT (`typ: agent-rp-attestation+jwt`) binding the RP's canonical origin, audience, provider identity, assurance level, and public keys. Published as the optional `rp_attestation` field. `exp - iat = 86400`, `aud: agent-identity-v1`, `keys[].purposes` exactly `["receipt","abuse"]`. | §14 |
| **H — Provider registration and status API** | Administrative provider API: account, origins, HTTPS/DNS challenges, key proof of possession (`agent-rp-key-pop+jwt`), key retire/revoke, attestation issue/renew, API keys. Never agent-facing; no public JSON Schema. | §15 |
| **I — Broker metadata and status** | `/.well-known/agent-broker.json` with `issuer`, `jwks_uri`, `attestation_status_uri`, `abuse_endpoint`, `protocol_versions`, `contact`; and a signed `agent-rp-attestation-status+jwt` response with a 300-second window and a 5-minute cache bound. | §16 |
| **D.1 — Discovery** | Optional `rp_attestation` (compact JWS, ≤16384 characters). `rp.origin` binds to the fetched document origin; `rp.audience` binds to `audience`. Absence is conformant and unverified. | §5.2, §5.4 |
| **D.2 — Abuse reporting** | RP report JWS (`agent-rp-abuse+jwt`, 300-second window) plus the RP attestation. Trusted-broker check before JWKS. Unknown/untrusted/unlinked reports are `unverified` cases; only a verified, receipt-linked report can request protective suspension. Unauthenticated legacy posts get `401 unauthenticated_report`. | §11.5 |
| **E — Signup receipt** | RP-signed, **no `exp`**. Adds `service.origin`, `service.attestation_jti`, `service.key_id`; `header.kid` must equal `service.key_id`; valid when `iat`/`signed_up_at` fall inside the named attestation's window. A legacy `exp` is ignored. | §11.1, §11.4 |
| **F — Receipt ingestion** | `{signup_token, rp_attestation}`, both required. Verifies the **exact** attestation named by `service.attestation_jti` in historical mode; never substitutes the current one. Preserves the existing response fields and adds `proof_source: "rp_callback"` and `deduplicated`. | §11.6 |
| **Trust model and policy** | Permissionless assertion verification; local attestation verification; trust is policy, not cryptography and not transitive. Assurance levels `domain` and `entity`. Normative resolution order and the `allow`/`warn`/`require`/`block` matrix. `require` rejects `agent_supplied_discovery`. | §17 |
| **Status and error taxonomy** | Frozen `RpVerificationStatus`, `RpPolicy`, `RpVerificationSource`, `AssuranceLevel`, `AttestationStatusValue`, and `ProofSource`. OAuth-style `{error, error_description, code}` on new routes. | §18 |
| **Verification rules** | Conformance and attestation verification are separate; conformance never calls Broker B. Exit `0`/`1`/`2`. Trust before fetch, per-issuer JWKS, historical vs current comparisons, SSRF bounds, algorithm/key-confusion rules, fail-closed gates. | §19 |
| **Registry** | Optional per-entry `verification` snapshot (`broker`, `level`, `attestation_jti`, `checked_at`, `status`). Conformance and verification stay separate; only `active` earns a badge. | `registry/README.md` |

## 2. Compatibility

- **Discovery documents:** `v1.0.0` and `v1.1.0` documents remain conformant. `rp_attestation` is
  OPTIONAL; absence means **unverified**, never invalid.
- **Assertion verification:** unchanged and still permissionless. No account, SDK, shared secret, or
  broker call is required to verify a Contract A assertion.
- **Receipts:** pre-v1.2 broker-signed receipts are historical artifacts and are recorded as
  `legacy_broker_signed`, not verified. A new verified proof requires an RP key bound to an
  attestation.
- **Contract F:** now requires `rp_attestation`. There is no broker-key fallback and no legacy path
  for a new verified proof.
- **Contract D.2:** unauthenticated posts are rejected with
  `401 {"error":"unauthorized","code":"unauthenticated_report"}`.
- **Validator:** `valid` is still the run result (`valid === (exitCode === 0)`). The new
  `conformance` and `attestation` objects are additive; `validatorVersion` is now `"1.2.0"`.
  `conformance.evaluated` distinguishes "not evaluated" (exit `2`, no document) from "invalid";
  unparseable JSON is a conformance error (exit `1`), and a malformed `rp_attestation` field is
  conformance-only (`attestation.status: not_checked`), never `invalid`.
- **Package:** `@agentregistrar/discovery` `1.2.0` exports the new schemas and parsers. No existing
  export was removed or renamed. There is still no `bin` entry.
- **Dependencies:** no new runtime dependency. JWS/Ed25519 verification uses Node's built-in
  `node:crypto`. No test framework was added.

## 3. Section renumbering

To keep every existing anchor stable, the new contracts were inserted after §13 and the former
sections moved down:

| Old | New |
| :--- | :--- |
| §14 Security Considerations | §20 |
| §15 Conformance Checklist & Minimal Conformant Example | §21 |
| §16 Open Questions | §22 |
| §17 Relationship to Other Contracts | §23 |

Contracts D.2 and F are **not** new top-level sections: they live beside Contract E in §11 as §11.5
and §11.6, so their existing references keep working.

## 4. New and changed artifacts

| Path | Action |
| :--- | :--- |
| `agent-identity-v1.md` | `v1.2.0` text: §1.1–§1.3, §2.1, §5.2, §5.4, §11; new §14–§19; §20–§23. |
| `agent-signup.schema.json` | Optional `rp_attestation`. |
| `rp-attestation.schema.json` | New (Contract G, producer mode). |
| `broker-metadata.schema.json` | New (Contract I). |
| `attestation-status.schema.json` | New (Contract I status JWS claims). |
| `signup-receipt.schema.json` | New (Contract E v1.2). |
| `abuse-report.schema.json` | New (Contract D.2). |
| `src/schema.ts`, `src/index.ts` | Zod for discovery, attestation, metadata, status; producer/verifier parsers for the attestation and the status JWS. |
| `src/validate-attestation.ts` | Contract G verifier (validator-internal; not exported from `src/index.ts`). |
| `src/validate-discovery.ts` | Five new flags, conformance/attestation split, exit mapping, output. |
| `src/validate-fixtures.ts`, `src/dev/sign-fixtures.ts`, `src/verify-artifacts.ts` | Manual fixture harness and deterministic fixture signer. |
| `src/validate-registry.ts` | Registry validator. |
| `fixtures/**` | Attestation/receipt/status/abuse/provider fixtures, per-issuer JWKS, frozen seed, `expected.json`, `README.md`. |
| `registry/implementations.schema.json` | New registry schema; entries unchanged. |
| `scope-boundaries.md`, `implementing-agent-identity-v1.md`, `validator.md`, `README.md` | v1.2.0 guidance. |
| `package.json` | `1.2.0`, schema files/exports, `validate:fixtures`, `validate:registry`, `sign:fixtures`. |

## 5. Validation evidence

Run on **2026-10-24** from a clean clone of this repository on Node `v24.21.0` and pnpm `9.15.4`,
with the frozen fixture clock `2026-10-24T00:00:00Z` and arena-only fixture keys. `jq` was not
installed in the verification environment, so the JSON projections below were produced with a
one-line Node equivalent of the documented `jq` pipelines; the validator output and exit codes are
unchanged.

```bash
pnpm install && pnpm typecheck                     # → 0 (tsc --noEmit)
V="pnpm --silent validate:discovery"
A="--verify-attestation --jwks fixtures/keys/fixture-jwks-broker-1.json --trusted-rp-broker https://rp-broker.example"
```

| Check | Command | Result |
| :--- | :--- | :--- |
| v1.0/v1.1 conformance unchanged | `$V fixtures/valid-minimal.json --json` | `valid true`, `exitCode 0`, `conformance.valid true`, `attestation.status "unverified"` |
| Valid attestation, offline | `$V fixtures/valid-attested-domain.json $A --require-attestation --at 2026-10-24T00:00:00Z --json` | `valid true`, `exitCode 0`, `verified`, level `domain` |
| Entity level | `$V fixtures/valid-attested-entity.json $A --require-attestation --at 2026-10-24T00:00:00Z --json` | `verified`, level `entity` |
| Expired (warning) | `$V fixtures/valid-attestation-expired.json $A --at 2026-11-30T00:00:00Z --json` | `valid true`, `exitCode 0`, `expired` |
| Expired (gate) | same `+ --require-attestation` | exit `1` |
| Malformed field | `$V fixtures/invalid-attestation-malformed.json --json` | exit `1`, `conformance.valid false`, `attestation.status "not_checked"`, no network |
| Unparseable JSON | `$V fixtures/invalid-json-body.json --json` | exit `1`, `conformance.valid false`, `conformance.evaluated true`, `fetchFailure null` |
| No document | `$V fixtures/does-not-exist.json --json` | exit `2`, `conformance.valid null`, `conformance.evaluated false`, `fetchFailure` set, `DOCUMENT: NOT CHECKED` |
| Absent attestation warning | `$V fixtures/valid-minimal.json --verify-attestation --json` | exit `0`, `unverified`, warning "rp_attestation is absent" |
| Wrong purposes tuple | `pnpm --silent validate:fixtures` row `attestations/wrong-purposes` | rejected by both `rp-attestation.schema.json` and strict Zod (`claims_invalid`) |
| Untrusted broker | `$V fixtures/valid-attested-domain.json --verify-attestation --jwks … --at … --json` (no trust flag) | `attested_untrusted_broker` |
| Untrusted broker (gate) | same `+ --require-attestation` | exit `1` |
| Broker unavailable (gate) | `$V fixtures/valid-attested-unavailable.json --require-attestation --trusted-rp-broker https://rp-broker.example --jwks fixtures/keys/missing.json --json` | exit `2` |
| Broker unavailable (network) | `$V … --require-attestation --trusted-rp-broker https://rp-broker.example --timeout 1` | exit `2`, `unavailable` |
| Fixture reproducibility | `pnpm sign:fixtures && git diff --exit-code fixtures/` | byte-identical, exit `0` |
| Fixture matrix | `pnpm --silent validate:fixtures fixtures/expected.json` | `56 passed, 0 failed` |
| Registry valid | `pnpm --silent validate:registry registry/implementations.json --json` | `{"valid":true,"exitCode":0,"errors":[],"warnings":[]}` |
| Registry violation | deliberate `level:"enhanced"` + `attestation_jti:"rpa_x"` | exit `1`, two schema errors plus a semantic error |
| Packaging | `npm pack --dry-run --json` | tarball contains all six root schemas, `registry/implementations.schema.json`, and `src/` |

The fixture matrix covers the §5.13 rows: discovery with/without an attestation, malformed and
oversize fields, unparseable JSON, an absent/missing document, expired/invalid/untrusted/unavailable
attestations, every listed attestation negative (including a reordered `purposes` tuple),
`unknown-additive-claim` in both producer and verifier mode, receipts including a legacy `exp` and a
rotated key, abuse reports, status responses (including an additive status claim), broker metadata,
and provider request/response examples.

## 6. Release mechanics

Per the repository `AGENTS.md`, the source-first package is published with **npm trusted publishing
(OIDC)** — never a local `npm publish` and never an npm token. Nothing in this branch claims that the
tag, npm publication, or GitHub release has already happened; this branch is the reviewed artifact and
`npm dist-tags.latest` remains `1.1.0` until step 3 completes:

1. merge the release PR to `main`;
2. tag the merge commit `v1.2.0` and push the tag;
3. dispatch `.github/workflows/publish.yml` from `main` (environment `npm-publish`, `id-token:
   write`);
4. verify `npm view @agentregistrar/discovery@1.2.0 version dist.integrity` and the provenance
   attestation;
5. create the GitHub release from this file with `--verify-tag`.

The tag and publish run are recorded in the GitHub release and the workflow log when the release is
dispatched; this branch is the reviewed artifact, not the publication.

## 7. Change process and scope

`v1.2.0` was reviewed against [`scope-boundaries.md`](./scope-boundaries.md) §6–§7. Every change is
identity-, delegation-, ToS-, traceability-, revocation-, or reachability-related:

- the attestation binds identity and keys only — no terms hash, scopes, endpoints, prices, or
  `provider_url`;
- no provider catalog, SKU, provisioning API, resource inventory, or credential custody entered the
  protocol, discovery, the receipt, or the registry;
- a provider account remains the RP's private relationship with its broker and is never an
  agent-facing discovery field;
- assertion verification remains permissionless; only the RP's own registration/issuance path needs an
  account.

A breaking change still requires a new `protocol` value and a new discovery path (§13).

## 8. Related artifacts

- Normative spec: [`agent-identity-v1.md`](./agent-identity-v1.md)
- Scope rulebook: [`scope-boundaries.md`](./scope-boundaries.md)
- Implementation guide: [`implementing-agent-identity-v1.md`](./implementing-agent-identity-v1.md)
- Validator guide: [`validator.md`](./validator.md)
- Fixture matrix: [`fixtures/README.md`](./fixtures/README.md)
- Registry: [`registry/README.md`](./registry/README.md),
  [`registry/implementations.json`](./registry/implementations.json)
- Previous release: [`release-notes-v1.1.0.md`](./release-notes-v1.1.0.md)
