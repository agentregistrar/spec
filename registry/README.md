# `agent-identity-v1` Implementation Registry

- **Status:** Published.
- **Machine-readable registry (canonical source):** [`implementations.json`](./implementations.json)
- **Specification:** [`../agent-identity-v1.md`](../agent-identity-v1.md) — released as **v1.0.0** on 2026-10-17 ([release notes](../release-notes-v1.0.0.md)).
- **Conformance validator:** `src/validate-discovery.ts` — run as `pnpm validate:discovery <url-or-file> --json` ([validator guide](../validator.md)).
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

## 2. Entry criteria

1. **The identity-only validator passes** — `pnpm validate:discovery <discovery-url> --json` reports
   `valid: true` with `exitCode: 0` (warnings permitted, errors not).
2. **The discovery document is public and stable** — an HTTPS `/.well-known/agent-signup.json` on the implementation's canonical origin (spec §4), not a throwaway or per-deploy URL.
3. **The contact is reachable** — a security/abuse/legal contact (email or URL) that someone actually monitors.
4. **A post-signup context guide is published if the vendor has capabilities to document** — vendor features (catalog, provisioning, SKUs, API usage, errors) belong in that guide, not in discovery or this registry.

Meeting these criteria is a statement about the **discovery document only**. It is **not** a broker
endorsement of the implementation's product, security posture, uptime, or pricing (see §5).

**Reference-entry exception (documented, not a precedent).** The VaporCloud reference entry in §3
does not yet meet criterion 2 in full: its `discovery_url` is the **intended production** URL on an
illustrative `.example` origin, while its recorded validation ran against the **locally started**
reference implementation (`validator_evidence.source`). The entry is reproducible locally but not
yet re-validatable from the public internet. New third-party entries must meet criterion 2 as
written.

**Live re-validation (2026-10-18).** The deployed reference implementation was re-validated live with
the self-contained `@agentregistrar/discovery` validator —
`pnpm validate:discovery <discovery-url> --json --probe-jwks` — reporting `valid: true`, `exit 0`,
zero errors, zero warnings, 22 checks passed, and a passing issuer JWKS probe. This note does **not**
refresh the published entry: publishing the live demo URL awaits operator approval, so the VaporCloud
entry in §3 keeps its illustrative `.example` URLs and the reference-entry exception above remains in
force.

## 3. Registered implementations

The table below is kept **in lockstep** with [`implementations.json`](./implementations.json) — that
document is the canonical machine-readable source. Registry `capabilities` are **protocol**
capabilities only; vendor features are never listed.

| Implementation | Discovery URL | Audience | Protocol | Capabilities | Contact | Validated |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **VaporCloud** (reference) | `https://vaporcloud.example/.well-known/agent-signup.json` | `vaporcloud` | `agent-identity-v1` | `agent_signup`, `post_signup_context` | `security@vaporcloud.example` | 2026-10-17 |

Registry metadata (validator version, exact commands, and observed protocol/audience) lives in the
machine-readable file. Each entry's `validator_evidence` records the concrete command and result.

**Declared vs validated origin.** VaporCloud's `discovery_url` is the intended production discovery
URL for the reference implementation, while the recorded run in `validator_evidence.source`
validated the locally started reference implementation (`http://localhost:3001/…`). The entry is
reproducible locally but has not been re-validated from the public internet.

### Reference implementation: VaporCloud

VaporCloud is the reference Relying Party. Its identity-only discovery document is built to the
shared schema and served at `GET /.well-known/agent-signup.json`. Its vendor features (catalog,
provisioning API, legacy OTP fallback, admin actions) are documented in its post-signup guide at
`https://vaporcloud.example/docs/SKILL.md`, reached through the signed `context` pointer — they are
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
   [validator field reference](../validator.md#9---json-field-reference-for-the-implementation-registry)).
4. Update the table in §3 of this README so the two stay in lockstep.
5. The pull request is reviewed against the entry criteria in §2.

To update or remove an entry (for example after dropping `agent-identity-v1` support), submit a pull
request with the validator evidence for the change. An entry whose document no longer passes the
validator is removed.

## 5. Conformance badge

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
[release notes](../release-notes-v1.0.0.md)); substitute the canonical URL for
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

## 6. Canonical links

| Artifact | Location |
| :--- | :--- |
| Specification (`v1.0.0`) | [`../agent-identity-v1.md`](../agent-identity-v1.md) |
| Scope boundaries rulebook | [`../scope-boundaries.md`](../scope-boundaries.md) |
| Conformance validator guide | [`../validator.md`](../validator.md) |
| Implementation guide (new RPs) | [`../implementing-agent-identity-v1.md`](../implementing-agent-identity-v1.md) |
| Release notes (`v1.0.0`) | [`../release-notes-v1.0.0.md`](../release-notes-v1.0.0.md) |
| Machine-readable registry | [`./implementations.json`](./implementations.json) |

This repository is the **canonical location** of the specification until a rendered copy is hosted
at a final URL (spec §16). The protocol's `spec` discovery field stays **OPTIONAL** until then.
