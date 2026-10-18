# Release Notes — `agent-identity-v1` `v1.1.0`

- **Protocol identifier:** `agent-identity-v1`
- **Specification version:** `v1.1.0`
- **Release date:** 2026-10-18
- **Normative specification:** [`agent-identity-v1.md`](./agent-identity-v1.md)
- **Change process:** [`release-notes-v1.0.0.md`](./release-notes-v1.0.0.md) §3

`v1.1.0` is an **additive, text-only** revision of the `agent-identity-v1` discovery contract. It adds
clarifications that were implicit in `v1.0.0`, plus one **optional** success-response field. It removes
and renames nothing, changes no schema, Zod, JSON Schema, or validator code, and keeps the wire
protocol id `agent-identity-v1`. **`v1.0.0` implementors remain conformant.**

---

## 1. What `v1.1.0` clarifies

| Area | Clarification | Where |
| :--- | :--- | :--- |
| Replay vs resolve | The `jti` check is an **account-creation guard**, not duplicate suppression. A repeated POST with an already-used `jti` for the **same** agent/account/service **MUST** resolve idempotently — a success, not `assertion_replayed`. `assertion_replayed` is reserved for a `jti` presented in a conflicting context. A Broker **MAY** return the identical previously issued unexpired assertion for an identical request; an RP **MUST NOT** treat a fresh assertion referencing an existing acceptance as a new consent. | §7.1, §7.2 |
| Optional `resolution` | The success response **MAY** carry `resolution: "created" \| "resolved"`. `resolved` **MUST NOT** be treated as failure; on `resolved` the RP **MAY** omit provider credentials (show-once) but **MUST** point the agent at its recovery path in the guide. | §7.1 step 4 |
| Acceptance lifetime | No protocol-mandated re-acceptance interval. An acceptance remains the recorded consent for its `terms.sha256` until the terms change or the human re-consents. A Broker **MAY** impose its own policy and **SHOULD** document it. | §7.3 (new) |
| Knowledge of text | Restated: the Broker **MUST** require the caller to demonstrate knowledge of `terms.text` and **MUST** reject a request that does not. | §7.1 step 1, §10 |
| Account identity keys | Recommended keys `(iss, human.id)` for human-scoped accounts and `(iss, agent.id)` for agent-scoped accounts; keying on emails is **NOT RECOMMENDED**; namespace by `iss` when more than one issuer is trusted; `human.verified` means verified email, not KYC. | §9.1 (new) |
| Credential handoff & recovery | Credentials are **show-once**; agents **MUST** persist them at the handoff moment and **MUST NOT** rely on the conversation as storage; the Broker **MUST NOT** store provider credentials; agents **MUST NOT** re-run signup as recovery; RPs **SHOULD** document a recovery/rotation path in the guide; a repeated signup resolves without re-issuing credentials or sending duplicate mail. | §12.5 (new) |
| Conformance checklist | Two **SHOULD** items added: idempotent-resolve signalling, and a guide-documented recovery path. | §15.1 |
| Open questions | The replay/resolve and credential-handoff questions are resolved; canonical hosting remains open. | §16 |
| Security considerations | The replay and credential-handoff entries were updated to match the clarifications above. | §14 |

### Protocol surface at v1.1.0 (summary)

Unchanged from `v1.0.0` except for one **optional** success-response field:

- Discovery is still identity-only: `protocol`, `audience`, `provider_name`, `issuer_allowlist`,
  `required_scopes`, `terms`, and `endpoints.agent_signup`, plus the same optionals (`spec`,
  `provider_url`, `contact`, `updated_at`, non-capability `extensions`). No discovery field is added,
  removed, or renamed.
- `POST endpoints.agent_signup` success responses **MAY** include `resolution: "created" | "resolved"`.
  An absent `resolution` means `v1.0.0` behaviour and is conformant.
- The signed `signup_token` (Contract E), the optional `context` pointer, and every §7.2 error code are
  unchanged. `assertion_replayed` semantics are narrowed to conflicting reuse; it is not returned for
  an idempotent repeat by the same agent/account/service.
- Vendor capabilities (catalogs, provisioning, credentials, recovery endpoints, API usage) remain out
  of discovery and the receipt. Credential recovery is vendor capability documented only in the guide.

## 2. Canonical public spec URL decision

Hosting is still undecided (spec §16). The optional `spec` field **stays OPTIONAL** and implementers
may omit it. In this release the checked-in fixture now pins the **canonical repository document** at
its version tag:

```json
"spec": "https://github.com/agentregistrar/spec/blob/v1.1.0/agent-identity-v1.md"
```

## 3. Change process

Unchanged from [`release-notes-v1.0.0.md`](./release-notes-v1.0.0.md) §3. `v1.1.0` was reviewed against
the [scope-boundaries.md](./scope-boundaries.md) checklist: every change is identity-, delegation-,
ToS-, traceability-, or handoff-related; none advertises a catalog, SKU, pricing, resource endpoint,
credential, or vendor API usage; all changes are additive within v1. A breaking change **MUST** still
use a new `protocol` value and a new discovery path.

## 4. Validation evidence

The changes are text-only, so the validator and both schemas are byte-identical to `v1.0.0`; the runs
below confirm the fixtures still receive the same verdicts (no validator drift). Run on **2026-10-18**
from a clone of this repository:

```bash
pnpm validate:discovery fixtures/valid-full.json --json
# → valid: true, exitCode: 0, protocol: "agent-identity-v1", audience: "vaporcloud",
#   validatorVersion: "1.0.0",
#   counts: { passed: 17, failed: 0, warnings: 0, probes: 0 }
```

The only field changed in `fixtures/valid-full.json` is the `spec` URL (§2); the validator verdict is
unchanged from `v1.0.0` (17 passed, 0 failed, 0 warnings).

Invalid fixtures — unchanged verdicts, each `valid: false`, exit code `1`:

| Fixture | `counts` |
| :--- | :--- |
| `invalid-bad-tos-hash.json` | `{ passed: 12, failed: 2, warnings: 2, probes: 0 }` |
| `invalid-broker-receipt-endpoint.json` | `{ passed: 13, failed: 2, warnings: 1, probes: 0 }` |
| `invalid-empty-issuer-allowlist.json` | `{ passed: 13, failed: 2, warnings: 1, probes: 0 }` |
| `invalid-missing-agent-signup.json` | `{ passed: 13, failed: 2, warnings: 1, probes: 0 }` |
| `invalid-missing-terms-text.json` | `{ passed: 12, failed: 2, warnings: 1, probes: 0 }` |
| `invalid-unknown-protocol.json` | `{ passed: 13, failed: 2, warnings: 1, probes: 0 }` |
| `invalid-vendor-catalog.json` | `{ passed: 13, failed: 2, warnings: 1, probes: 0 }` |
| `invalid-vendor-endpoints.json` | `{ passed: 13, failed: 2, warnings: 1, probes: 0 }` |

Other valid fixtures are also unchanged: `valid-minimal.json` and `valid-localhost.json` each report
`valid: true`, exit code `0`, `{ passed: 16, failed: 0, warnings: 0, probes: 0 }`.

The **`v1.0.0` release evidence remains as history** (see
[`release-notes-v1.0.0.md`](./release-notes-v1.0.0.md) §4 and
[`registry/implementations.json`](./registry/implementations.json)); the runs above are the `v1.1.0`
counterparts. No live **production** origin was validated for this revision.

## 5. Release record

Per the repository `AGENTS.md`, the source-first package `@agentregistrar/discovery` was aligned to the
specification version — `package.json` `version` bumped `1.0.2` → `1.1.0` — and published to npm using
**trusted publishing (OIDC)** by dispatching `publish.yml` from `main`. No npm token is involved.

- Workflow: [`.github/workflows/publish.yml`](./.github/workflows/publish.yml) (`workflow_dispatch`) on
  repository `agentregistrar/spec`, environment `npm-publish`, `id-token: write`.
- Publish run: `PENDING_RUN_ID` (conclusion: `PENDING_CONCLUSION`).
- Evidence: `npm view @agentregistrar/discovery@1.1.0 version`.

This release is **text-only** — no schema/Zod/JSON-Schema and no validator change — so no npm publish
is required for conformance; the version alignment is an operator decision so the published package
version tracks the specification version.

## 6. Non-blocking follow-ups

- **Canonical hosting** of a rendered copy of the specification at a versioned public URL remains
  undecided (§2).
- IANA registration of the well-known URI, a future `agent-identity.json` alias, structured `issuers`
  metadata, discovery-document signing, and a Broker-side well-known discovery document all remain
  deferred (spec §16).

## 7. Related artifacts

- Normative spec: [`agent-identity-v1.md`](./agent-identity-v1.md)
- Scope rulebook: [`scope-boundaries.md`](./scope-boundaries.md)
- Implementation guide: [`implementing-agent-identity-v1.md`](./implementing-agent-identity-v1.md)
- Validator guide: [`validator.md`](./validator.md)
- Registry: [`registry/README.md`](./registry/README.md),
  [`registry/implementations.json`](./registry/implementations.json)
- Previous release: [`release-notes-v1.0.0.md`](./release-notes-v1.0.0.md)
