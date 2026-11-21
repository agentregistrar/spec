# Release Notes — `agent-identity-v1` `v1.3.0`

- **Protocol identifier:** `agent-identity-v1` (unchanged)
- **Specification version:** `v1.3.0`
- **Release date:** 2026-11-13
- **Normative specification:** [`agent-identity-v1.md`](./agent-identity-protocol.md)
- **Change process:** [`release-notes-v1.0.0.md`](./release-notes-v1.0.0.md) §3
- **Previous release:** [`release-notes-v1.2.0.md`](./release-notes-v1.2.0.md)

`v1.3.0` is the **attestation source** release. It is a **breaking change to the discovery document**
and a no-op for the signed attestation: the embedded `rp_attestation` field is removed and replaced by
one OPTIONAL `attestation` object (`mode`, `uri`) that names a stable URL serving
`{ "attestation": "<compact JWS>" }`. The attestation JWT, its claims, signature, key snapshot,
24-hour lifetime, `aud`, and origin/audience binding are unchanged. The Contract F receipt/abuse bodies
keep the field name `rp_attestation` and are unchanged.

There is **no compatibility field, embedded fallback, dual publication, or alias**. A document that
still contains `rp_attestation` is non-conformant, and the validator reports
`field.rp_attestation` / `rp_attestation_removed`.

---

## 1. What `v1.3.0` changes

| Surface | Change | Where |
| :--- | :--- | :--- |
| **Discovery (D.1)** | `rp_attestation` (compact JWS) is removed. One OPTIONAL `attestation` object remains: `{ "mode": "broker" \| "provider", "uri": "<stable absolute HTTPS URL>" }`. Absence is conformant and means **unverified**. | §5.2, §5.4 |
| **Attestation source** | The URI serves `{ "attestation": "<compact JWS>" }` as `application/json`; additional fields are ignored; a raw JWT body is rejected. A new `attestation-source.schema.json` publishes the shape. | §5.4.1, §14.4, `attestation-source.schema.json` |
| **Broker-managed mode** | Default. The broker hosts and renews the token at a stable verification endpoint (`GET /api/broker/provider-verification?origin=…&audience=…`) and renews on demand when ≤12 hours remain. Typed `400`/`403`/`404`/`410`/`429`/`5xx` answers are verification results. Positive responses cache at most five minutes; negative responses never cache. | §14.5 |
| **Provider-managed mode** | Advanced opt-in. The provider hosts the same source document at a stable URL on its discovery origin or a subdomain, renews through Contract H, and `exp` is the revocation bound (a suspension may not be visible until expiry). A third-party CDN host is not permitted in this release. | §14.6 |
| **URI rules** | `attestation.uri` is a stable, absolute HTTPS URL with no userinfo and no fragment (`http://localhost` / `http://127.0.0.1` is the development exception). A `broker` URI origin must be in `issuer_allowlist` (and a trusted broker origin when a trusted list is configured); a `provider` URI origin must be the discovery origin or a subdomain of it. | §5.4 |
| **Removed carrier** | A document containing `rp_attestation` is non-conformant with the stable reason `rp_attestation_removed`. | §5.2, §14.7 |
| **Validator** | New conformance checks (`field.attestation.mode`, `field.attestation.uri`, `field.attestation.binding`, `field.rp_attestation`), frozen verification reasons, mode-aware `--json` fields (`mode`, `source_uri`, `expires_at`), and the fixture-only `--source-response` flag. `VALIDATOR_VERSION` and the package version are `1.3.0`. | §19, [`validator.md`](./validator.md) |
| **Fixtures** | The old `valid-attested-*` fixtures are replaced by broker, provider, absent, invalid-mode, relative/HTTP/userinfo/fragment URI, broker/provider wrong host, removed-field, typed `403`/`404`/`410`/`503`, and expired-source rows. | [`fixtures/README.md`](./fixtures/README.md) |

### 1.1 Discovery shape

Broker-managed (default):

```json
{
  "attestation": {
    "mode": "broker",
    "uri": "https://agentregistrar.dev/api/broker/provider-verification?origin=https%3A%2F%2Fprovider.example&audience=example"
  }
}
```

Provider-managed:

```json
{
  "attestation": {
    "mode": "provider",
    "uri": "https://provider.example/.well-known/agent-rp-attestation.json"
  }
}
```

Both are complete: the token is not in discovery. A document that omits `attestation` is conformant
and unverified.

### 1.2 Source document

```json
{ "attestation": "<compact JWS>" }
```

Served as `application/json`. Additional fields are ignored; a raw `application/jwt` body or a bare
JWS is rejected. The envelope is not signed, so the JWS remains the only trust anchor.

---

## 2. Breaking change and provider migration

This is a breaking discovery release with a short, coordinated cutover. There is no supported
mixed-version state: the new client does not read `rp_attestation`, and the validator rejects it.

Migration steps for a relying party:

1. **Decide the publication mode** per origin/audience pair.
   - **Broker-managed (recommended default):** ask the broker for the verification URL, or read it from
     the portal. Publish it verbatim. The broker hosts and renews the token; you need no cron, no
     renewal job, and no redeploy. Leave the URI unchanged across renewals.
   - **Provider-managed (advanced):** register the stable HTTPS source URL on your own origin or a
     subdomain. Renew through `POST /api/provider/v1/attestation` on the 12-hour target against the
     24-hour expiry, and write the returned `attestation` JWS into
     `{ "attestation": "<JWS>" }` at that URL. Keep serving the current token until the new one is
     published, and never serve an empty document.
2. **Republish `/.well-known/agent-signup.json`** with the `attestation` object and **without**
   `rp_attestation`. If you have no attestation, omit the object entirely; that is conformant.
3. **Validate the document** with the new validator:
   `pnpm validate:discovery <url> --verify-attestation --require-attestation --trusted-rp-broker <origin>`.
   A typed broker failure is a verification result and does not make the document non-conformant.
4. **Keep sending the exact attestation with receipts and abuse reports.** Contract F and D.2 still use
   the request-body field `rp_attestation`; only discovery changed.
5. **Update docs, fixtures, and CI** that copied the embedded JWS or asserted `rp_attestation` in
   discovery. Use the new fixture matrix and `--source-response` for offline checks.

A provider that has not migrated is simply non-conformant (its document still contains the removed
field). Deploy the broker and providers back-to-back and record the window; rollback is coordinated
because a provider-only rollback reintroduces a rejected document.

---

## 3. Compatibility and explicit non-changes

- **Unchanged:** the protocol id `agent-identity-v1`; the Contract G JWT header (`typ:
  agent-rp-attestation+jwt`, `alg: EdDSA`), every claim in §14.1, the Ed25519 signature and key
  snapshot, the 24-hour `exp - iat = 86400` lifetime, `aud: agent-identity-v1`, and the origin/audience
  binding; Contract E receipts; Contract H provider API; Contract I broker metadata and signed status.
- **Unchanged: Contract F receipt ingestion.** The body is still
  `{ "signup_token": "<JWS>", "rp_attestation": "<exact attestation JWS>" }`, and the broker still
  verifies the exact attestation named by `service.attestation_jti` in historical mode.
- **Unchanged: Contract D.2 abuse reporting.** The body is still
  `{ "rp_attestation": "<JWS>", "report": "<JWS>" }`.
- **Changed:** only the discovery carrier, the new source document, the validator's checks/flags, and
  the mode-specific publication guidance.
- **Not provided:** a compatibility field, an `rp_attestation` fallback, dual publication, an alias,
  or a second token format. `v1.2.0` discovery documents are no longer conformant.
- **Not in this release:** a third-party CDN host for provider-managed attestations (deferred), a
  multi-broker list in discovery, a scheduled broker renewer, and a first-class `revoked` verification
  status (`revoked` is `invalid` with reason `attestation_revoked`).

---

## 4. Validator behavior

The validator keeps its two independent results: **document conformance** and **attestation
verification**. Conformance never requires a live broker.

### 4.1 Conformance checks and reasons

| Check id | Reason on failure |
| :--- | :--- |
| `field.attestation.mode` | `attestation_mode_invalid` |
| `field.attestation.uri` | `attestation_uri_invalid` |
| `field.attestation.binding` | `attestation_uri_host_untrusted` (broker) \| `attestation_uri_host_unbound` (provider) \| `attestation_binding_unchecked` (skip: no fetch origin) |
| `field.rp_attestation` | `rp_attestation_removed` |

### 4.2 Verification reasons

`absent`, `not_checked`, `field_malformed`, `binding_failed`, `attestation_expired`,
`origin_unverifiable`, `provider_suspended`, `attestation_not_found`, `attestation_revoked`,
`invalid_request`, `rate_limited`, `broker_unavailable`, `source_unavailable`,
`source_document_invalid`, `source_response_unreadable`, `attestation_issuer_mismatch`,
`source_uri_invalid`, plus the unchanged JWT reasons (`jws_parse`, `wrong_typ`, `wrong_alg`,
`missing_kid`, `claims_invalid`, `unknown_kid`, `duplicate_jwk_kid`, `bad_signature`, `not_yet_valid`,
`wrong_origin`, `wrong_audience`, `audience_unverifiable`, `rp_broker_untrusted`,
`rp_broker_unavailable`).

Statuses are unchanged: `verified`, `unverified`, `attested_untrusted_broker`, `invalid`, `expired`,
`unavailable`, `suspended`, plus validator-only `not_checked`.

### 4.3 Flags and exit codes

| Flag | Behavior |
| :--- | :--- |
| `--verify-attestation` | Fetch and verify the source named by `attestation.uri`. Absent object → `unverified`, exit unchanged; present object without the flag → `not_checked`. |
| `--require-attestation` | Implies `--verify-attestation`; a non-`verified` result fails the run (`unavailable` exits `2`). |
| `--trusted-rp-broker <issuer>` | Repeatable trusted-broker identity list (env fallback `AGENT_IDENTITY_TRUSTED_RP_BROKERS`). Distinct from the document's `issuer_allowlist`, which is a host binding. |
| `--jwks <path-or-url>` | Pin exactly one issuer's JWKS for offline runs; never bypasses signature checks. |
| `--at <rfc3339\|epoch>` | Freeze the clock for deterministic fixture runs. |
| `--source-response <path>` | **Fixture-only offline testing:** inject `{ status, body, contentType? }` instead of fetching. No network I/O; the body is never echoed. |

Exit `0`: conformant and no required check failed. Exit `1`: a conformance error (including a malformed
`attestation` object, a failed host binding, or a present `rp_attestation`) or a required verification
failure. Exit `2`: the run could not obtain what it needed (document, JWKS, or source) and there is no
conformance verdict (`DOCUMENT: NOT CHECKED`). A typed broker `403`/`404`/`410` is never a conformance
failure; `403` is `suspended`, `404` is `unverified`, `410` is `invalid` with reason
`attestation_revoked`, and `429`/`5xx` are `unavailable`.

Full flag, `--json`, and reason-code reference: [`validator.md`](./validator.md).

---

## 5. Validation evidence

No test framework is added (`AGENTS.md`). Evidence is the manual harnesses and the documented fixture
runs, all executed from this branch:

| Check | Command | Result |
| :--- | :--- | :--- |
| Typecheck | `pnpm typecheck` | exit `0`, no diagnostics |
| Fixture matrix | `pnpm --silent validate:fixtures` | `Summary: 79 passed, 0 failed`, exit `0` |
| Registry | `pnpm --silent validate:registry` | `RESULT: VALID — 0 error(s), 0 warning(s), exit 0` |
| Broker-managed fixture | `valid-attestation-broker.json` + `--source-response attestation-sources/ok-broker.json` + pinned JWKS + `--at 2026-10-24T00:00:00Z` | `verified`, mode `broker`, level `domain`, `DOCUMENT: VALID`, exit `0` |
| Provider-managed fixture | `valid-attestation-provider.json` + `--source-response attestation-sources/ok-provider.json` + pinned JWKS + trusted broker + `--at 2026-10-24T00:00:00Z` | `verified`, mode `provider`, `DOCUMENT: VALID`, exit `0` |
| Typed broker `403` | injected `forbidden-403-provider-suspended.json` | `suspended` / `provider_suspended`, conformance `true`, exit `0` |
| Typed broker `404` | injected `not-found-404-attestation-not-found.json` | `unverified` / `attestation_not_found`, conformance `true`, exit `0` |
| Typed broker `410` | injected `gone-410-attestation-revoked.json` | `invalid` / `attestation_revoked`, conformance `true`, exit `0` |
| Typed broker `503` | injected `unavailable-503-broker-unavailable.json` | `unavailable` / `broker_unavailable`, conformance `true`, exit `0` |
| Removed carrier | `invalid-rp-attestation-removed.json` | conformance failure, `field.rp_attestation` / `rp_attestation_removed`, exit `1` |
| Absent source | `valid-minimal.json` | `unverified` / `absent`, exit `0`; exits `1` under `--require-attestation` |
| No fetch origin | `unverifiable-attestation-no-origin.json` | binding `skip` / `attestation_binding_unchecked`, `unavailable` / `origin_unverifiable`, exit `0` |
| Expired source | `valid-attestation-expired.json` + expired source + `--at 2026-11-30T00:00:00Z` | `expired` / `attestation_expired`, exit `1` under `--require-attestation` |

The npm publication is verified after the workflow with
`npm view @agentregistrar/discovery@1.3.0 version` returning `1.3.0`.

---

## 6. Release mechanics

Per the repository `AGENTS.md`, the source-first package is published with **npm trusted publishing
(OIDC)** — never a local `npm publish` and never an npm token. This branch is the reviewed artifact;
the tag, npm publication, and GitHub release follow the merge:

1. merge the release to `main`;
2. tag the merge commit `v1.3.0` and push the tag;
3. dispatch `.github/workflows/publish.yml` from `main` (environment `npm-publish`, `id-token:
   write`);
4. verify `npm view @agentregistrar/discovery@1.3.0 version dist.integrity` and the provenance
   attestation;
5. create the GitHub release from this file with `--verify-tag`.

The tag and publish run are recorded in the GitHub release and the workflow log when the release is
dispatched.

---

## 7. Change process and scope

`v1.3.0` was reviewed against [`scope-boundaries.md`](./scope-boundaries.md) §6–§7. The change is
identity- and traceability-related: it moves where a broker-signed identity statement is published, not
what it says. No terms hash, scope, endpoint, price, `provider_url`, catalog, SKU, provisioning API,
resource inventory, or credential custody entered discovery or the attestation. The source document is
a deliberately minimal envelope, and the JWS remains the only trust anchor.

The removal is justified under §13 of the specification: the removed field was OPTIONAL, no conformant
document was required to carry it, and a document that omits the replacement stays conformant. The
handshake and the signed artifacts are unchanged, so the `protocol` id stays `agent-identity-v1`.

---

## 8. Related artifacts

- Normative spec: [`agent-identity-v1.md`](./agent-identity-protocol.md)
- Scope rulebook: [`scope-boundaries.md`](./scope-boundaries.md)
- Implementation guide: [`implementing-agent-identity-v1.md`](./implementing-agent-identity-protocol.md)
- Validator guide: [`validator.md`](./validator.md)
- Discovery schema: [`agent-signup.schema.json`](./agent-signup.schema.json)
- Attestation source schema: [`attestation-source.schema.json`](./attestation-source.schema.json)
- Attestation schema (unchanged): [`rp-attestation.schema.json`](./rp-attestation.schema.json)
- Fixture matrix: [`fixtures/README.md`](./fixtures/README.md)
- Registry: [`registry/README.md`](./registry/README.md),
  [`registry/implementations.json`](./registry/implementations.json)
- Previous release: [`release-notes-v1.2.0.md`](./release-notes-v1.2.0.md)
