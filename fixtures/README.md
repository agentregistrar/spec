# Fixtures — `agent-identity-v1` `v1.3.0`

This directory holds every checked-in fixture for the discovery, attestation, receipt, abuse, status,
and provider-request surfaces, plus the expected results the manual harness compares against.

**These are test vectors, not tests.** The repository has no test framework by policy (`AGENTS.md`);
`pnpm validate:fixtures` is a manual harness that reads [`expected.json`](./expected.json) and exits
`0` (all rows match) or `1` (a row differs).

## Layout

| Path | Content |
| :--- | :--- |
| `*.json` | Discovery documents (valid/invalid) and broker metadata fixtures. |
| `attestations/*.jwt` | Contract G compact JWS fixtures. |
| `attestation-sources/*.json` | A `{ status, body, contentType? }` stand-in for an `attestation.uri` HTTP response (v1.3.0 source documents and typed broker failures). |
| `receipts/*.jwt` | Contract E v1.2 compact JWS fixtures. |
| `abuse/*.jwt` | Contract D.2 compact JWS fixtures. |
| `status/*.jwt` | Contract I status compact JWS fixtures. |
| `provider/*.json` | Contract H request/response examples (normative fields, no public schema). |
| `keys/fixture-seed.json` | Hardcoded Ed25519 **test seeds** with a warning `comment`. |
| `keys/fixture-jwks-broker-1.json` | Public JWKS for `https://rp-broker.example` (trusted fixture broker). |
| `keys/fixture-jwks-broker-2.json` | Public JWKS for `https://other-broker.example` (untrusted fixture broker). |
| `expected.json` | Expected result for every row below; consumed by `pnpm validate:fixtures`. |

The two broker JWKS files are **separate per-issuer files** and are never merged in one file or one
cache entry.

## Frozen clock and deterministic signing

All JWS fixtures use the frozen clock **`2026-10-24T00:00:00Z`** (`FIXTURE_IAT = 1792800000`). Ed25519 is deterministic (RFC 8032), so a fixed seed +
fixed claims + fixed `iat` produce byte-identical JWS:

```bash
pnpm sign:fixtures          # tsx src/dev/sign-fixtures.ts
git diff --exit-code fixtures/   # must be clean
```

`pnpm sign:fixtures` also regenerates the `attestation-sources/*.json` responses that carry a signed
JWT and the one removed-field discovery fixture, so no checked-in JWS is hand-edited. The typed broker
error responses (403/404/410/503) carry no JWT and are hand-maintained JSON.

### The seed is not a credential

`keys/fixture-seed.json` is a warning-marked test vector. It is never referenced by broker or provider
configuration, signs nothing outside `fixtures/`, and MUST NOT be used for a real origin. The plain
`"comment"` field is a warning, not a JWK `use`/`key_ops` value. The seed is outside the published
`src/` tree; no production or non-fixture private key is committed.

### Fixture-only discovery fields

Three fixture-only top-level fields are used and are warning-level unknown fields to the validator:

- `__fixture_note` — a human note explaining the expected result. Never protocol surface.
- `__fixture_origin` — the origin the validator should treat as the **fetch origin** in file mode, so
  source-host binding and `rp.origin` binding can be checked without a network fetch. Real runs should
  validate the URL; a fixture without a declared origin reports the provider binding as unchecked
  (`attestation_binding_unchecked`) and the attestation as `unavailable` / `origin_unverifiable`,
  never `verified`.
- `__fixture_removed_attestation_source` — used by **one** fixture only
  (`invalid-rp-attestation-removed.json`): the signer copies that JWS into the removed `rp_attestation`
  field so the conformance failure is proven against an authentic token.

## Running the harness

```bash
pnpm --silent validate:fixtures fixtures/expected.json
```

Each row names a `kind` (`discovery`, `attestation`, `receipt`, `abuse`, `status`, `metadata`,
`provider`, `source`), its input path/JWS, optional discovery/verification options, and the expected
outcome. Discovery rows use the same code as the CLI (`--verify-attestation`, `--require-attestation`,
`--trusted-rp-broker`, `--jwks`, `--at`, `--source-response`). `sourceResponse` points at a
`{ status, body, contentType? }` fixture so verification runs offline; `contentType` defaults to
`application/json`, and an injected response skips the network-target probe refusal because nothing is
fetched. A typed broker response is a verification result, never a conformance failure. The harness also
checks every JWS claim set against its checked-in JSON Schema, compares producer mode (closed JSON
Schema + strict Zod) with verifier mode (known fields only) for attestations, and validates every `200`
source body against `attestation-source.schema.json` plus `AttestationSourceDocumentSchema`.

A `crossFieldOnly: true` row is valid under the closed JSON Schema but rejected by Zod/verification
for a rule JSON Schema cannot express (currently: unique `keys[].kid`).

## Matrix

### Discovery documents

| Fixture | Expected |
| :--- | :--- |
| `valid-minimal.json`, `valid-full.json`, `valid-localhost.json` | conformant, no `attestation`, `unverified`, exit `0` |
| `valid-attestation-broker.json` | broker mode: `verified`, mode `broker`, level `domain`, exit `0` (offline source response, trusted broker, `--at 2026-10-24T00:00:00Z`) |
| `valid-attestation-provider.json` | provider mode on the discovery origin: `verified`, mode `provider`, exit `0` |
| `valid-attestation-broker.json` without `--verify-attestation` | conformant, `not_checked`, exit `0` |
| `invalid-attestation-mode.json` (`mode: "embedded"`) | conformance failure, exit `1`, `field.attestation.mode` / `attestation_mode_invalid`; `attestation.status` is `not_checked`, not `invalid` |
| `invalid-attestation-uri-relative.json`, `invalid-attestation-uri-http.json`, `invalid-attestation-uri-userinfo.json`, `invalid-attestation-uri-fragment.json` | conformance failure, exit `1`, `field.attestation.uri` / `attestation_uri_invalid`; the URI is never fetched |
| `invalid-attestation-not-object.json` (`attestation` is a string) | conformance failure, exit `1`, `not_checked` / `field_malformed` |
| `invalid-attestation-broker-host.json` | conformance failure, exit `1`, `field.attestation.binding` / `attestation_uri_host_untrusted`; the URI is never fetched |
| `invalid-attestation-provider-host.json` | conformance failure, exit `1`, `field.attestation.binding` / `attestation_uri_host_unbound` |
| `invalid-rp-attestation-removed.json` | conformance failure, exit `1`, `field.rp_attestation` / `rp_attestation_removed`; reported once, never repeated as an "ignored" unknown top-level field |
| `unverifiable-attestation-no-origin.json` (no `__fixture_origin`) | conformant; binding `skip` / `attestation_binding_unchecked`; `unavailable` / `origin_unverifiable`, exit `0` |
| `valid-attestation-broker.json` with a typed response | `403` → `suspended` / `provider_suspended`; `404` → `unverified` / `attestation_not_found`; `410` → `invalid` / `attestation_revoked`; `503` → `unavailable` / `broker_unavailable`; all exit `0` without `--require-attestation` and remain conformant |
| `valid-attestation-expired.json` | `expired` / `attestation_expired`, exit `0`; exit `1` with `--require-attestation` (at 2026-11-30) |
| `valid-attestation-broker.json` with no trusted broker | `attested_untrusted_broker`, exit `0`; exit `1` with `--require-attestation` |
| `valid-attestation-broker.json` with a missing JWKS | `unavailable` / `rp_broker_unavailable`, exit `0`; exit `2` with `--require-attestation` |
| `valid-attestation-provider.json` with a wrapped token or a raw JWT body | `invalid` / `source_document_invalid`; only `{ "attestation": "<compact JWS>" }` is accepted |
| `valid-attestation-provider.json` with `contentType: "text/plain"` | `invalid` / `source_document_invalid`; a `200` source must be served as `application/json` |
| `valid-attestation-provider.json` with an oversize source (>16384 characters) | `invalid` / `source_document_invalid`; the 16 KiB cap is enforced before JWT verification |
| `valid-attestation-broker.json` with a JWT from a different trusted broker origin | `invalid` / `attestation_issuer_mismatch`; broker-mode `iss` must equal the source URI origin |
| `invalid-json-body.json` (deliberately truncated JSON) | conformance failure, exit `1`, `conformance.evaluated: true`, no `fetchFailure` |
| `does-not-exist.json` (path only, no file) | operational failure, exit `2`, `conformance.valid: null`, `evaluated: false`, error under `fetchFailure` |

Full broker/provider requests in a live run use the same flags without `--source-response`:
`--verify-attestation --trusted-rp-broker <origin> --jwks <pinned-jwks> --at <rfc3339>`.

### Attestation sources (`attestation-sources/`)

| Fixture | Body | Expected |
| :--- | :--- | :--- |
| `ok-broker.json`, `ok-provider.json` | `{ "attestation": "<valid-domain JWS>" }` | valid source document (mode-independent) |
| `ok-expired.json` | `{ "attestation": "<expired JWS>" }` | valid source document; verification reports `expired` at a later clock |
| `ok-wrapped-token.json` | `{ "token": "<JWS>" }` | invalid: the source field is `attestation`, not `token` |
| `ok-raw-jwt-body.json` | `"<JWS>"` | invalid: a raw JWT body is not a source document |
| `wrong-content-type.json` | `{ "attestation": "<JWS>" }` with `contentType: text/plain` | invalid on verification: `source_document_invalid` |
| `ok-broker-other-issuer.json` | `{ "attestation": "<JWS from another trusted broker>" }` | valid source document; broker-mode verification reports `attestation_issuer_mismatch` |
| `oversize-source.json` | `{ "attestation": "<16422-character compact-JWS-shaped value>" }` | invalid: exceeds the 16 KiB cap |
| `forbidden-403-provider-suspended.json` | typed `403` body | verification `suspended` |
| `not-found-404-attestation-not-found.json` | typed `404` body | verification `unverified` |
| `gone-410-attestation-revoked.json` | typed `410` body | verification `invalid` / `attestation_revoked` |
| `unavailable-503-broker-unavailable.json` | typed `503` body | verification `unavailable` |


### Contract G attestations (`attestations/`)

| Fixture | Verification | Producer mode | Verifier mode |
| :--- | :--- | :--- | :--- |
| `valid-domain.jwt` | `verified` | valid | valid |
| `valid-entity.jwt` | `verified` | valid | valid |
| `valid-domain-rotated.jwt` | `verified` (two keys, one retiring) | valid | valid |
| `expired.jwt` | `expired` (at 2026-11-30) | valid | valid |
| `untrusted-broker.jwt` | `attested_untrusted_broker` (issuer not trusted, no JWKS fetch) | valid | valid |
| `unknown-additive-claim.jwt` | `verified` | **fails** (unknown claim) | **passes** |
| `bad-signature.jwt` | `invalid` / `bad_signature` | valid | valid |
| `wrong-origin.jwt` | `invalid` / `wrong_origin` | valid | valid |
| `wrong-audience.jwt` | `invalid` / `wrong_audience` | valid | valid |
| `wrong-typ.jwt` | `invalid` / `wrong_typ` | valid | valid |
| `unknown-kid.jwt` | `invalid` / `unknown_kid` | valid | valid |
| `duplicate-kid.jwt` | `invalid` / `claims_invalid` | JSON Schema valid; Zod fails (cross-field unique `kid`) | fails |
| `missing-exp.jwt` | `invalid` / `claims_invalid` | fails (missing `exp`) | fails |
| `wrong-purposes.jwt` | `invalid` / `claims_invalid` | fails (`purposes` is `const ["receipt","abuse"]`; a reordered or duplicated set is not the frozen tuple) | fails |

### Contract E receipts (`receipts/`)

Each row is checked against `signup-receipt.schema.json` and the named rules: `typ`/`alg`/`kid`,
header `kid` = `service.key_id`, key membership + `receipt` purpose, origin/audience/attestation
binding, and the historical window.

| Fixture | Expected |
| :--- | :--- |
| `valid-receipt.jwt` | passes |
| `valid-receipt-legacy-exp.jwt` | passes; the past `exp` is ignored |
| `valid-receipt-rotated-key.jwt` | passes; the signing key is `retiring`/second key in the rotated attestation |
| `invalid-receipt-bad-key.jwt` | fails `key_not_in_attestation` |
| `wrong-origin.jwt` | fails `origin` |
| `outside-window.jwt` | fails `window` (`iat` after the attestation `exp`) |
| `missing-key-id.jwt` | fails `missing_key_id` (and the schema) |

### Contract D.2 abuse reports (`abuse/`)

| Fixture | Expected |
| :--- | :--- |
| `valid-abuse-report.jwt` | passes (300-second window, `aud` = A issuer, `abuse` purpose) |
| `invalid-abuse-expired.jwt` | fails `expired` (the 300-second bound is never extended) |
| `wrong-aud.jwt` | fails `audience` |
| `unknown-additive-claim.jwt` | rules pass; producer schema fails, verifier mode passes |

### Contract I status (`status/`)

All status fixtures have `exp - iat = 300` and `status_changed_at <= iat`, and are signed by broker 1
except the bad-signature case. The status JWS has the same producer/verifier split as the attestation:
producer mode is the closed JSON Schema plus strict Zod; verifier mode validates known claims and
ignores additive ones.

| Fixture | Expected |
| :--- | :--- |
| `status-active.jwt` | passes; `status: "active"` |
| `status-suspended.jwt` | passes; `status: "suspended"` |
| `status-revoked.jwt` | passes; `status: "revoked"` |
| `unknown-additive-claim.jwt` | rules pass; producer schema fails (unknown claim), verifier mode passes |
| `status-wrong-sub.jwt` | fails `wrong_sub` |
| `status-bad-signature.jwt` | fails `bad_signature` |

### Contract I broker metadata

| Fixture | Expected |
| :--- | :--- |
| `broker-metadata.json` | valid (`issuer` = document origin, same-origin `jwks_uri`) |
| `invalid-broker-metadata-http-jwks.json` | invalid (`jwks_uri` is not HTTPS) |
| `invalid-broker-metadata-missing-status-uri.json` | invalid (missing `attestation_status_uri`) |
| `invalid-broker-metadata-wrong-issuer.json` | invalid (`issuer` differs from the document origin and from `jwks_uri`'s origin) |

### Contract H provider examples (`provider/`)

These are validated against the normative fields in `agent-identity-v1.md` §15; Contract H has no
public JSON Schema.

| Fixture | Expected |
| :--- | :--- |
| `origin-challenge-https.json` | valid HTTPS challenge (`challenge_id`, `method`, `file_url`, token-shaped `file_content`, `expires_at`) |
| `key-pop-claims.json` | valid PoP claims (`exp - iat = 600`, `aud` = B issuer, `jwk` = public key, exact purposes) |
| `attestation-issuance.json` | valid issuance body (`rpa_` jti, 24-hour window, `renewed_from_jti` null, compact-JWS attestation) |

## Adding a fixture

1. Add the file under the right directory (or a discovery document at the top level).
2. If it is a signed JWS, add its claim template to `src/dev/sign-fixtures.ts`, run
   `pnpm sign:fixtures`, and commit the generated `.jwt` (never hand-edit a JWS).
3. Add a row to `fixtures/expected.json` with the expected status/exit/rule and the schema-mode
   expectation.
4. Run `pnpm validate:fixtures` and `git diff --exit-code fixtures/`.

A fixture that cannot be expressed by the checked-in JSON Schema should be documented as a cross-field
rule in the specification and marked `crossFieldOnly` here, not forced into the schema with a weaker
constraint.
