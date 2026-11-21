# Release Notes — `agent-identity-v1` `v2.0.0`

- **Protocol identifier:** `agent-identity-v1` (unchanged)
- **Specification version:** `v2.0.0` (breaking spec/package release)
- **Release date:** 2026-11-21
- **Normative specification:** [`agent-identity-v1.md`](./agent-identity-protocol.md)
- **Previous release:** [`release-notes-v1.3.2.md`](./release-notes-v1.3.2.md)

`v2.0.0` simplifies two surfaces that added friction without adding trust. The `protocol` id, the
signup handshake, the assertion format, the attestation claims, the signature, the 24-hour lifetime,
and the origin/audience binding are unchanged.

1. **URL-hosted terms.** Discovery `terms` now requires only `{ "version": string, "url": ... }`.
   Providers host their own terms document. At signup (`identity_signup` / `identity_prove`) the
   broker fetches `terms.url` and computes `sha256:<hex>` over the exact response bytes.
   `terms.text` and `terms.sha256` are removed from discovery and are no longer required or
   validated.
2. **Keyless RP attestations.** Contract G (`agent-rp-attestation+jwt`) `keys` allows **0–8**
   entries instead of 1–8. A domain-verified provider without RP signing keys receives a valid
   attestation with `keys: []`.

---

## 1. URL-hosted terms (discovery)

### Before

```json
{
  "terms": {
    "version": "2026.1",
    "url": "https://vaporcloud.example/terms",
    "sha256": "sha256:6357f96f...",
    "text": "<the complete Terms of Service text>"
  }
}
```

### After

```json
{
  "terms": {
    "version": "2026.1",
    "url": "https://vaporcloud.example/terms"
  }
}
```

- `terms.url` **MUST** be an absolute HTTPS URL (localhost development exception) that serves the
  provider's current terms document.
- `terms.version` **MUST** change whenever the document changes materially.
- The broker fetches `terms.url` under its bounded-fetch rules (HTTPS, public address, timeout, size
  cap, no cross-origin redirect) and records `sha256:<hex>` over the **exact response bytes** in
  `delegation.accepted_rp_tos_hash` and the ToS ledger. `delegation.accepted_rp_tos_url` records the
  advertised URL.
- RPs **MUST** check `delegation.accepted_rp_tos_url` against their current `terms.url`. They **MAY**
  additionally check `delegation.accepted_rp_tos_hash` when they serve deterministic bytes. A
  mismatch is still `tos_hash_mismatch`.
- A document that still carries `terms.text` or `terms.sha256` remains conformant because unknown
  additive fields are preserved, but the fields carry no protocol meaning and conformant consumers
  ignore them.

The signed receipt (Contract E) keeps `tos.version`, `tos.url`, and `tos.sha256`; the receipt's hash is
the one the broker computed from the retrieved bytes, not a producer-supplied value.

### Schema and validator changes

- `agent-signup.schema.json`: `terms.required` is `["version", "url"]`; the `sha256` and `text`
  properties are removed; `additionalProperties: true` is retained.
- `AgentSignupDiscoverySchema` (`src/schema.ts`): the `terms` object accepts `version` and `url` and
  passes through additive fields. The `sha256` cross-field check is removed.
- `src/validate-discovery.ts`: `field.terms` validates only `version` and `url`. The recompute check
  (`field.terms.sha256`) is removed. `--json` `terms` metadata is `{ version, url }`.
- The validator never fetches `terms.url`; only the broker does, at signup.

### Migration

1. Publish the terms document at an HTTPS URL on a domain you control.
2. Replace the discovery `terms` object with `{ "version": "...", "url": "..." }`.
3. Update the signup endpoint to compare `delegation.accepted_rp_tos_url` (and, if you serve
   deterministic bytes, the optional hash) instead of relying on the removed discovery `terms.sha256`.
4. Re-run `pnpm validate:discovery https://your-service.example/.well-known/agent-signup.json`.

---

## 2. Keyless RP attestations (Contract G)

### Before

`keys` was required to contain 1–8 entries, so a provider had to generate an Ed25519 keypair,
download the public JWK, and complete a proof-of-possession JWS before it could receive any
attestation.

### After

`keys` contains **0–8** entries with unique `kid`:

- `0` entries (`keys: []`) is valid for a domain-verified provider that has not registered RP signing
  keys. The attestation still verifies against the broker's JWKS; `keys` is only a snapshot of the
  RP's own signing keys.
- Keyless attestations support agent signup. They do not support RP-signed receipts (Contract E) or
  authenticated abuse reports (Contract D.2), which require a key in `keys[]` with the matching
  purpose.
- A ninth simultaneous key is still rejected with `409 key_limit_reached`.
- Registering a key remains available at any time as an optional post-launch step. `no_active_key`
  is now a key-readiness code; it no longer blocks attestation issuance.

### Schema and validator changes

- `rp-attestation.schema.json`: `keys.minItems` is `0` (description: 0–8 entries, may be empty).
- `RpAttestationClaimsSchema` / `RpAttestationClaimsVerifierSchema`: `keys` is
  `.min(0).max(MAX_ATTESTATION_KEYS)`.
- `src/validate-attestation.ts`: no length rejection for `keys`; a keyless claim set verifies like
  any other, and the claims check message reports the key count.
- Fixtures: added `attestations/valid-domain-keyless.jwt` (`keys: []`) and the matching
  `attestation-sources/ok-broker-keyless.json` response, wired into `fixtures/expected.json` and
  `src/dev/sign-fixtures.ts`.

---

## 3. Fixture changes

- Valid discovery fixtures now use `terms: { version, url }`.
- `invalid-bad-tos-hash.json` and `invalid-missing-terms-text.json` were removed: they existed only
  to test the `terms.sha256` mismatch and the required `terms.text`, both removed in `v2.0.0`.
- Added a keyless attestation JWT and source response plus two rows in the fixture matrix.

## 4. Validation evidence

No test framework is added (`AGENTS.md`). The manual harnesses were run from this repository:

| Check | Command | Result |
| :--- | :--- | :--- |
| Typecheck | `pnpm typecheck` | exit `0`, no diagnostics |
| Fixture matrix | `pnpm validate:fixtures` | `Summary: 81 passed, 0 failed`, exit `0` |
| Registry | `pnpm validate:registry` | `RESULT: VALID — 0 error(s), 0 warning(s), exit 0` |
| Signed fixtures | `pnpm sign:fixtures` | regenerated deterministically, no unexpected diff |

## 5. Release mechanics

Per the repository `AGENTS.md`, the source-first package is published with **npm trusted publishing
(OIDC)** — never a local `npm publish` and never an npm token:

1. bump `version` in `package.json` to `2.0.0` (done) and merge to `main`;
2. tag the merge commit `v2.0.0` and push the tag;
3. dispatch `.github/workflows/publish.yml` from `main` (environment `npm-publish`, `id-token:
   write`);
4. verify `npm view @agentregistrar/discovery@2.0.0 version dist.integrity` and the provenance
   attestation;
5. create the GitHub release from this file with `--verify-tag`.

Consumers pin `@agentregistrar/discovery@2.0.0` (or `github:agentregistrar/spec#v2.0.0` once the tag
exists) and follow §1 and §2 above.

## 6. Related artifacts

- Normative spec: [`agent-identity-v1.md`](./agent-identity-protocol.md)
- Implementation guide: [`implementing-agent-identity-v1.md`](./implementing-agent-identity-protocol.md)
- Validator guide: [`validator.md`](./validator.md)
- Fixture matrix: [`fixtures/README.md`](./fixtures/README.md)
- Previous release: [`release-notes-v1.3.2.md`](./release-notes-v1.3.2.md)
