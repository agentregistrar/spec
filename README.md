# Agent Identity v1 — Specification

The public, canonical home of the **`agent-identity-v1`** Relying Party discovery
specification: the `GET /.well-known/agent-signup.json` contract, the brokered signup
handshake, the JSON Schema, the conformance fixtures, the conformance validator, and the
implementation registry.

[Agent Registrar](https://agentregistrar.dev) is the protocol and brokerage service behind
Agent Identity. A Relying Party (RP) publishes an identity-only discovery document; an agent
discovers it, obtains a signed Agent Identity assertion from its broker, and signs up on behalf
of a verified human owner — with no vendor catalog, provisioning, or resource surface in the
protocol.

## Contents

| Path | Description |
| :--- | :--- |
| [`agent-identity-v1.md`](./agent-identity-v1.md) | Normative specification for `agent-identity-v1`. |
| [`scope-boundaries.md`](./scope-boundaries.md) | Identity-vs-vendor scope rulebook and future-change checklist. |
| [`implementing-agent-identity-v1.md`](./implementing-agent-identity-v1.md) | Relying Party implementation guide. |
| [`validator.md`](./validator.md) | Conformance validator guide. |
| [`release-notes-v1.0.0.md`](./release-notes-v1.0.0.md) | Release notes for `v1.0.0`. |
| [`agent-signup.schema.json`](./agent-signup.schema.json) | JSON Schema for the discovery document. |
| [`fixtures/`](./fixtures) | Conformance fixtures (`valid-*` / `invalid-*`). |
| [`registry/`](./registry) | Implementation registry (human-readable + machine-readable). |
| `src/` | `@agentregistrar/discovery` — canonical `AgentSignupDiscoverySchema` (Zod) and the conformance validator CLI. |

## Quick start

Install dependencies and run the conformance validator against a discovery URL or a local
file:

```bash
pnpm install

# Local file
pnpm validate:discovery fixtures/valid-full.json

# Live URL (HTTPS required; http://localhost / http://127.0.0.1 allowed for development)
pnpm validate:discovery https://example.com/.well-known/agent-signup.json

# Machine-readable result (pass --silent so stdout is pure JSON)
pnpm --silent validate:discovery https://example.com/.well-known/agent-signup.json --json | jq .
```

The validator source is `src/validate-discovery.ts`; the checked-in fixtures live in
[`fixtures/`](./fixtures). Exit codes: `0` valid, `1` invalid document, `2` could not fetch.
See the [validator guide](./validator.md) for the full flag and `--json` reference.

## Package

`@agentregistrar/discovery` (**`1.0.0`**, **Apache-2.0**) is the self-contained package in this
repository. It has no private dependencies:

- `src/schema.ts` — the canonical `AgentSignupDiscoverySchema` (Zod) plus the `sha256:` hash
  helper; `src/index.ts` re-exports it.
- `src/validate-discovery.ts` — the conformance validator CLI (`pnpm validate:discovery`).

It is **source-first**: consumers use it through this repository or a pinned git dependency
(`github:agentregistrar/spec#v1.0.0`). **npm publishing is pending** (the `@agentregistrar` scope is
reservation-only), and the package declares no `bin` entry — run the CLI with
`pnpm validate:discovery`.

## Specification release

`agent-identity-v1` **`v1.0.0`** was released on **2026-10-17**. See the
[release notes](./release-notes-v1.0.0.md) for what the release freezes and the change process.

## Documentation

- Usage and integration guides: <https://docs.agentregistrar.dev> (content arriving).
- Agent Registrar product and service: <https://agentregistrar.dev>.

## Contributing

PRs welcome. Protocol changes require a spec-repo change (this repository) **plus**
conformance evidence — a validator run over the updated fixtures and any affected
implementations. Every proposed protocol field must pass the review checklist in
[`scope-boundaries.md`](./scope-boundaries.md); the registry criteria are in
[`registry/README.md`](./registry/README.md).

## License

Apache-2.0. See [`LICENSE`](./LICENSE).
