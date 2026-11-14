# Release Notes — `agent-identity-v1` `v1.3.2`

- **Protocol identifier:** `agent-identity-v1` (unchanged)
- **Specification version:** `v1.3.2` (documentation patch on `v1.3.1`)
- **Release date:** 2026-11-14
- **Normative specification:** [`agent-identity-v1.md`](./agent-identity-v1.md)
- **Previous release:** [`release-notes-v1.3.1.md`](./release-notes-v1.3.1.md)

`v1.3.2` corrects documentation only. It changes no wire format, JSON Schema shape, fixture, validator
behavior, check id, reason code, or attestation claim. The `VALIDATOR_VERSION` and package version are
`1.3.2` for evidence provenance; the validator behaves exactly as it did in `1.3.1`.

Two normative contradictions in the published `v1.3.1` text are fixed:

1. **Missing active key vs. ineligible provider (§15.3).** The text grouped a non-active provider, a
   non-verified origin, and a missing active key under `403 provider_not_eligible`. A missing active
   key is `409 no_active_key` (§15.5), which is what brokers return. `403 provider_not_eligible` is now
   scoped to a non-active provider or a non-verified origin.
2. **Unchecked host binding vs. broker binding (§14.2 step 2).** The text said a verifier with no
   fetch origin reports the binding as unchecked, unconditionally. That applies only to a `provider`
   source, whose binding is to the fetched discovery origin. A `broker` source is always enforced from
   the document's `issuer_allowlist` (plus the configured trusted-broker list) and does not depend on a
   fetch origin.

Three clarifications and one provider note accompany the corrections:

- `validator.md` now states in one clause that a file-mode run without `__fixture_origin` is
  `unavailable`/`origin_unverifiable` in **either** mode, and that only the `provider` binding is
  skipped while the `broker` binding is still checked.
- The §19.2.1 reason table marks `attestation_binding_unchecked` as `(skip; provider mode with no
  fetch origin)`.
- The implementation guide's exit-`2` enumeration now includes the attestation source, matching
  `README.md` and `validator.md`.
- `rp-attestation.schema.json` labels the producer rule `v1.3` (was `v1.2`), keeping the historical
  note that the v1.2 embedded `rp_attestation` discovery field is removed.
- The provider guide notes that a provider using a second broker for its attestation must include that
  broker in `issuer_allowlist`, and that the same single list also accepts that broker's agent
  assertions.

The `v1.3.1` release notes are corrected on the `403`/`409` split; the rest of the `v1.3.0` and
`v1.3.1` history, tags, and notes are unchanged.

---

## 1. What did not change

- **No wire or schema change.** All JSON Schemas are shape-identical; `rp-attestation.schema.json`
  changes a prose revision label only.
- **No validator behavior change.** Checks, reasons, flags, exit codes, and the fixture matrix are
  unchanged (`pnpm --silent validate:fixtures`: 79/79).
- **No attestation change.** Claims, signature, key snapshot, 24-hour lifetime, `aud`, and
  origin/audience binding are unchanged.
- **No policy change.** `no_verify`/`verify`/`strict`, the `verify` default, and the separate
  `blocked` action are as shipped in `v1.3.1`.
- **No history rewrite.** The `v1.3.0` and `v1.3.1` tags and npm artifacts are untouched.

## 2. Why a patch instead of republishing `1.3.1`

Published npm versions are immutable, and the `v1.3.1` tag, provenance statement, and release notes are
a public record. A new patch version makes the correction explicit and gives consumers a version to
repin. This is a documentation correction, not a new protocol decision.

## 3. Validation evidence

No test framework is added (`AGENTS.md`). The patch changes documentation, a schema description, and
version strings only:

| Check | Command | Result |
| :--- | :--- | :--- |
| Typecheck | `pnpm typecheck` | exit `0`, no diagnostics |
| Fixture matrix | `pnpm --silent validate:fixtures` | `Summary: 79 passed, 0 failed`, exit `0` |
| Registry | `pnpm --silent validate:registry` | `RESULT: VALID — 0 error(s), 0 warning(s), exit 0` |

The npm publication is verified after the workflow with
`npm view @agentregistrar/discovery@1.3.2 version` returning `1.3.2`.

## 4. Release mechanics

Per the repository `AGENTS.md`, the source-first package is published with **npm trusted publishing
(OIDC)** — never a local `npm publish` and never an npm token:

1. merge the patch to `main`;
2. tag the merge commit `v1.3.2` and push the tag;
3. dispatch `.github/workflows/publish.yml` from `main` (environment `npm-publish`, `id-token:
   write`);
4. verify `npm view @agentregistrar/discovery@1.3.2 version dist.integrity` and the provenance
   attestation;
5. create the GitHub release from this file with `--verify-tag`.

## 5. Related artifacts

- Normative spec: [`agent-identity-v1.md`](./agent-identity-v1.md)
- Implementation guide: [`implementing-agent-identity-v1.md`](./implementing-agent-identity-v1.md)
- Validator guide: [`validator.md`](./validator.md)
- Fixture matrix: [`fixtures/README.md`](./fixtures/README.md)
- Previous release: [`release-notes-v1.3.1.md`](./release-notes-v1.3.1.md)
