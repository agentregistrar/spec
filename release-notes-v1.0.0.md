# Release Notes — `agent-identity-v1` `v1.0.0`

- **Protocol identifier:** `agent-identity-v1`
- **Specification version:** `v1.0.0`
- **Release date:** 2026-10-17
- **Normative specification:** [`agent-identity-v1.md`](./agent-identity-v1.md)

This is the initial identity-only release of the Agent Identity Relying Party discovery contract
(`GET /.well-known/agent-signup.json`). It is released as `v1.0.0` after the identity-only schema, the
checked-in JSON Schema, the conformance validator, the VaporCloud reference implementation, and the
documentation were confirmed to agree.

---

## 1. What `v1.0.0` freezes

The release is recorded once the following artifacts agree on the same identity-only contract:

| Artifact | Location | Role |
| :--- | :--- | :--- |
| Normative specification | [`agent-identity-v1.md`](./agent-identity-v1.md) | The single source of truth for the contract. |
| Scope rulebook | [`scope-boundaries.md`](./scope-boundaries.md) | Identity-vs-vendor boundary and the change-review checklist. |
| Implementation source of truth | `src/schema.ts` (`AgentSignupDiscoverySchema`) | Runtime validation shared by the broker, validator, and reference implementation. |
| JSON Schema | [`agent-signup.schema.json`](./agent-signup.schema.json) | Checked-in schema; the validator reports any divergence from Zod. |
| Conformance validator | `src/validate-discovery.ts` (`pnpm validate:discovery …`) | Objective conformance check; `validatorVersion` `1.0.0`. |
| Reference implementation | VaporCloud (reference Relying Party, maintained in the private repository) | Identity-only discovery document + post-signup `context` handoff. |
| Implementation registry | [`registry/implementations.json`](./registry/implementations.json) and [`registry/README.md`](./registry/README.md) | Adoption surface and conformance badge. |
| Public package | [`package.json`](./package.json) — `@agentregistrar/discovery` `1.0.0` | Self-contained, source-first distribution of the canonical schema (`src/schema.ts`) and the validator CLI (`src/validate-discovery.ts`); **Apache-2.0**. npm publishing is **pending** (scope reservation only); consume it via this repository or `github:agentregistrar/spec#v1.0.0` (no `bin` entry). |

### Protocol surface at v1.0.0 (summary)

- Discovery advertises identity only: `protocol`, `audience`, `provider_name`, `issuer_allowlist`,
  `required_scopes`, `terms` (complete `text` + `url` + `version` + `sha256`), and
  `endpoints.agent_signup`. Optional: `spec`, `provider_url`, `contact`, `updated_at`, non-capability
  `extensions`. Vendor catalogs, provisioning/OTP endpoints, resource endpoints, credentials, SKUs,
  and pricing are **forbidden** in discovery at any depth (spec §5.3).
- Contract E (signed `signup_token`) records identity/attribution facts, an opaque
  `service.account_id`, and an optional hash-pinned `context` pointer to the vendor's post-signup
  guide. The vendor resource claims `service.instance_sku` and `service.endpoint_url` are removed
  (spec §11).
- Vendor capabilities are documented in the vendor's post-signup guide (for example `SKILL.md`),
  reached only through the signed `context` pointer.

## 2. Canonical public spec URL decision

- This repository ([`agent-identity-v1.md`](./agent-identity-v1.md)) is the **canonical location** of
  the specification. It is versioned in the repository and updated only through the change process in
  §3.
- The **final canonical hosting URL** for a rendered copy is undecided (spec §16). Until it exists,
  the protocol's optional `spec` discovery field stays **OPTIONAL** and implementers may omit it; the
  placeholder `https://<canonical-spec-host>/agent-identity/v1/agent-signup` is illustrative only.
- When hosting exists, the released `v1.0.0` document is published at a **versioned** URL so the
  optional `spec` field can point at the exact document. This is an additive, non-breaking change to
  the documentation, not to the protocol.

## 3. Change process

### Additive v1 changes (minor/patch)

- Additive identity fields and clarifications are allowed within `v1` and do **not** change the
  `protocol` value or the discovery path. Consumers **MUST** ignore unknown fields.
- Each additive change is recorded in the changelog (spec §1.2) and passes the
  [scope-boundaries.md](./scope-boundaries.md) review checklist before it is added: a field that
  answers "what do we sell?" or "how do you call our API?" is vendor scope and does **not** belong in
  the protocol.
- Additive changes are validated by the conformance validator and by the fixtures before release; the
  JSON Schema and `AgentSignupDiscoverySchema` are updated together so they cannot drift.

### Breaking changes

- A **breaking change MUST use a new `protocol` value and a new discovery path** (for example
  `agent-signup-v2.json`). The v1 path **MUST NOT** silently change semantics (spec §13).
- A new version **SHOULD** be dual-published during a migration window. The broker does not force
  migration; the registry lists implementations by the `protocol` value their discovery document
  advertises.
- Vendor catalogs, provisioning endpoints, resource metadata, and API-usage documentation are **not**
  additive protocol fields at any version; they always belong in the post-signup guide.

## 4. Release evidence

The release was recorded after the reference implementation passed the conformance validator with
**zero errors and zero warnings**:

```bash
# Reference implementation, started locally with placeholder environment variables only:
pnpm validate:discovery http://localhost:3001/.well-known/agent-signup.json --json
# → valid: true, exitCode: 0, protocol: "agent-identity-v1", audience: "vaporcloud",
#   counts: { passed: 22, failed: 0, warnings: 0, probes: 0 }

# Checked-in VaporCloud identity-only discovery fixture (file mode):
pnpm validate:discovery fixtures/valid-full.json --json
# → valid: true, exitCode: 0, protocol: "agent-identity-v1", audience: "vaporcloud",
#   counts: { passed: 17, failed: 0, warnings: 0, probes: 0 }
```

The same commands and results are recorded per entry in
[`registry/implementations.json`](./registry/implementations.json). No live **production** origin has
been validated; the registry records a local reference-implementation run only, and live validation of
a hosted implementation is an operational step performed by that implementer.

## 5. Non-blocking follow-ups

- **IANA registration** of the well-known URI (`agent-signup.json`) is **not** required for v1 and
  does **not** block this release. Evaluate it after v1 stabilizes (spec §16).
- **Canonical hosting** of a rendered copy of the specification at a versioned public URL remains
  undecided (§2).
- A future alias such as `agent-identity.json`, structured `issuers` metadata, discovery-document
  signing, and a Broker-side well-known discovery document are all deferred to later revisions
  (spec §16).

## 6. Related artifacts

- Adoption surface: [`registry/README.md`](./registry/README.md) and
  [`registry/implementations.json`](./registry/implementations.json).
- New-RP guide: [`implementing-agent-identity-v1.md`](./implementing-agent-identity-v1.md).
- Validator guide: [`validator.md`](./validator.md).
