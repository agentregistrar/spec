# `agent-identity-protocol` Implementation Registry

- **Status:** Published.
- **Machine-readable registry (canonical source):** [`implementations.json`](./implementations.json)
- **Specification:** [`../agent-identity-protocol.md`](../agent-identity-protocol.md) - see §1.2 for the changelog and `release-notes-v*.md` for release notes. The wire contract is `protocol: "agent-identity-protocol"` with `protocol_version: "2.0"`.
- **Conformance and attestation validator:** `npx @agentregistrar/discovery validate <url-or-file> --json` (from a clone: `pnpm validate:discovery <url-or-file> --json`) ([validator guide](../validator.md)).
- **Registry validator and schema:** `src/validate-registry.ts` (`pnpm validate:registry [path] [--json]`) and [`implementations.schema.json`](./implementations.schema.json).
- **Implementation guide:** [`../implementing-agent-identity-protocol.md`](../implementing-agent-identity-protocol.md).

This registry is **adoption infrastructure**, not an enforcement mechanism. The validator is the
objective check and the registry is a public list of the implementations that pass it.

---

## 1. What conformance means

An implementation is **`agent-identity-protocol` conformant** when the discovery document it serves at
`GET /.well-known/agent-signup.json` passes the identity-only conformance validator with **zero
errors**. Conformance means:

- The document validates against the shared `AgentSignupDiscoverySchema` and the checked-in
  [`agent-signup.schema.json`](../agent-signup.schema.json).
- Every required identity field is present and correct: `protocol` exactly
  `"agent-identity-protocol"`, `protocol_version` exactly `"2.0"`, `audience`, `provider_name`, a
  non-empty `issuer_allowlist`, unique `required_scopes` (including `tos:accept`), URL-hosted `terms`
  with `version` and an absolute HTTPS `url` (localhost development exception), and
  `endpoints.agent_signup` as the only endpoint. `terms.text` and `terms.sha256` are not required and
  are ignored if present.
- The document contains **no vendor capability surface** at any depth — no catalogs, SKUs, pricing,
  provisioning/OTP endpoints, resource endpoints, or credentials (spec §5.3).

Conformance is **identity-only by design**. What a vendor sells and how its API is used are vendor
responsibilities documented in a **post-signup guide** (for example `SKILL.md`), reached through the
signed `context` pointer. Discovery is a parameter document, not a capability catalog.

To be listed here, an implementation must also meet the entry criteria below.

### 1.1 Verification is a separate, optional statement

Conformance says the discovery **document** passes the validator. **Verification** is a different
statement: a broker attests the RP's canonical origin, audience, provider identity, assurance level,
and public keys (Contract G). It is OPTIONAL and **does not** make an entry conformant by itself, and
conformance does **not** imply verification.

An entry may carry an optional `verification` object:

```json
"verification": {
  "broker": "https://agentregistrar.dev", "level": "domain",
  "attestation_jti": "rpa_01j...", "checked_at": "2026-10-24T00:00:00Z",
  "status": "active"
}
```

All five fields are required when the object is present. `level` is `domain` or `entity`; `status` is
`active`, `suspended`, or `revoked` and describes the attestation **at `checked_at`**. The registry is
a snapshot: a later suspension or revocation does not rewrite the static entry or badge until a new
check is recorded. **A verified entry requires a live attestation, a provider account with the
attesting broker, and a recorded check** — the schema and validator can check the record's shape, not
its liveness.

Absence of `verification` means **conformant, unverified**. Unverified entries stay listed.
Verification is **identity, not endorsement**: it does not assert the product's safety, uptime,
solvency, or conduct.

## 2. Entry criteria

1. **The identity-only validator passes** - `npx @agentregistrar/discovery validate <discovery-url>
   --json` (or `pnpm validate:discovery` from a clone) reports `valid: true` with `exitCode: 0`
   (warnings permitted, errors not).
2. **The discovery document is public and stable** — an HTTPS `/.well-known/agent-signup.json` on the implementation's canonical origin (spec §4), not a throwaway or per-deploy URL.
3. **The contact is reachable** — a security/abuse/legal contact (email or URL) that someone actually monitors.
4. **A post-signup context guide is published if the vendor has capabilities to document** — vendor features (catalog, provisioning, SKUs, API usage, errors) belong in that guide, not in discovery or this registry.
5. **Optional: a recorded verification snapshot** — if the entry claims verification, it carries all five `verification` fields, the attestation is live at `checked_at`, and the broker and provider account are real. Verification is not required for listing.

Meeting these criteria is a statement about the **discovery document only**. It is **not** a broker
endorsement of the implementation's product, security posture, uptime, or pricing (see §6).

**Reference entry.** Reference Provider meets criterion 2: its entry uses the live
`https://reference.agentregistrardemorp.com/.well-known/agent-signup.json` from the open-source
[Demo Network](https://github.com/agentregistrar/demo-network) (`https://agentregistrardemobroker.com`)
and was validated from the public internet on 2026-11-24.

**Live validation (2026-11-24).** The deployed reference implementation was validated with the
conformance validator (`@agentregistrar/discovery@2.3.0`):

```bash
npx @agentregistrar/discovery@2.3.0 validate https://reference.agentregistrardemorp.com/.well-known/agent-signup.json \
  --verify-attestation --require-attestation \
  --trusted-rp-broker https://alpha.agentregistrardemobroker.com --json
```

Result: `valid: true`, exit `0`, zero errors, 1 warning (`transport.cache-control`), **24 checks passed**,
and the attestation verified at level `domain` against
`https://alpha.agentregistrardemobroker.com/.well-known/jwks.json`. The entry in §3 records this run
and the five-field `verification` snapshot.

## 3. Registered implementations

The table below is kept **in lockstep** with [`implementations.json`](./implementations.json) — that
document is the canonical machine-readable source. Registry `capabilities` are **protocol**
capabilities only; vendor features are never listed.

| Implementation | Discovery URL | Audience | Protocol | Capabilities | Contact | Validated | Verification |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **Reference Provider** (reference) | `https://reference.agentregistrardemorp.com/.well-known/agent-signup.json` | `demo-reference` | `agent-identity-protocol` | `agent_signup`, `post_signup_context` | `security@agentregistrardemorp.com` | 2026-11-24 | verified (domain) |

Registry metadata (validator version, exact commands, and observed protocol/audience) lives in the
machine-readable file. Each entry's `validator_evidence` records the concrete command and result.

Reference Provider's `verification` object records broker `https://alpha.agentregistrardemobroker.com`,
level `domain`, attestation jti `rpa_01m87dpx51zqxqp097t7w8p1sp`, `checked_at`
`2026-11-24T18:57:48.000Z`, and `status:"active"`. It is a **snapshot**, not a live status feed;
the attestation source named by discovery is the live proof, and verification is identity, not
safety or endorsement.

**Live origin.** Reference Provider's `discovery_url` and `validator_evidence.source` are both the
public `https://reference.agentregistrardemorp.com/.well-known/agent-signup.json`; the recorded run
was URL-mode from the public internet.

### Reference implementation: Reference Provider

Reference Provider is the open-source reference Relying Party from the
[Agent Registrar Demo Network](https://github.com/agentregistrar/demo-network) (Apache-2.0, hub at
`https://agentregistrardemobroker.com`). Its identity-only discovery document is built to the shared
schema and served at `https://reference.agentregistrardemorp.com/.well-known/agent-signup.json`. Its
demo features (widget API, Day-2 login, step-up approval, and abuse reporting) are documented in its
post-signup guide at `https://reference.agentregistrardemorp.com/docs/SKILL.md`, reached through the
signed `context` pointer — they are **not** part of discovery and **not** registry capabilities.

## 4. How to submit an entry

1. Make your discovery document conformant using the
   [implementation guide](../implementing-agent-identity-protocol.md).
2. Run the validator against your **public** discovery URL and keep the JSON:
   ```bash
   npx @agentregistrar/discovery validate https://your-service.example/.well-known/agent-signup.json --json
   ```
3. Open a pull request that adds one object to the `implementations` array in
   [`implementations.json`](./implementations.json) with:
   `name`, `url`, `discovery_url`, `audience`, `protocol` (`agent-identity-protocol`),
   `protocol_version` (`"2.0"`), `capabilities` (protocol capabilities only), `contact`,
   `validated_at`, `validator_version`, and a
   `validator_evidence` object containing the exact command and the resulting counts
   (`protocol` and `audience` read directly from the `--json` output — see the
   [validator field reference](../validator.md#12---json-field-reference-for-the-implementation-registry)).
   If you also claim verification, add the five-field `verification` object described in §1.1,
   including the attesting broker, assurance level, attestation `jti`, `checked_at`, and status.
4. Validate the registry locally: `pnpm --silent validate:registry registry/implementations.json --json`
   must report `valid: true`, `exitCode: 0`.
5. Update the table in §3 of this README so the two stay in lockstep.
6. The pull request is reviewed against the entry criteria in §2.

To update or remove an entry (for example after dropping `agent-identity-protocol` support), submit a pull
request with the validator evidence for the change. An entry whose document no longer passes the
validator is removed.

## 5. Verified-provider badge

A **verified** badge renders only when an entry's `verification.status` is `active` **at
`checked_at`**. It shows the attesting `broker` and the assurance `level`, and links to that broker's
metadata (`/.well-known/agent-broker.json`). It says the RP's origin and identity were attested by
that broker at that time — not that the provider is safe, solvent, or recommendable.

An entry with no `verification`, or with a non-`active` snapshot, renders as **conformant,
unverified**. A suspension or revocation that happens after `checked_at` is not retroactively written
into the static entry; record a new check to update it.

## 6. Conformance badge

Implementations listed in the registry may display the following badge. It states that the
implementation's **discovery document** is `agent-identity-protocol` conformant; it links to the
specification and to the registry entry criteria in §2.

```html
<!-- agent-identity-protocol conformance badge -->
<a href="https://<canonical-spec-host>/protocol/agent-signup"><strong>agent-identity-protocol</strong></a>
<a href="https://<registry-host>/registry/README.md#2-entry-criteria"><strong>conformant</strong></a>
```

Markdown equivalent:

```markdown
[**agent-identity-protocol**](https://<canonical-spec-host>/protocol/agent-signup) [**conformant**](https://<registry-host>/registry/README.md#2-entry-criteria)
```

> **Replace the placeholder hosts before publishing.** `https://<canonical-spec-host>/…` and
> `https://<registry-host>/…` are placeholders: until the canonical spec and registry hosts are
> live these links resolve nowhere, so a badge copied verbatim ships dead links. Substitute the
> real hosts (or the in-repo paths below) before you publish.

Both render as **agent-identity-protocol conformant**. The specification is not yet hosted at a final
canonical URL, so this repository is the **canonical location** (see the
[spec §1.3](../agent-identity-protocol.md) and
[release notes](../release-notes-v1.1.0.md)); substitute the canonical URL for
the `<…>` placeholders once hosting exists. In-repo, the link targets are
[`agent-identity-protocol.md`](../agent-identity-protocol.md) and §2 of this document.

### Badge usage terms

- **Accurate claim only.** Use the badge only while your implementation is listed in this registry and
  its discovery document continues to pass the validator. Remove it if your entry is removed.
- **Discovery only.** The badge asserts that your **discovery document** is conformant. It does not
  certify your product, service, security, availability, or pricing.
- **No endorsement.** The badge does **not** imply endorsement, partnership, or approval by the
  broker, the Agent Registrar project, or any other implementer. Do not imply otherwise.
- **No vendor-capability claims.** Do not use the badge to advertise provisioning, catalogs, SKUs,
  pricing, OTP/legacy signup, or resource endpoints as protocol surface.
- **Follow the spec.** If the badge's linked criteria and the specification disagree, the
  specification wins.

## 7. Canonical links

| Artifact | Location |
| :--- | :--- |
| Specification | [`../agent-identity-protocol.md`](../agent-identity-protocol.md) |
| Changelog and release notes | [`../agent-identity-protocol.md`](../agent-identity-protocol.md) §1.2 (links to `release-notes-v*.md`) |
| Scope boundaries rulebook | [`../scope-boundaries.md`](../scope-boundaries.md) |
| Conformance + attestation validator guide | [`../validator.md`](../validator.md) |
| Registry schema | [`./implementations.schema.json`](./implementations.schema.json) |
| Implementation guide (new RPs) | [`../implementing-agent-identity-protocol.md`](../implementing-agent-identity-protocol.md) |
| Machine-readable registry | [`./implementations.json`](./implementations.json) |

This repository is the **canonical location** of the specification until a rendered copy is hosted
at a final URL (spec §22). The protocol's `spec` discovery field stays **OPTIONAL** until then.
