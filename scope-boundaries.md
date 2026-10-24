# Identity vs Vendor Scope Boundaries

- **Status:** Normative scope rulebook. Companion to
  [`agent-identity-v1.md`](./agent-identity-v1.md).

This document is the rulebook the identity protocol must satisfy. It states what the identity protocol
owns, what the vendor owns, and the checklist any future change must pass before a new protocol field
is added.

---

## 1. The Boundary in One Sentence

The protocol proves **who** signed up, **on whose behalf**, **under which ToS**, **when**, and **with
what cryptographic proof**. Everything about **what the vendor sells and how to use its API** belongs
to the vendor, documented in a post-signup context guide — never in discovery or the signed receipt.

---

## 2. In-Scope / Out-of-Scope

### 2.1 In scope (broker / protocol)

| Area | Examples |
| :--- | :--- |
| Agent sub-identity registration and human binding | `identity_register`, agent ↔ verified human owner |
| Master Agent Delegation Agreement and delegated scopes | `delegation.scopes`, `tos:accept` |
| Agent Identity JWT assertions and JWKS verification | Contract A, issuer-hosted JWKS |
| MCP OAuth 2.1, MCP tools, agent reachability | `<agent>@<domain>` inbox, inbox tools |
| Relying Party discovery and brokered signup | `agent-signup.json`, `POST endpoints.agent_signup` |
| Delegated RP ToS acceptance | `terms`, `tos_acceptances`, hash verification |
| Identity-focused signup ledger and traceability | who/whom/which ToS/when/proof |
| Abuse reporting and universal revocation | Contract D.2, kill switch |
| Post-signup context pointer (identity-adjacent) | opaque `context.url` + `context.sha256` |
| Relying Party identity | provider account, origin/audience verification, RP signing keys, broker-issued attestation, RP-signed receipts, authenticated abuse identity |
| RP trust policy | trusted RP-broker list, per-RP `allow`/`warn`/`require`/`block`, assurance level display |

### 2.2 Out of scope (vendor responsibility)

| Area | Examples |
| :--- | :--- |
| Product catalogs, SKUs, pricing tiers, free-tier quotas | `instance_catalog`, product specs |
| Resource provisioning APIs and lifecycle | `/api/provision`, instances, endpoints |
| Resource credentials | vendor API keys for resources |
| Vendor API/SDK usage and operational runbooks | usage docs, error catalogs |
| Legacy email/OTP signup flows implemented by the vendor | `/api/signup/email`, `/api/signup/verify-otp` |
| Vendor admin dashboards and instance "nuke" mechanics | admin UI, instance actions |

### 2.3 The one-way door

- Vendor capabilities **MUST NOT** be represented as protocol surface in discovery, in the signed
  receipt (Contract E), in broker storage, in the broker UI, in MCP instructions, or in the
  implementation registry.
- Vendor capabilities remain available to the agent through the vendor's post-signup context guide.
- A document does **not** become conformant by hidden vendor data under `extensions`.

---

## 3. Naming Collision: "Provision"

"Provision" appears in two unrelated meanings. Conflating them is the root cause of much of the scope
creep.

| Phrase | Meaning | Verdict |
| :--- | :--- | :--- |
| "Auto-provision an **agent sub-identity**" | Broker-side `identity_register` / MCP context creating the agent's identity and binding it to a verified human. | **In scope.** Not scope creep. |
| "Provision a **compute instance**" | A cloud provider's `/api/provision` creating a resource (toaster, hamster wheel, bucket). | **Vendor scope.** Must never appear in protocol surface. |

Rule: if "provision" refers to an **agent identity**, it is identity protocol. If it refers to a
**resource**, it is vendor scope.

---

## 4. History

The boundary rules in this document were applied during the identity-only `v1.0.0` remediation of the
protocol. Internal records of that remediation — the audit findings, the finding-to-change map, and
the private repository paths involved — live in the private repository and are not part of this public
edition.

---

## 5. Do Not Over-Correct

Removing vendor capabilities from the protocol **MUST NOT** remove these in-scope features:

| Concept | Verdict |
| :--- | :--- |
| `identity_register` / "auto-provision" of an **agent sub-identity** | **In scope.** Different meaning of "provision". |
| Broker inbox, `inbox_wait_for_email`, OTP **reception**, human email forwarding | **In scope** (reachability). |
| Vendor OTP **endpoints** (`/api/signup/email`, `/api/signup/verify-otp`) | Vendor responsibility; may stay as a vendor feature, but leaves protocol discovery. |
| `POST /api/broker/report-abuse`, kill switch, revocation | **In scope.** |
| Agent/human identity, assertion/JWKS, MCP OAuth, master ToS + RP ToS acceptance | **In scope.** |
| "Signed-Up Services & Proof Ledger" as an **identity ledger** (which agent signed up with which vendor, which ToS, when, human email shared) | **In scope.** Only the vendor resource columns are not. |
| Vendor ToS text mentioning appliances/SKUs | **Harmless**; it is the vendor's own terms. |
| Vendor admin dashboards, nuke actions, storefronts | Vendor-owned; not protocol. |
| `provider_account_id` in the receipt | **In scope** as an opaque reference; not the start of a resource inventory. |

---

## 6. Relying Party Identity Is Identity

`v1.2.0` adds a second identity to the protocol: the relying party's own broker-issued identity. It
belongs here for the same reason the agent's identity does — it proves **who** the counterparty is,
not what they sell.

**In scope as protocol (RP identity):**

- the provider account that owns an origin: registration, origin/audience proof, and RP signing keys
  with proof of possession;
- the broker-issued RP attestation and its publication in the optional `rp_attestation` field;
- the provider API that issues and renews attestations (Contract H) and the broker metadata that
  advertises JWKS/status/abuse endpoints (Contract I);
- RP-signed receipts and authenticated receipt ingestion;
- the RP abuse-report signature and the human-visible trust/distrust policy.

**Out of scope as vendor responsibility (even when the RP is verified):**

- product catalogs, SKUs, pricing, free-tier quotas, and provisioning APIs;
- resource inventory, credential custody, instance lifecycle, and support tooling;
- a provider account's commercial terms, billing checkout, or pricing model;
- any per-provider capability list in discovery or the registry.

A **provider account is not an agent-facing discovery field**. It is the RP's private relationship
with its broker. Agents see the public attestation, the assurance level, and the trust decision; they
never need an account with the RP's broker, and assertion verification never requires one.

Verification is **identity**, not endorsement: a verified RP is a registered, origin-controlled entity,
not a safe, solvent, or well-behaved one. The registry keeps conformance (the document passes the
validator) separate from verification (a broker attestation and a recorded check), and an unverified
entry stays listed.

### 6.1 RP identity checklist additions

In addition to §7, every proposed RP-identity change **MUST** answer:

- [ ] Does it bind only identity (origin, audience, provider, keys), never terms, scopes, prices, or
      capability?
- [ ] Can an assertion still be verified without a vendor/provider account, SDK, or shared secret?
- [ ] Does it avoid leaking a vendor capability into discovery or the receipt?
- [ ] Does it avoid creating a second trust root or an implicit "verified means safe" claim?
- [ ] Does it keep the human kill switch (`revoked`) distinct from operator protective action
      (`suspended`)?
- [ ] Does it keep local verification the default, with enforcement opt-in for `allow`/`warn` and
      mandatory only for `require`?

## 7. Future-Change Review Checklist

Every proposed new protocol field or contract change **MUST** answer "yes" to at least one question
below. If it does not, it belongs in the vendor's `SKILL.md`, not in the protocol.

1. **Identity** — Does it prove or carry agent/human identity or binding?
2. **Delegation** — Does it express scope, authority, or the human-principal relationship?
3. **ToS** — Does it bind or verify acceptance of terms?
4. **Reachability** — Does it make the agent or human reachable for legal/compliance notices?
5. **Revocation** — Does it support abuse reporting, revocation, or the kill switch?
6. **Traceability** — Does it record, without vendor resource inventory, which agent signed up with
   which provider, under which ToS, when, and with what proof?

Additional gates:

- [ ] The change does not advertise a catalog, SKU, pricing, resource endpoint, credential, or vendor
      API usage.
- [ ] The change is not a vendor capability hidden under `extensions`.
- [ ] The change is additive within v1, or it introduces a new `protocol` value and path.
- [ ] The change does not weaken any security consideration in `agent-identity-v1.md` §20.
- [ ] The change is reflected consistently in the spec, the schema, the JSON Schema, the validator, and
      the reference implementation.

If an implementer believes a vendor field is unavoidable, they **MUST** document the concrete use case
in this document first and escalate — never add it silently to the protocol.

---

## 8. Allowed Vendor-Terminology Exceptions

Vendor terminology may remain **only** where it is clearly vendor-owned or historical:

| Surface | Why it may contain vendor terms |
| :--- | :--- |
| A vendor's own service code and data | Vendor-owned catalog, provisioning, OTP, admin, and post-signup guide. Must not leak into protocol surfaces. |
| A vendor's own database schema | Vendor-owned tables. |
| Historical migrations | Applied history; a later migration supersedes the vendor columns. Applied migrations are not edited. |
| Historical review and audit records (private repository) | Historical verification reports and audits describing the old state. |
| Current documents explicitly marked "superseded" | May describe old fields for context, but must say they are no longer protocol surface. |

Outside these exceptions, no vendor catalog/resource/capability field may appear in the shared
protocol package, broker protocol code or UI, current MCP instructions, current Contract D.1/E/F
definitions, the implementation guide, or the registry.

---

## 9. Authority & Escalation

- `agent-identity-v1.md` is the normative protocol specification; this document is the normative scope
  boundary. Where a proposed change is tempted to widen protocol surface, this document governs.
- The conformance validator is the objective enforcement mechanism; a document that advertises vendor
  capability fields is **not** conformant.
- Any conflict between a proposed change and these two documents **MUST** be resolved in favour of
  these documents, or escalated for a deliberate, documented decision.
