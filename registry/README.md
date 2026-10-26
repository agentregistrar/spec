# `agent-identity-v1` Implementation Registry

- **Status:** Published.
- **Machine-readable registry (canonical source):** [`implementations.json`](./implementations.json)
- **Specification:** [`../agent-identity-v1.md`](../agent-identity-v1.md) — **v1.2.0**, released 2026-10-24 and tagged `v1.2.0` ([release notes](../release-notes-v1.2.0.md)). Earlier releases are `v1.1.0` (2026-10-18) and `v1.0.0` (2026-10-17).
- **Conformance and attestation validator:** `src/validate-discovery.ts` — run as `pnpm validate:discovery <url-or-file> --json` ([validator guide](../validator.md)).
- **Registry validator and schema:** `src/validate-registry.ts` (`pnpm validate:registry [path] [--json]`) and [`implementations.schema.json`](./implementations.schema.json).
- **Implementation guide:** [`../implementing-agent-identity-v1.md`](../implementing-agent-identity-v1.md).

This registry is **adoption infrastructure**, not an enforcement mechanism. The validator is the
objective check and the registry is a public list of the implementations that pass it.

---

## 1. What conformance means

An implementation is **`agent-identity-v1` conformant** when the discovery document it serves at
`GET /.well-known/agent-signup.json` passes the identity-only conformance validator with **zero
errors**. Conformance means:

- The document validates against the shared `AgentSignupDiscoverySchema` and the checked-in
  [`agent-signup.schema.json`](../agent-signup.schema.json).
- Every required identity field is present and correct: `protocol`, `audience`, `provider_name`, a
  non-empty `issuer_allowlist`, unique `required_scopes` (including `tos:accept`), `terms` with the
  complete `text` + matching `sha256`, and `endpoints.agent_signup` as the only endpoint.
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

1. **The identity-only validator passes** — `pnpm validate:discovery <discovery-url> --json` reports
   `valid: true` with `exitCode: 0` (warnings permitted, errors not).
2. **The discovery document is public and stable** — an HTTPS `/.well-known/agent-signup.json` on the implementation's canonical origin (spec §4), not a throwaway or per-deploy URL.
3. **The contact is reachable** — a security/abuse/legal contact (email or URL) that someone actually monitors.
4. **A post-signup context guide is published if the vendor has capabilities to document** — vendor features (catalog, provisioning, SKUs, API usage, errors) belong in that guide, not in discovery or this registry.
5. **Optional: a recorded verification snapshot** — if the entry claims verification, it carries all five `verification` fields, the attestation is live at `checked_at`, and the broker and provider account are real. Verification is not required for listing.

Meeting these criteria is a statement about the **discovery document only**. It is **not** a broker
endorsement of the implementation's product, security posture, uptime, or pricing (see §6).

**Reference entry.** VaporCloud now meets criterion 2: its entry uses the live
`https://skdl.dev/.well-known/agent-signup.json` and was re-validated from the public internet on
2026-10-26. The earlier `.example`/local-run exception is retired.

**Live re-validation (2026-10-26).** The deployed reference implementation was validated with the
v1.2.0 self-contained validator:

```bash
pnpm validate:discovery https://skdl.dev/.well-known/agent-signup.json \
  --verify-attestation --require-attestation \
  --trusted-rp-broker https://agentregistrar.dev --json
```

Result: `valid: true`, exit `0`, zero errors, zero warnings, **23 checks passed**, and the attestation
verified at level `domain` against `https://agentregistrar.dev/.well-known/jwks.json`. The entry in
§3 records this run and the five-field `verification` snapshot.

## 3. Registered implementations

The table below is kept **in lockstep** with [`implementations.json`](./implementations.json) — that
document is the canonical machine-readable source. Registry `capabilities` are **protocol**
capabilities only; vendor features are never listed.

| Implementation | Discovery URL | Audience | Protocol | Capabilities | Contact | Validated | Verification |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **VaporCloud** (reference) | `https://skdl.dev/.well-known/agent-signup.json` | `vaporcloud` | `agent-identity-v1` | `agent_signup`, `post_signup_context` | `security@skdl.dev` | 2026-10-26 | verified (domain) |

Registry metadata (validator version, exact commands, and observed protocol/audience) lives in the
machine-readable file. Each entry's `validator_evidence` records the concrete command and result.

VaporCloud's `verification` object records broker `https://agentregistrar.dev`, level `domain`,
attestation jti `rpa_01m5vggft4vn3x9bfw9wy6b8zn`, `checked_at` `2026-10-26T07:23:40.000Z`, and
`status:"active"`. It is a **snapshot**, not a live status feed; the broker attestation in discovery
is the live proof, and verification is identity, not safety or endorsement.

**Live origin.** VaporCloud's `discovery_url` and `validator_evidence.source` are both the public
`https://skdl.dev/.well-known/agent-signup.json`; the recorded run was URL-mode from the public
internet.

### Reference implementation: VaporCloud

VaporCloud is the reference Relying Party. Its identity-only discovery document is built to the
shared schema and served at `https://skdl.dev/.well-known/agent-signup.json`. Its vendor features
(catalog, provisioning API, legacy OTP fallback, admin actions) are documented in its post-signup
guide at `https://skdl.dev/docs/SKILL.md`, reached through the signed `context` pointer — they are
**not** part of discovery and **not** registry capabilities.

## 4. How to submit an entry

1. Make your discovery document conformant using the
   [implementation guide](../implementing-agent-identity-v1.md).
2. Run the validator against your **public** discovery URL and keep the JSON:
   ```bash
   pnpm --silent validate:discovery https://your-service.example/.well-known/agent-signup.json --json
   ```
3. Open a pull request that adds one object to the `implementations` array in
   [`implementations.json`](./implementations.json) with:
   `name`, `url`, `discovery_url`, `audience`, `protocol` (`agent-identity-v1`),
   `capabilities` (protocol capabilities only), `contact`, `validated_at`, `validator_version`, and a
   `validator_evidence` object containing the exact command and the resulting counts
   (`protocol` and `audience` read directly from the `--json` output — see the
   [validator field reference](../validator.md#12---json-field-reference-for-the-implementation-registry)).
   If you also claim verification, add the five-field `verification` object described in §1.1,
   including the attesting broker, assurance level, attestation `jti`, `checked_at`, and status.
4. Validate the registry locally: `pnpm --silent validate:registry registry/implementations.json --json`
   must report `valid: true`, `exitCode: 0`.
5. Update the table in §3 of this README so the two stay in lockstep.
6. The pull request is reviewed against the entry criteria in §2.

To update or remove an entry (for example after dropping `agent-identity-v1` support), submit a pull
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
implementation's **discovery document** is `agent-identity-v1` conformant; it links to the
specification and to the registry entry criteria in §2.

```html
<!-- agent-identity-v1 conformance badge -->
<a href="https://<canonical-spec-host>/agent-identity/v1/agent-signup"><strong>agent-identity-v1</strong></a>
<a href="https://<registry-host>/registry/README.md#2-entry-criteria"><strong>conformant</strong></a>
```

Markdown equivalent:

```markdown
[**agent-identity-v1**](https://<canonical-spec-host>/agent-identity/v1/agent-signup) [**conformant**](https://<registry-host>/registry/README.md#2-entry-criteria)
```

> **Replace the placeholder hosts before publishing.** `https://<canonical-spec-host>/…` and
> `https://<registry-host>/…` are placeholders: until the canonical spec and registry hosts are
> live these links resolve nowhere, so a badge copied verbatim ships dead links. Substitute the
> real hosts (or the in-repo paths below) before you publish.

Both render as **agent-identity-v1 conformant**. The specification is not yet hosted at a final
canonical URL, so this repository is the **canonical location** (see the
[spec §1.3](../agent-identity-v1.md) and
[release notes](../release-notes-v1.1.0.md)); substitute the canonical URL for
the `<…>` placeholders once hosting exists. In-repo, the link targets are
[`agent-identity-v1.md`](../agent-identity-v1.md) and §2 of this document.

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
| Specification (`v1.2.0`) | [`../agent-identity-v1.md`](../agent-identity-v1.md) |
| Scope boundaries rulebook | [`../scope-boundaries.md`](../scope-boundaries.md) |
| Conformance + attestation validator guide | [`../validator.md`](../validator.md) |
| Registry schema | [`./implementations.schema.json`](./implementations.schema.json) |
| Implementation guide (new RPs) | [`../implementing-agent-identity-v1.md`](../implementing-agent-identity-v1.md) |
| Release notes (`v1.2.0`) | [`../release-notes-v1.2.0.md`](../release-notes-v1.2.0.md) |
| Release notes (`v1.1.0`) | [`../release-notes-v1.1.0.md`](../release-notes-v1.1.0.md) |
| Release notes (`v1.0.0`) | [`../release-notes-v1.0.0.md`](../release-notes-v1.0.0.md) |
| Machine-readable registry | [`./implementations.json`](./implementations.json) |

This repository is the **canonical location** of the specification until a rendered copy is hosted
at a final URL (spec §22). The protocol's `spec` discovery field stays **OPTIONAL** until then.
