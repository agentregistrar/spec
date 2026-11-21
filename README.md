# Agent Identity v1 — Specification

The public, canonical home of the **`agent-identity-v1`** protocol: the relying-party discovery
contract, the brokered signup handshake, the RP attestation and authenticated reporting contracts,
the JSON Schemas, the conformance/attestation fixtures, the validators, and the implementation
registry.

[Agent Registrar](https://agentregistrar.dev) is the protocol and brokerage service behind Agent
Identity. A Relying Party (RP) publishes an identity-only discovery document that names an optional
broker-issued attestation source; an agent discovers it, verifies the RP locally, obtains a signed
Agent Identity assertion from its broker, and signs up on behalf of a verified human owner — with no
vendor catalog, provisioning, or resource surface in the protocol.

## Contents

| Path | Description |
| :--- | :--- |
| [`agent-identity-v1.md`](./agent-identity-v1.md) | Normative specification for `agent-identity-v1` (`v2.0.0`). |
| [`scope-boundaries.md`](./scope-boundaries.md) | Identity-vs-vendor scope rulebook, including RP identity, and the future-change checklist. |
| [`implementing-agent-identity-v1.md`](./implementing-agent-identity-v1.md) | Relying Party implementation guide (provider identity, attestation modes, receipts, abuse). |
| [`validator.md`](./validator.md) | Conformance, attestation, fixture, and registry validator guide. |
| [`release-notes-v2.0.0.md`](./release-notes-v2.0.0.md) | Release notes for the `v2.0.0` URL-terms and keyless-attestation release (this branch). |
| [`release-notes-v1.3.2.md`](./release-notes-v1.3.2.md) | Release notes for the `v1.3.2` documentation patch. |
| [`release-notes-v1.3.1.md`](./release-notes-v1.3.1.md) | Release notes for the `v1.3.1` contract-text patch. |
| [`release-notes-v1.3.0.md`](./release-notes-v1.3.0.md) | Release notes for the `v1.3.0` release. |
| [`release-notes-v1.2.0.md`](./release-notes-v1.2.0.md) | Release notes for `v1.2.0`. |
| [`release-notes-v1.1.0.md`](./release-notes-v1.1.0.md) | Release notes for `v1.1.0`. |
| [`release-notes-v1.0.0.md`](./release-notes-v1.0.0.md) | Release notes for `v1.0.0` (initial release). |
| [`agent-signup.schema.json`](./agent-signup.schema.json) | JSON Schema for the discovery document (includes the optional `attestation` source object; `rp_attestation` is rejected). |
| [`attestation-source.schema.json`](./attestation-source.schema.json) | JSON Schema for the attestation source document `{ "attestation": "<compact JWS>" }`. |
| [`rp-attestation.schema.json`](./rp-attestation.schema.json) | JSON Schema for Contract G attestation claims. |
| [`broker-metadata.schema.json`](./broker-metadata.schema.json) | JSON Schema for Contract I broker metadata. |
| [`attestation-status.schema.json`](./attestation-status.schema.json) | JSON Schema for Contract I attestation-status claims. |
| [`signup-receipt.schema.json`](./signup-receipt.schema.json) | JSON Schema for Contract E v1.2 receipt claims. |
| [`abuse-report.schema.json`](./abuse-report.schema.json) | JSON Schema for Contract D.2 abuse-report claims. |
| [`fixtures/`](./fixtures) | Conformance and attestation fixtures, per-issuer JWKS, `expected.json`, and the matrix in [`fixtures/README.md`](./fixtures/README.md). |
| [`registry/`](./registry) | Implementation registry (human-readable + machine-readable + schema). |
| `src/` | `@agentregistrar/discovery` — Zod schemas, the conformance/attestation validator, the fixture harness, and the registry validator. |

## Quick start

Install dependencies and run the conformance validator against a discovery URL or a local file:

```bash
pnpm install

# Local file
pnpm validate:discovery fixtures/valid-full.json

# Live URL (HTTPS required; http://localhost / http://127.0.0.1 allowed for development)
pnpm validate:discovery https://example.com/.well-known/agent-signup.json

# Machine-readable result (pass --silent so stdout is pure JSON)
pnpm --silent validate:discovery https://example.com/.well-known/agent-signup.json --json | jq .
```

Attestation verification is opt-in, and conformance never requires the RP broker to be up:

```bash
# Offline, deterministic verification of a broker-managed source (pinned JWKS + injected response)
pnpm validate:discovery fixtures/valid-attestation-broker.json \
  --verify-attestation --require-attestation \
  --jwks fixtures/keys/fixture-jwks-broker-1.json \
  --trusted-rp-broker https://rp-broker.example \
  --source-response fixtures/attestation-sources/ok-broker.json \
  --at 2026-10-24T00:00:00Z

# The standalone JWS/schema fixture matrix (manual harness, not a test framework)
pnpm validate:fixtures

# The implementation registry
pnpm validate:registry registry/implementations.json --json
```

The validator source is `src/validate-discovery.ts`; the checked-in fixtures live in
[`fixtures/`](./fixtures). Exit codes: `0` valid / no required check failed, `1` conformance or
required-verification failure (including unparseable JSON, a malformed `attestation` object, or a
removed `rp_attestation` field), `2` could not obtain what the run needed (document, JWKS, or source)
with no conformance verdict (`DOCUMENT: NOT CHECKED`). See the [validator guide](./validator.md) for
the full flag and `--json` reference. Conformance and attestation verification are reported
separately: a document can be **conformant and unverified**, and a typed broker failure is a
verification result, never a conformance failure.

## Package

`@agentregistrar/discovery` (**`2.0.0`**, **Apache-2.0**) is the self-contained package in this
repository. It has no private dependencies:

- `src/schema.ts` — the canonical Zod schemas: `AgentSignupDiscoverySchema`, `AttestationModeSchema`,
  `AttestationSourceSchema`, `AttestationSourceDocumentSchema`, `RpAttestationClaimsSchema`,
  `RpAttestationKeySchema`, `RpAttestationHeaderSchema`, `AttestationStatusValueSchema`,
  `AttestationStatusClaimsSchema`, `AttestationStatusClaimsVerifierSchema`,
  `AttestationStatusResponseSchema`, `BrokerMetadataSchema`, plus the producer/verifier parsers
  `parseRpAttestationProducer`, `parseRpAttestationVerifier`, `parseAttestationSourceDocument`, and
  `parseAttestationStatusVerifier`. `src/index.ts` re-exports them.
- `src/validate-discovery.ts` — the conformance + attestation validator CLI (`pnpm validate:discovery`).
- `src/validate-fixtures.ts`, `src/validate-registry.ts` — manual harnesses (`pnpm validate:fixtures`,
  `pnpm validate:registry`). `src/dev/sign-fixtures.ts` regenerates the deterministic JWS fixtures
  (`pnpm sign:fixtures`).
- `agent-signup.schema.json`, `attestation-source.schema.json`, `rp-attestation.schema.json`,
  `broker-metadata.schema.json`, `attestation-status.schema.json`, `signup-receipt.schema.json`,
  `abuse-report.schema.json`, and `registry/implementations.schema.json` — the checked-in schemas,
  shipped so consumers and the packaged validators work outside this repository.

The seven protocol schemas and the registry schema are listed in `files` and exposed as `exports`
subpaths (for example `@agentregistrar/discovery/agent-signup.schema.json`). The package is
**source-first**: the npm tarball ships the TypeScript sources (no build step). Consumers therefore
need a toolchain that transpiles dependencies (for example Next.js `transpilePackages` or `tsx`).
Install it from npm, or use the pinned git dependency (`github:agentregistrar/spec#v2.0.0`). The
package declares no `bin` entry — run the CLI with `pnpm validate:discovery`.

### Releasing the package

Publishing is **tag-driven** and uses **npm trusted publishing (OIDC)** — no long-lived npm token.
Bump `version` in `package.json`, add `release-notes-vX.Y.Z.md`, and merge to `main`. Then create and
push an annotated tag on that merge commit:

```bash
git tag -a vX.Y.Z -m "agent-identity-v1 vX.Y.Z"
git push origin vX.Y.Z
```

The tag push runs `publish.yml`, which verifies that the tag matches `package.json`, points to a
commit on `main`, and has matching release notes. It then publishes to npm and creates the GitHub
Release from `release-notes-vX.Y.Z.md`. Provenance is generated automatically. Never run a local
`npm publish`, never use an npm token, and never dispatch the workflow separately from a tag. To
retry a failed release, re-run the workflow for that tag; do not move or delete a tag after npm has
accepted the version.

## Specification release

`agent-identity-v1` **`v2.0.0`** is the URL-hosted-terms and keyless-attestation release. It keeps the
protocol id and the signup/assertion wire format, and simplifies two surfaces:

- **URL-hosted terms.** Discovery `terms` requires only `{ version, url }`. The provider hosts the
  agreement at `terms.url`; the broker fetches it at signup time and records `sha256:<hex>` over the
  exact response bytes in the assertion and the ToS ledger. `terms.text` and `terms.sha256` are no
  longer required or validated and are ignored if present. RPs check `accepted_rp_tos_url` and may
  optionally check `accepted_rp_tos_hash`.
- **Keyless RP attestations.** Contract G `keys` allows 0–8 entries. A domain-verified provider with no
  registered RP signing key receives a valid attestation with `keys: []`; receipts and abuse reports
  still require a key.

See the [v2.0.0 release notes](./release-notes-v2.0.0.md) for the migration steps.

`v1.3.2` was a **documentation-correction** patch on `v1.3.1`. It changed no wire format, schema,
fixture, validator behavior, or attestation claim; it fixed two normative contradictions in the
`v1.3.1` text: issuance with no active key is `409 no_active_key` (scoped to key operations), not
`403 provider_not_eligible`; and the "binding unchecked" rule applies to a `provider` source without a
fetch origin, while a `broker` source is always checked from `issuer_allowlist`.

**`v1.3.0` breaking discovery change.** `v1.3.0` removes the embedded `rp_attestation` discovery field
and replaces it with one OPTIONAL `attestation` object:

```json
{ "attestation": { "mode": "broker",   "uri": "https://broker.example/api/broker/provider-verification?origin=…&audience=…" } }
{ "attestation": { "mode": "provider", "uri": "https://provider.example/.well-known/agent-rp-attestation.json" } }
```

The source at that URI serves `{ "attestation": "<compact JWS>" }` as `application/json`. Absence is
conformant and unverified; a document that still contains `rp_attestation` is **non-conformant**, with
no compatibility field, embedded fallback, or dual publication. The attestation JWT format, claims,
signature, key snapshot, 24-hour lifetime, origin/audience binding, and the Contract F receipt/abuse
bodies are **unchanged**. See the [v1.3.0 release notes](./release-notes-v1.3.0.md) for the migration
steps.

The previous **`v1.1.0`** (2026-10-18) and initial **`v1.0.0`** (2026-10-17) releases and the change
process are recorded in their release notes.

## Documentation

This repository remains the canonical location of the specification. The rendered protocol pages are
generated from the released specification:

- Rendered specification: <https://docs.agentregistrar.dev/agent-identity/v1/specification/>
- Scope boundaries: <https://docs.agentregistrar.dev/agent-identity/v1/scope-boundaries/>
- Implementation guide: <https://docs.agentregistrar.dev/agent-identity/v1/implementation-guide/>
- Validator guide: <https://docs.agentregistrar.dev/agent-identity/v1/validator/>
- Changelog: <https://docs.agentregistrar.dev/agent-identity/v1/changelog/>
- JSON Schema (discovery): <https://docs.agentregistrar.dev/agent-identity/v1/agent-signup.schema.json>
- JSON Schema (attestation source): <https://docs.agentregistrar.dev/agent-identity/v1/attestation-source.schema.json>
- JSON Schema (RP attestation): <https://docs.agentregistrar.dev/agent-identity/v1/rp-attestation.schema.json>
- JSON Schema (broker metadata): <https://docs.agentregistrar.dev/agent-identity/v1/broker-metadata.schema.json>
- JSON Schema (attestation status): <https://docs.agentregistrar.dev/agent-identity/v1/attestation-status.schema.json>
- JSON Schema (signup receipt): <https://docs.agentregistrar.dev/agent-identity/v1/signup-receipt.schema.json>
- JSON Schema (abuse report): <https://docs.agentregistrar.dev/agent-identity/v1/abuse-report.schema.json>
- Usage and integration guides: <https://docs.agentregistrar.dev>
- Agent Registrar product and service: <https://agentregistrar.dev>

## Contributing

PRs welcome. Protocol changes require a spec-repo change (this repository) **plus** conformance
evidence — a validator run over the updated fixtures (`pnpm validate:fixtures`), the registry
(`pnpm validate:registry`), and any affected implementations. Every proposed protocol field must pass
the review checklist in [`scope-boundaries.md`](./scope-boundaries.md); the registry criteria are in
[`registry/README.md`](./registry/README.md). Fixtures are signed test vectors, not tests: the
repository has no test framework by policy, and the harnesses exit `0`/`1`/`2` for manual use.

## License

Apache-2.0. See [`LICENSE`](./LICENSE).
