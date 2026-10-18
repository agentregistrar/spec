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

Optional fields (§5.2): `spec`, `provider_url`, `contact`, `updated_at`, and non-capability
`extensions` keyed by reverse-DNS namespace. Nothing else. See the minimal example in §5.5 of the
spec; do not copy vendor fields from older docs.

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

## 5. Issue a signup receipt (Contract E) with identity facts + optional context

On success, return `200`/`201` with your provider credentials and, if you support it, a signed
`signup_token` (Contract E) plus the optional `context` pointer. The receipt is an
identity/attribution proof — keep it identity-only:

- Identity facts: `iss`, `sub`, `aud`, `jti`, `iat`, `exp`, `assertion_jti`, `service.*` (audience,
  provider name/URL, **opaque** `account_id`), `agent.*`, `human.*`, `tos.*`, `signed_up_at`.
- Remove vendor resource claims: **no** `service.instance_sku`, **no** `service.endpoint_url`, and no
  free-form resource metadata.
- Optional `context`: `{ "url": "https://…/docs/SKILL.md", "sha256": "sha256:…" }`.

`context.url` must be HTTPS (localhost dev exception), hash-pinned by `context.sha256`, and stay on
the **signup endpoint's registrable domain**; when `provider_url` is present it must share that
domain. The Broker validates the pointer **statically** and never fetches it. See
`agent-identity-v1.md` §11.

Deliver the receipt back to the Broker (`POST /api/broker/signup-receipt`, Contract F) and/or return
it to the agent, which records it with `identity_record_signup`. The Broker persists the context and
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

Exit codes: `0` valid, `1` invalid document, `2` could not fetch. The validator rejects vendor
capability fields at any depth (including under `extensions`) and recomputes the ToS hash. A
validator-passing document is the objective entry criterion for the implementation registry.

The validator is the source-first package `@agentregistrar/discovery` (`1.0.0`, **Apache-2.0**);
**npm publishing is pending** (the `@agentregistrar` scope is reservation-only), so run it from a
clone of this specification repository or through a pinned git dependency
(`github:agentregistrar/spec#v1.0.0`). There is no `bin` entry — always invoke it with
`pnpm validate:discovery`.

Optionally, non-destructively probe your issuers/endpoint:

```bash
pnpm validate:discovery https://your-service.example/.well-known/agent-signup.json --probe-jwks
pnpm validate:discovery https://your-service.example/.well-known/agent-signup.json --probe-endpoints
```

Probes never `POST`; they only check that the issuer publishes a usable JWKS and that
`endpoints.agent_signup` responds.

---

## 8. Adoption / registry conventions

The specification is released as **`v1.0.0` (2026-10-17)** — see
[`release-notes-v1.0.0.md`](./release-notes-v1.0.0.md) — and the adoption surface is published in
[`registry/README.md`](./registry/README.md) with the machine-readable registry in
[`registry/implementations.json`](./registry/implementations.json).

- The implementation registry lists only implementations whose discovery document passes the
  validator. Entry criteria: the validator passes, you publish a stable discovery URL, your
  abuse/security contact is reachable, and you publish a post-signup context guide if you have vendor
  capabilities to document.
- Registry `capabilities` are **protocol** capabilities only (`agent_signup`, `post_signup_context`).
  Vendor features are not registry capabilities; they live in your guide.
- Record your `discovery_url` and read `audience` / `protocol` from the validator's `--json` output
  (`validator.md` §9).
- To submit an entry, open a pull request against `registry/implementations.json` with your
  validator evidence; see [`registry/README.md`](./registry/README.md) §4. The conformance
  badge snippet and its usage terms are in §5 of the same document.

---

## 9. Common mistakes

- Copying the vendor-shaped Contract D.1 sample from older docs (catalog + provisioning endpoints).
- Hashing the rendered HTML page instead of the exact `terms.text` bytes.
- Trusting the agent's advertised `terms.sha256` without recomputing it from `terms.text`.
- Advertising `endpoints.verify_otp` / legacy OTP flows as protocol surface (they are your own
  feature; the Broker inbox is the in-scope reachability path).
- Returning vendor resource fields in the signed receipt instead of a `context` pointer.
- Putting a `context` pointer on a different domain from the signup endpoint.
- Treating `terms.text` or your guide as instructions the Broker will execute (they are data).
