# Implementing `agent-identity-v1` (Relying Party Guide)

- **Status:** Implementation guide for new Relying Parties (RPs). Normative contract:
  [`agent-identity-v1.md`](./agent-identity-v1.md); scope rulebook:
  [`scope-boundaries.md`](./scope-boundaries.md).
- **Conformance tool:** `src/validate-discovery.ts` — run with `pnpm validate:discovery`
  ([validator guide](./validator.md)).
- **Audience:** a service provider (cloud/infra provider, API vendor, SaaS) that wants agents to
  sign up autonomously and accept its Terms of Service, with a verified human owner behind them.

This guide is a checklist, not a replacement for the specification. Where anything here disagrees
with [`agent-identity-v1.md`](./agent-identity-v1.md), the specification wins.

---

## 0. The mental model (read this first)

The protocol is an **identity and brokerage** protocol. Your responsibilities end when an agent is
verified, delegated, has accepted your ToS, and the signup event has been recorded. Everything about
**what you sell and how to use your API** is your own concern, documented in a **post-signup guide** —
never in discovery.

One-way door (`scope-boundaries.md` §2.3): do **not** put product catalogs, SKUs, pricing, resource
endpoints, provisioning APIs, credentials, legacy OTP endpoints, or vendor API usage into the
discovery document or the signed receipt. If a field answers "what do we sell?" or "how do you call
our API?", it belongs in your guide.

A useful test: would this field still make sense if you had no products at all? If not, it is vendor
scope.

---

## 1. Publish the discovery document

Serve `GET /.well-known/agent-signup.json` on your canonical HTTPS origin:

- `200 OK`, `Content-Type: application/json` when you support `agent-identity-v1`.
- `404` (or `410`) when you do not. Never use `401`/`403` to signal non-support.
- `OPTIONS` → `204` with permissive CORS.
- `Cache-Control: public, max-age=60` (max `300`), `Access-Control-Allow-Origin: *`.
- Public only: no secrets, no internal hostnames, no personal data. Body ≤ 1 MiB.

Required fields (`agent-identity-v1.md` §5.1): `protocol` (`"agent-identity-v1"`), `audience`,
`provider_name`, non-empty `issuer_allowlist`, unique `required_scopes` (including `tos:accept`),
`terms` (complete `text` + `version` + `url` + `sha256`), and `endpoints.agent_signup`.

Optional fields (§5.2): `spec`, `provider_url`, `contact`, `updated_at`, non-capability `extensions`
keyed by reverse-DNS namespace, and the optional `rp_attestation` compact JWS (§10 of this guide).
Nothing else. See the minimal example in §5.5 of the spec; do not copy vendor fields from older docs.

### Forbidden fields (§5.3)

At **any** nesting depth, including under `extensions`, a conformant document must not contain
`instance_catalog`, `endpoints.provision`, `endpoints.email_signup`, `endpoints.verify_otp`,
`endpoints.broker_signup_receipt`, SKUs/pricing/tiers/quotas, or any resource/credential/API-usage
metadata. Moving a capability under `extensions` does **not** make it conformant.

---

## 2. Compute and maintain the ToS hash

- `terms.sha256` is `sha256:<64 lowercase hex>` over the **exact UTF-8 bytes of `terms.text`** — no
  trimming, no newline normalization, no HTML extraction.
- `terms.text` is the **complete** agreement the agent is accepting, not a summary.
- `terms.url` is an absolute HTTPS page where a human can read the same text.
- Bump `terms.version` whenever the text changes materially, and update `text`, `sha256`, and `url`
  **atomically**.
- The agent recomputes the hash from `terms.text` before calling its Broker; your signup endpoint
  must reject an assertion whose `delegation.accepted_rp_tos_hash` is not the currently advertised
  `terms.sha256` (`tos_hash_mismatch`).

You may keep a short, explicitly documented grace period for in-flight assertions after a change,
but the discovery document advertises **only** the current version, and the grace period must be
documented **outside** discovery (e.g. in your guide or a support page).

---

## 3. Verify the assertion and enforce the checks

`POST endpoints.agent_signup` receives `Authorization: Bearer <agent-identity-assertion>`. The
assertion is Contract A (Ed25519 JWT); you only verify it here. Enforce at minimum
(`agent-identity-v1.md` §7.1):

1. Signature verifies against `GET <iss>/.well-known/jwks.json` (issuer-hosted only — never a
   `jku`/`x5u` header pointing elsewhere).
2. `iss` is in `issuer_allowlist` (exact match).
3. `aud` equals your `audience`.
4. `exp` has not passed (allow at most 60s skew) and the lifetime is reasonable (≤ 5 min).
5. `jti` has not already been used for an account creation.
6. `delegation.scopes` includes every `required_scopes` entry.
7. `human.verified === true`.
8. `delegation.accepted_rp_tos_hash === terms.sha256`.

Record the assertion `jti`, the accepted ToS version/hash, and attribution for audit. Revocation is
enforced by the Broker at minting time; you do not need a revocation feed for v1.

---

## 4. Return stable error codes

Return errors as JSON with a stable machine-readable code (`agent-identity-v1.md` §7.2):

```json
{ "error": "tos_hash_mismatch", "error_description": "…", "retryable": false }
```

The v1 codes are `invalid_request` (400), `invalid_assertion` (401), `issuer_not_allowed` (403),
`audience_mismatch` (403), `assertion_expired` (401), `assertion_replayed` (409),
`tos_hash_mismatch` (409), `insufficient_scope` (403), `human_unverified` (403), and `rate_limited`
(429). `error_description` is non-normative and must not be parsed for control flow. The invariant:
an agent can tell "retry", "re-consent ToS", "get a fresh assertion", and "unsupported" apart
without reading prose.

---

## 5. Issue a signup receipt (Contract E v1.2) with identity facts + optional context

On success, return `200`/`201` with your provider credentials and, if you support it, a **receipt
signed by your own RP key** (Contract E) plus the optional `context` pointer. The receipt is an
identity/attribution proof — keep it identity-only:

- Identity facts: `iss` (your origin), `aud` (the human broker issuer), `sub` (agent id), `jti`
  (`srp_…`), `iat`, `signed_up_at`, `assertion_jti`, `service.*` (audience, **origin**, provider
  name/URL, **opaque** `account_id`, `attestation_jti`, `key_id`), `agent.*`, `human.*`, `tos.*`.
- **No `exp`.** A receipt is a historical fact, not an access token. A legacy `exp` is ignored if
  present; never rely on it for access control.
- Remove vendor resource claims: **no** `service.instance_sku`, **no** `service.endpoint_url`, and no
  free-form resource metadata.
- Optional `context`: `{ "url": "https://…/docs/SKILL.md", "sha256": "sha256:…" }`. When `context` is
  present, both fields are required: a URL without a hash cannot be pinned, and a hash without a URL
  cannot be fetched.

Sign with the key in your attestation named by `service.attestation_jti`; `service.key_id` must name
that key, the JWS header `kid` must equal `service.key_id`, and the key must carry the `receipt`
purpose. `service.origin` must equal `iss` and the attestation `rp.origin`; `service.audience` must
equal the attestation `rp.audience`.

The receipt is valid when **both** `iat` and `signed_up_at` fall inside the attestation's
`[iat, exp]` window — even if you send it later. Keep the attestation that was current at signing and
send that **exact** JWS; never substitute your newer attestation. Receipts are idempotent forever on
`jti`; a same-`jti` different body is `409 signup_conflict`.

`context.url` must be HTTPS (localhost dev exception), hash-pinned by `context.sha256`, and stay on
the **signup endpoint's registrable domain**; when `provider_url` is present it must share that
domain. The Broker validates the pointer **statically** and never fetches it. See
`agent-identity-v1.md` §11.

Deliver the receipt back to the Broker as described in §12. The Broker persists the context and
returns `context_url` / `context_sha256` so the agent can fetch the guide itself.

### 5.1 Resolve & recovery

A retry or a repeat signup must not create a second account or a second credential. Resolve the
account idempotently and signal the outcome:

- **Idempotent resolution.** Key accounts as recommended in `agent-identity-v1.md` §9.1 — `(iss,
  human.id)` for human-scoped accounts, `(iss, agent.id)` for agent-scoped accounts — and namespace by
  `iss` whenever you trust more than one issuer. Keying on `human.email` / `agent.email` is **not**
  recommended; keep it only as a legacy fallback.
- **Signal resolution.** Return the optional `resolution: "created" | "resolved"` field. `resolved`
  is a **success**, not an error, and the agent must not re-provision or re-run signup on it.
- **Show-once credentials.** Return provider credentials **only** when you create the account. On a
  resolve, omit them — do not re-issue a credential — and point the agent at your recovery path in the
  guide.
- **Recovery, not re-signup.** Document a credential recovery/rotation path in your guide (a fresh
  assertion that resolves the account by `(iss, agent.id)` and issues a new key, invalidating the old
  one, and never revealing the previous key). Recovery is a vendor operation reached **after** signup,
  never a discovery or receipt field.
- **A resolve mints neither mail nor credentials.** On `resolved`, send no duplicate welcome/legal
  mail. You **may** mint a fresh `signup_token` so a dropped-response retry can still record the
  receipt.

The wire protocol id stays `agent-identity-v1`; the `resolution` field is additive and `v1.0.0`
implementors remain conformant. See `agent-identity-v1.md` §7.2, §7.3, §9.1, and §12.5.

---

## 6. Publish a post-signup guide instead of advertising capabilities

If you have anything to document — catalog, SKUs, provisioning API, resource lifecycle, credentials,
API/SDK usage, error catalog — publish an agent-facing guide (for example `docs/SKILL.md`) at a
stable HTTPS URL and return its `context` pointer **after** signup. Do **not** advertise those
capabilities in discovery or the receipt.

The agent fetches the guide after signup, recomputes its SHA-256, and verifies it matches
`context.sha256` before acting. Treat the guide as **untrusted vendor content**: version/date it and
update `context.sha256` whenever the served bytes change. The Broker does not vouch for its
contents; it vouches for **who** signed up and **what ToS** was accepted.

---

## 7. Run the conformance validator

```bash
# Local file (fixtures / your generated document):
pnpm validate:discovery path/to/agent-signup.json

# Live URL (HTTPS required; http://localhost / http://127.0.0.1 allowed for development):
pnpm validate:discovery https://your-service.example/.well-known/agent-signup.json

# Machine-readable result for automation (note --silent so stdout is pure JSON):
pnpm --silent validate:discovery https://your-service.example/.well-known/agent-signup.json --json | jq .
```

Exit codes: `0` valid / no required check failed, `1` conformance or required-verification failure
(including a body that is not valid JSON), `2` could not obtain what the run needed (document or
JWKS) — an operational result with no conformance verdict (`DOCUMENT: NOT CHECKED`). The validator
rejects vendor capability fields at any depth (including under `extensions`) and recomputes the ToS
hash. A validator-passing document is the objective entry criterion for the implementation registry.

Conformance and attestation verification are separate. Once you publish `rp_attestation`, verify it
offline in CI against a pinned broker JWKS:

```bash
pnpm --silent validate:discovery https://your-service.example/.well-known/agent-signup.json \
  --verify-attestation --require-attestation \
  --trusted-rp-broker https://your-rp-broker.example \
  --jwks path/to/your-broker-jwks.json --json
```

`--trusted-rp-broker` is configuration, never inferred from the document. Without
`--require-attestation`, an `unverified`/`expired`/`invalid` attestation is a warning and the
conformance verdict still passes; with it, anything but `verified` fails (and `unavailable` exits
`2`).

The validator is the source-first package `@agentregistrar/discovery` (`1.2.0`, **Apache-2.0**).
The `v1.2.0` tag publishes it to npm; until that tag exists `npm dist-tags.latest` is `1.1.0`, so run
it from a clone of this specification repository, or after the tag exists use the pinned git
dependency (`github:agentregistrar/spec#v1.2.0`). There is no `bin` entry — always invoke it with
`pnpm validate:discovery`.

Optionally, non-destructively probe your assertion issuers/endpoint:

```bash
pnpm validate:discovery https://your-service.example/.well-known/agent-signup.json --probe-jwks
pnpm validate:discovery https://your-service.example/.well-known/agent-signup.json --probe-endpoints
```

Probes never `POST`; they only check that the assertion issuer publishes a usable JWKS and that
`endpoints.agent_signup` responds. `--probe-jwks` does not fetch the RP-broker JWKS; that happens only
under `--verify-attestation`.

---

## 8. Adoption / registry conventions

The specification release **`v1.2.0`** is targeted for **2026-10-24** — see
[`release-notes-v1.2.0.md`](./release-notes-v1.2.0.md). This branch is the reviewed artifact, not the
publication: the tag and npm release follow the merge. Earlier releases: **`v1.1.0`**
(2026-10-18, [`release-notes-v1.1.0.md`](./release-notes-v1.1.0.md)) and the initial **`v1.0.0`**
(2026-10-17, [`release-notes-v1.0.0.md`](./release-notes-v1.0.0.md)). The adoption surface is
published in
[`registry/README.md`](./registry/README.md) with the machine-readable registry in
[`registry/implementations.json`](./registry/implementations.json).

- The implementation registry lists only implementations whose discovery document passes the
  validator. Entry criteria: the validator passes, you publish a stable discovery URL, your
  abuse/security contact is reachable, and you publish a post-signup context guide if you have vendor
  capabilities to document.
- Registry `capabilities` are **protocol** capabilities only (`agent_signup`, `post_signup_context`).
  Vendor features are not registry capabilities; they live in your guide.
- Record your `discovery_url` and read `audience` / `protocol` from the validator's `--json` output
  (`validator.md` §12).
- To submit an entry, open a pull request against `registry/implementations.json` with your
  validator evidence; see [`registry/README.md`](./registry/README.md) §4. The conformance
  badge snippet and its usage terms are in §5 of the same document.

---

## 9. Register as a provider, prove the origin, and register a key

Relying Party identity (Contract G) is optional for conformance but required for a verified profile,
authenticated receipts, and abuse standing. The full wire contract is `agent-identity-v1.md` §15.

1. **Create a provider account with your RP broker.** The account is an organization, separate from
   any individual human login. It starts `pending`; it becomes `active` when its first origin is
   verified.
2. **Register the origin and audience.** `POST /api/provider/v1/origins` with the canonical origin
   and the `audience` you publish in discovery. The audience is unique across the broker's providers;
   a collision is `409 audience_conflict` and needs operator review, not a second name.
3. **Prove control of the origin** with an HTTPS well-known file or a DNS TXT record. The challenge is
   single-use with a 30-minute TTL: serve `file_content` exactly at `file_url` (one optional trailing
   LF), or publish `record_value` at `record_name`. The broker fetches with HTTPS-only, public-IP,
   no-cross-origin-redirect, 5-second, 64 KiB rules.
4. **Generate an Ed25519 keypair locally and keep the private key.** Register the public key with a
   proof of possession: request a `kid`-bound challenge, then sign the PoP JWS with
   `typ: agent-rp-key-pop+jwt`, `aud` = the broker issuer, `sub` = your provider UUID, the challenge
   as `nonce`, and your public JWK. The broker never sees your private key.
5. **Keep a rotation path.** Add the new key, let both appear in attestations for the 30-day overlap,
   then retire the old one. Revocation is immediate; old receipts still verify from the attestation
   they name.

Provider API keys are separate from your RP signing key: they authenticate CI to Contract H, are
scoped, hashed at rest, and never sign receipts or abuse reports.

---

## 10. Publish and renew the attestation

`POST /api/provider/v1/attestation` returns a compact JWS plus its metadata. Publish the JWS verbatim
as `rp_attestation` in `/.well-known/agent-signup.json`.

- The attestation `rp.origin` must equal the origin serving discovery and `rp.audience` must equal
  `audience`. Publishing a copy on another host does not move the binding.
- `exp = iat + 86400`. Renew on a **12-hour target** so one missed cycle is tolerable. A renewal mints
  a new `jti`; keep serving the current one and keep the previous one long enough to submit with any
  receipt signed under it.
- Do not put terms, scopes, endpoints, prices, or `provider_url` in the attestation. It is identity.
- An expired attestation is `expired`, not `unverified`, and a `require` policy will refuse it. An
  absent field is conformant and `unverified`.
- If you operate a *broker* as well, serve `/.well-known/agent-broker.json` and the signed status
  endpoint described in `agent-identity-v1.md` §16.

> **Claim sources (non-normative; Issue 07 mapping).** When a broker assembles the claims, each field
> is copied from the provider record rather than typed free-form: `rp.origin` from
> `provider_origins.origin`; `rp.audience` from `provider_origins.audience`; `rp.name` from
> `provider_origins.provider_name`; `rp.legal_name` from `provider_accounts.legal_name` (required only
> at `entity`); `rp.contact.email` from `provider_accounts.contact_email`; `rp.contact.name` from
> `provider_accounts.name`; `rp.verification.origin_verified_at` from
> `provider_origins.verified_at`; `rp.verification.method` from
> `provider_origins.verification_method`; `rp.verification.level` is `entity` only when
> `provider_accounts.entity_reviewed_at` is non-null (operator review) with a legal name present, and
> `rp.verification.entity_reviewed_at` is that same timestamp (`null` at `domain`).
> `provider_origins.contact`, when present, is a human-facing security/contact URL and is **not**
> copied into the attestation. This mapping is explanatory; `agent-identity-v1.md` §14.1 is
> normative.

Test offline before publishing:

```bash
pnpm --silent validate:discovery path/to/agent-signup.json \
  --verify-attestation --require-attestation \
  --trusted-rp-broker https://your-broker.example \
  --jwks path/to/your-broker-jwks.json --json
```

`--jwks` pins one issuer's JWKS for an offline run; `--at` freezes the clock for a fixture.

---

## 11. Sign receipts with your RP key (Contract E v1.2)

See §5. The three rules implementers most often get wrong:

1. **`exp` is gone.** Do not gate account access on the receipt. A receipt proves a past signup.
2. **The key comes from the attestation.** `service.key_id` must be in the `keys[]` of the
   attestation named by `service.attestation_jti`, with `receipt` in its purposes, and the JWS header
   `kid` must equal `service.key_id`. There is no broker-key fallback.
3. **The attestation is historical.** Keep the exact attestation you signed under. A receipt is
   accepted when `iat` and `signed_up_at` fall inside that attestation's window, even if you submit
   it after the attestation expired.

---

## 12. Deliver the receipt to the broker (Contract F)

`POST /api/broker/signup-receipt` with:

```json
{ "signup_token": "<your compact receipt JWS>", "rp_attestation": "<the exact attestation JWS>" }
```

Both fields are required; `signup_token` is the receipt. The broker verifies your attestation
(including that its `iss` is trusted by that human or by the broker default), checks the receipt
window against the attestation using the **signing** time, verifies your key and binding, resolves the
assertion acceptance, and records `proof_source: "rp_callback"`.

The MCP Tier 2 path (`identity_record_signup`) carries the same two values; if the agent omits the
attestation, the broker fetches discovery at `service.origin` and requires the presented attestation's
`jti` to equal `service.attestation_jti`. A duplicate returns the existing row with
`deduplicated: true`; a same-`jti` different body is `409`.

| What went wrong | Response |
| :--- | :--- |
| Attestation broken or bound to another origin/audience | `401 invalid_attestation` |
| Attestation issuer not trusted | `401 rp_broker_untrusted` (checked before any JWKS fetch) |
| Receipt broken or badly signed | `401 invalid_signup_token` |
| Receipt signed outside the attestation window | `401 attestation_not_valid_at_signing` |
| Exact attestation no longer retrievable | `401 attestation_unavailable` (never a silent substitution) |
| Broker metadata/JWKS outage | `503 rp_broker_unavailable` (retryable) |

---

## 13. Report abuse with standing (Contract D.2)

Post `{"rp_attestation": "<JWS>", "report": "<JWS>"}` where the report is signed by your RP key with
`typ: agent-rp-abuse+jwt`, `iss` = your origin, `aud` = the human broker's issuer, `jti: abr_…`,
`exp = iat + 300`, the `agent_id`, a 1–500 character `reason`, and optional evidence
(`assertion_jti`, `signup_token_jti`).

Your attestation must be **current at report time**; the five-minute report bound is never extended.
A report is `verified` only if it links to a signup whose proof source is `rp_callback` or `rp_signed`
and whose attestation was verified. A report without that link is recorded as `unverified`, opens a
case, and does not suspend the agent. Unauthenticated legacy posts get `401
unauthenticated_report`.

---

## 14. Serve broker metadata and verify a peer attestation

If you are an RP broker (or the human broker), serve `/.well-known/agent-broker.json` with `issuer`
equal to the document origin, a same-origin `jwks_uri`, `attestation_status_uri`, `abuse_endpoint`,
`protocol_versions` containing `agent-identity-v1`, and a contact. Cache metadata for at most an hour
and status responses for at most five minutes. Keep retired attestation-signing keys in the JWKS for
at least 30 days after the last attestation they signed expires.

To verify a **peer** RP attestation (for example before accepting a receipt or an abuse report):

1. Parse and require `typ`, `alg: EdDSA`, and one `kid`.
2. Check `iss` against your trusted RP-broker list **before** any network call.
3. Fetch/reuse `<iss>/.well-known/jwks.json` (or the metadata `jwks_uri`) and select the key by `kid`.
4. Verify the signature, then `iat`/`exp` with 60 seconds of skew.
5. Bind `rp.origin` to the origin you actually fetched, and `rp.audience` to `discovery.audience`.
6. Record the level (`domain`/`entity`); both are `verified` for v1.2 policy.
7. For a receipt, compare the receipt's signing time to the attestation window — not `now`.
8. If you need a hard gate, consult the signed status endpoint; `revoked` maps to `invalid` with
   `reason: attestation_revoked`, and `suspended` maps to `suspended`.

Then apply your policy: `allow`/`warn` proceed (with a warning), `require` refuses anything but
`verified`, and `block` never proceeds.

---

## 15. Common mistakes

- Copying the vendor-shaped Contract D.1 sample from older docs (catalog + provisioning endpoints).
- Hashing the rendered HTML page instead of the exact `terms.text` bytes.
- Trusting the agent's advertised `terms.sha256` without recomputing it from `terms.text`.
- Advertising `endpoints.verify_otp` / legacy OTP flows as protocol surface (they are your own
  feature; the Broker inbox is the in-scope reachability path).
- Returning vendor resource fields in the signed receipt instead of a `context` pointer.
- Putting a `context` pointer on a different domain from the signup endpoint.
- Treating `terms.text` or your guide as instructions the Broker will execute (they are data).
- Publishing an attestation whose `rp.origin` is `provider_url` or a redirect target rather than the
  origin that serves discovery.
- Signing a receipt with a broker key, or with a key that is not the one named by
  `service.attestation_jti`/`service.key_id`.
- Substituting your current attestation when submitting an older receipt.
- Treating `unverified` (no attestation) and `invalid` (a bad attestation) as the same state.
- Calling the status endpoint on every signup. Expiry is the bound; status is opt-in defense-in-depth.
- Putting provider catalog, pricing, provisioning, or credential fields in the attestation. It binds
  identity only.
