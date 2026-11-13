# Release Notes — `agent-identity-v1` `v1.3.1`

- **Protocol identifier:** `agent-identity-v1` (unchanged)
- **Specification version:** `v1.3.1` (contract-text patch on `v1.3.0`)
- **Release date:** 2026-11-13
- **Normative specification:** [`agent-identity-v1.md`](./agent-identity-v1.md)
- **Previous release:** [`release-notes-v1.3.0.md`](./release-notes-v1.3.0.md)

`v1.3.1` is a **contract-text correction**. It changes no wire format, JSON Schema, fixture, validator
behavior, check id, reason code, or attestation claim. It corrects two normative statements that the
published `v1.3.0` text left out, so the text now matches the already-decided D18 contract:

1. **Contract H attestation issuance is not plan-gated.** `v1.3.0` still said issuance required
   `plan:"verified"` with a live subscription and that a `free` provider could not issue. D18 F6
   removes the `attestation` entitlement entirely. Issuance now requires provider `status:"active"`,
   origin `status:"verified"`, and at least one `active` key; `provider_not_eligible` reports those
   state failures, not a plan.
2. **The client policy contract is `no_verify`/`verify`/`strict`.** `v1.3.0` still normatively said
   `RpPolicy` was `allow`/`warn`/`require`/`block`, defaulted to `warn`, and had an `enforced` field.
   D18 F4 replaces those values with `no_verify`, `verify` (default), and `strict`; `blocked` is a
   separate boolean human action, not a mode; `verify` and `strict` are always enforced; there is no
   `enforced` field and no alias for the removed values.

Consumers that pinned `1.3.0` would have implemented the wrong policy and issuance contract from the
normative text. `1.3.1` gives them an explicit version to repin.

---

## 1. What changed

| Section | Correction |
| :--- | :--- |
| §15.3 Attestation issuance and renewal | Removed the `plan:"verified"` / live-subscription requirement and the "free provider cannot issue" sentence. Issuance requires `status:"active"`, a `verified` origin, and an `active` key; `provider_not_eligible` is not a plan signal. Lifetime, per-origin 24/day limit, `renewed_from_jti`, GET-latest behavior, and the 12-hour renewal target are unchanged. |
| §15.4 Account lifecycle | Removed the "free plan has no attestation entitlement" sentence. Other lifecycle facts are unchanged; receipts, abuse standing, verified listing, and entity review are not described as ungated. |
| §17.2 Resolution order | Default policy is `verify`. |
| §17.3 Policy modes | `RpPolicy` is exactly `no_verify`/`verify`/`strict`. `no_verify` never gates; `verify` accepts both publication modes; `strict` requires broker-managed and rejects provider-managed with `rp_attestation_mode_not_allowed`; `blocked=true` rejects with `rp_blocked` before any source fetch. The status-to-code mapping is unchanged. `enforced` and `warn` are removed. |
| §18.3 Verification source | `strict` rejects `agent_supplied_discovery` with `discovery_source_not_allowed`; `verify` and `no_verify` may accept either source. |
| §19.1, §19.8, §20 | Removed the "warning by default"/advisory wording and aligned fail-closed, security, and "no broker in the signup path" text with the new modes. |
| §2.1, §5.4, §14.3, §16.2 | Replaced remaining normative old-policy references (`require` for agent-supplied discovery, "enforced mode") with `strict` / `verify`/`strict`. |
| Implementation guide, validator guide, scope rulebook | Aligned the policy summary, package version (`1.3.1`), and scope-checklist wording. |

## 2. What did not change

- **No wire or schema change.** `agent-signup.schema.json`, `attestation-source.schema.json`,
  `rp-attestation.schema.json`, and all other schemas are byte-identical to `v1.3.0`.
- **No validator behavior change.** `VALIDATOR_VERSION` is `1.3.1` for evidence provenance; the
  conformance checks, verification reasons, flags, exit codes, and fixture matrix are unchanged
  (`pnpm --silent validate:fixtures`: 79/79).
- **No attestation change.** Claims, signature, key snapshot, 24-hour lifetime, `aud`, and
  origin/audience binding are unchanged.
- **No Contract F/D.2 change.** Receipt ingestion and abuse bodies keep the historical
  `rp_attestation` field.
- **No history rewrite.** The `v1.3.0` tag, npm artifact, and release notes are untouched.

## 3. Why a patch instead of republishing `1.3.0`

Published npm versions are immutable, and the `v1.3.0` tag, provenance statement, and release notes
are already a public record. Rebuilding or moving `1.3.0` would invalidate checksums and provenance and
silently change the text behind an existing pin. A new patch version makes the correction explicit:
`1.3.0` remains the breaking discovery release with the defective text; `1.3.1` is the same wire
contract with corrected normative text. Repin to `1.3.1`.

This is a correction to text that should have shipped in `1.3.0`, not a new protocol decision: the
decisions (D18 F4 and F6) were already frozen and consumed by the monorepo work.

## 4. Validation evidence

No test framework is added (`AGENTS.md`). The patch changes documentation and version strings only:

| Check | Command | Result |
| :--- | :--- | :--- |
| Typecheck | `pnpm typecheck` | exit `0`, no diagnostics |
| Fixture matrix | `pnpm --silent validate:fixtures` | `Summary: 79 passed, 0 failed`, exit `0` |
| Registry | `pnpm --silent validate:registry` | `RESULT: VALID — 0 error(s), 0 warning(s), exit 0` |

The npm publication is verified after the workflow with
`npm view @agentregistrar/discovery@1.3.1 version` returning `1.3.1`.

## 5. Release mechanics

Per the repository `AGENTS.md`, the source-first package is published with **npm trusted publishing
(OIDC)** — never a local `npm publish` and never an npm token:

1. merge the patch to `main`;
2. tag the merge commit `v1.3.1` and push the tag;
3. dispatch `.github/workflows/publish.yml` from `main` (environment `npm-publish`, `id-token:
   write`);
4. verify `npm view @agentregistrar/discovery@1.3.1 version dist.integrity` and the provenance
   attestation;
5. create the GitHub release from this file with `--verify-tag`.

## 6. Related artifacts

- Normative spec: [`agent-identity-v1.md`](./agent-identity-v1.md)
- Scope rulebook: [`scope-boundaries.md`](./scope-boundaries.md)
- Implementation guide: [`implementing-agent-identity-v1.md`](./implementing-agent-identity-v1.md)
- Validator guide: [`validator.md`](./validator.md)
- Fixture matrix: [`fixtures/README.md`](./fixtures/README.md)
- Previous release: [`release-notes-v1.3.0.md`](./release-notes-v1.3.0.md)
