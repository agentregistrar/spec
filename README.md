# Agent Identity v1 — Specification

The public, canonical home of the **`agent-identity-v1`** protocol: the relying-party discovery
contract, the brokered signup handshake, the RP attestation and authenticated reporting contracts,
the JSON Schemas, the conformance/attestation fixtures, the validators, and the implementation
registry.

[Agent Registrar](https://agentregistrar.dev) is the protocol and brokerage service behind Agent
Identity. A Relying Party (RP) publishes an identity-only discovery document and, optionally, a
broker-issued attestation; an agent discovers it, verifies the RP locally, obtains a signed Agent
Identity assertion from its broker, and signs up on behalf of a verified human owner — with no vendor
catalog, provisioning, or resource surface in the protocol.

## Contents

| Path | Description |
| :--- | :--- |
| [`agent-identity-v1.md`](./agent-identity-v1.md) | Normative specification for `agent-identity-v1` (`v1.2.0`). |
| [`scope-boundaries.md`](./scope-boundaries.md) | Identity-vs-vendor scope rulebook, including RP identity, and the future-change checklist. |
| [`implementing-agent-identity-v1.md`](./implementing-agent-identity-v1.md) | Relying Party implementation guide (provider identity, attestation, receipts, abuse). |
| [`validator.md`](./validator.md) | Conformance, attestation, fixture, and registry validator guide. |
| [`release-notes-v1.2.0.md`](./release-notes-v1.2.0.md) | Release notes for `v1.2.0` (current). |
| [`release-notes-v1.1.0.md`](./release-notes-v1.1.0.md) | Release notes for `v1.1.0`. |
| [`release-notes-v1.0.0.md`](./release-notes-v1.0.0.md) | Release notes for `v1.0.0` (initial release). |
| [`agent-signup.schema.json`](./agent-signup.schema.json) | JSON Schema for the discovery document (includes optional `rp_attestation`). |
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
# Offline, deterministic attestation verification against a pinned per-issuer JWKS
pnpm validate:discovery fixtures/valid-attested-domain.json \
  --verify-attestation \
  --jwks fixtures/keys/fixture-jwks-broker-1.json \
  --trusted-rp-broker https://rp-broker.example \
  --at 2026-10-24T00:00:00Z --require-attestation

# The standalone JWS/schema fixture matrix (manual harness, not a test framework)
pnpm validate:fixtures

# The implementation registry
pnpm validate:registry registry/implementations.json --json
```

The validator source is `src/validate-discovery.ts`; the checked-in fixtures live in
[`fixtures/`](./fixtures). Exit codes: `0` valid / no required check failed, `1` conformance or
required-verification failure, `2` could not obtain what the run needed (document or JWKS). See the
[validator guide](./validator.md) for the full flag and `--json` reference. Conformance and
attestation verification are reported separately: a document can be **conformant and unverified**.

## Package

`@agentregistrar/discovery` (**`1.2.0`**, **Apache-2.0**) is published to npm and is the
self-contained package in this repository. It has no private dependencies:

- `src/schema.ts` — the canonical Zod schemas: `AgentSignupDiscoverySchema`, `RpAttestationClaimsSchema`,
  `RpAttestationKeySchema`, `RpAttestationHeaderSchema`, `AttestationStatusValueSchema`,
  `AttestationStatusClaimsSchema`, `AttestationStatusResponseSchema`, `BrokerMetadataSchema`, plus the
  producer/verifier parsers `parseRpAttestationProducer` and `parseRpAttestationVerifier`.
  `src/index.ts` re-exports them.
- `src/validate-discovery.ts` — the conformance + attestation validator CLI (`pnpm validate:discovery`).
- `src/validate-fixtures.ts`, `src/validate-registry.ts` — manual harnesses (`pnpm validate:fixtures`,
  `pnpm validate:registry`). `src/dev/sign-fixtures.ts` regenerates the deterministic JWS fixtures
  (`pnpm sign:fixtures`).
- `agent-signup.schema.json`, `rp-attestation.schema.json`, `broker-metadata.schema.json`,
  `attestation-status.schema.json`, `signup-receipt.schema.json`, `abuse-report.schema.json`, and
  `registry/implementations.schema.json` — the checked-in schemas, shipped so consumers and the
  packaged validators work outside this repository.

The six protocol schemas and the registry schema are listed in `files` and exposed as `exports`
subpaths (for example `@agentregistrar/discovery/agent-signup.schema.json`). The package is
**source-first**: installable with `npm install @agentregistrar/discovery`, and the npm tarball ships
the TypeScript sources (no build step). Consumers therefore need a toolchain that transpiles
dependencies (for example Next.js `transpilePackages` or `tsx`), or they can use the pinned git
dependency (`github:agentregistrar/spec#v1.2.0`). The package declares no `bin` entry — run the CLI
with `pnpm validate:discovery`.

### Releasing the package

Publishing uses **npm trusted publishing (OIDC)** — no long-lived npm token. Bump `version` in
`package.json`, merge to `main`, tag the merge commit `v1.2.0`, then run the `Publish package`
workflow (`.github/workflows/publish.yml`, environment `npm-publish`) from `main`. Provenance is
generated automatically. Never run a local `npm publish` and never use an npm token.

## Specification release

`agent-identity-v1` **`v1.2.0`** was released on **2026-10-24** — the two-sided-trust release. It
adds the broker-issued RP attestation (Contract G), the provider registration/status API (Contract H),
broker metadata and signed attestation status (Contract I), the optional `rp_attestation` discovery
field (D.1), authenticated abuse reporting (D.2), RP-signed receipts (E), authenticated receipt
ingestion (F), and the trust model, assurance levels, verification rules, and status/error taxonomy.

`rp_attestation` is OPTIONAL and the wire protocol id stays `agent-identity-v1`: `v1.0.0` and
`v1.1.0` documents remain conformant and are simply unverified. The former §14–§17 were renumbered
§20–§23 so §1–§13 anchors stay stable. See the [v1.2.0 release notes](./release-notes-v1.2.0.md).

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
