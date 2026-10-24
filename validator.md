# Discovery Conformance and Attestation Validator (`agent-identity-v1`)

- **Source:** `src/validate-discovery.ts` — run with `pnpm validate:discovery`.
- **Package:** `@agentregistrar/discovery` `1.2.0`, licensed **Apache-2.0**. It is self-contained and
  source-first: `pnpm install` from a clean clone, then run the CLI. The `v1.2.0` tag publishes it to
  npm; until that tag exists, `npm dist-tags.latest` is `1.1.0`, so `npm install
  @agentregistrar/discovery` still resolves `1.1.0`. Run it from this repository, or after the tag
  exists use the pinned git dependency (`github:agentregistrar/spec#v1.2.0`). There is no `bin`
  entry — invoke it with `pnpm validate:discovery`.
- **Normative references:** [`agent-identity-v1.md`](./agent-identity-v1.md),
  [`scope-boundaries.md`](./scope-boundaries.md).
- **Related harnesses:** `pnpm validate:fixtures` (standalone JWS/schema matrix) and
  `pnpm validate:registry` (implementation registry) — both in §11.

The validator is the objective mechanism behind the rule “a Relying Party that claims
`agent-identity-v1` support MUST publish a valid discovery document.” It reports **two independent
results**:

1. **Document conformance** — schema, ToS hash, scope boundary, field rules. This never contacts an
   RP broker.
2. **Attestation verification** — optional, opt-in parsing and local verification of
   `rp_attestation` (Contract G). Only this can contact the issuing broker, and only when explicitly
   requested.

A document can therefore be **conformant and unverified**. That is a complete, honest result, not a
partial failure.

## 1. What it does

Given a discovery URL or a local JSON file, the validator:

1. Fetches (URL mode) or reads (file mode) the document with a timeout, a bounded read (1 MiB cap),
   and a same-origin redirect limit of three hops; in URL mode it also requires HTTPS, `200 OK`, and
   `Content-Type: application/json` (and reports cache/CORS headers). **A body that is not valid JSON
   is a conformance error (exit `1`), not a fetch failure.**
2. Validates the body against `AgentSignupDiscoverySchema` and against
   `agent-signup.schema.json`. Zod + the written specification win; any divergence between the two
   schemas is reported, never hidden.
3. Recomputes the SHA-256 over the exact UTF-8 bytes of `terms.text` and fails on mismatch.
4. Fails any forbidden vendor capability surface **at any nesting depth — including under
   `extensions`** — and warns (without failing) on unknown top-level fields and non-reverse-DNS
   `extensions` keys.
5. Checks the `rp_attestation` **field format** only: a non-string, over 16384 characters, or not
   three unpadded base64url segments is a conformance failure regardless of flags. There is no JWS to
   verify in that case, so `attestation.status` is `not_checked` (reason `field_malformed`), never
   `invalid`.
6. With `--verify-attestation`, verifies the attestation: JWS parse, `typ`, `alg`, `kid`, claims,
   trusted issuer **before** any JWKS/metadata fetch, signature by the selected key, 60-second skew,
   `rp.origin` against the fetched document origin, and `rp.audience` against `audience`. An absent
   optional field is `unverified` plus a warning and leaves the exit code unchanged.

## 2. File mode

Validate a checked-in fixture or any local document without any network access:

```bash
pnpm validate:discovery fixtures/valid-minimal.json
pnpm validate:discovery fixtures/valid-full.json
pnpm validate:discovery fixtures/valid-localhost.json
```

Every `valid-*` fixture passes (exit `0`); every `invalid-*` fixture fails (exit `1`) with a specific,
field-level message. A fixture’s `__fixture_note` field is an unknown top-level field and produces a
warning only.

**File mode and the attestation origin.** Attestation verification binds `rp.origin` to the origin of
the document the verifier actually fetched. A local file has no fetch origin, so a fixture declares it
with `__fixture_origin` (for example `"https://vaporcloud.example"`). Without a declared origin the
attestation cannot be bound: the validator reports `unavailable` with reason `origin_unverifiable`
rather than claiming `verified`. `__fixture_origin` is fixture-only metadata; it is not protocol
surface, and real runs should validate the URL.

## 3. URL mode

Validate a live discovery document. HTTPS is required; `http://localhost` / `http://127.0.0.1` are the
documented development exception to the HTTPS requirement:

```bash
# Production: canonical HTTPS origin (fetch origin is authoritative)
pnpm validate:discovery https://example.com/.well-known/agent-signup.json

# With attestation verification and a trusted broker
pnpm validate:discovery https://example.com/.well-known/agent-signup.json \
  --verify-attestation --trusted-rp-broker https://rp-broker.example

# Hard gate: a non-verified attestation fails the run
pnpm validate:discovery https://example.com/.well-known/agent-signup.json \
  --require-attestation --trusted-rp-broker https://rp-broker.example

# A local development server
pnpm validate:discovery http://localhost:3001/.well-known/agent-signup.json
```

## 4. Offline, deterministic runs

Attestation verification is reproducible without network access:

```bash
pnpm validate:discovery fixtures/valid-attested-domain.json \
  --verify-attestation \
  --jwks fixtures/keys/fixture-jwks-broker-1.json \
  --trusted-rp-broker https://rp-broker.example \
  --at 2026-10-24T00:00:00Z \
  --require-attestation --json
```

- `--jwks <path-or-url>` pins exactly **one** issuer’s JWKS. It never bypasses signature checks and
  never merges issuers; use the per-issuer fixture file.
- `--at <rfc3339|epoch>` freezes the clock. It is for deterministic fixture runs, not production.
- `--trusted-rp-broker <issuer>` is repeatable. If any flag is present, the environment fallback
  `AGENT_IDENTITY_TRUSTED_RP_BROKERS` (comma-separated) is ignored. An empty effective list trusts
  nothing: an attestation from any issuer is `attested_untrusted_broker`.
- Without `--jwks`, a trusted issuer's broker metadata is consulted first: a validated, same-origin
  `jwks_uri` from `<issuer>/.well-known/agent-broker.json` is used (metadata cached at most 1 hour);
  otherwise the verifier falls back to `<issuer>/.well-known/jwks.json`. An invalid or cross-origin
  `jwks_uri` is never followed. `--jwks` pins the source and skips the metadata lookup entirely.

**The trust list is configuration, never inference.** The validator never derives trust from the
document it is checking, from `issuer_allowlist`, or from the attestation itself. A conformance run
with no trust flags performs no attestation verification and makes no network call for one.

## 5. Machine-readable output (`--json`)

`--json` prints a single stable machine-readable result on stdout:

```bash
pnpm --silent validate:discovery https://example.com/.well-known/agent-signup.json --json | jq .
```

> **Use `--silent`.** `pnpm` prints its own run banner to stdout. Pass `--silent` (`-s`) so that
> stdout is *pure* JSON.

Exit status is the contract; the JSON is evidence. The v1.2.0 additions:

```json
{
  "validator": "agent-identity-v1",
  "validatorVersion": "1.2.0",
  "valid": true,
  "exitCode": 0,
  "conformance": { "valid": true, "evaluated": true, "errors": [], "warnings": [] },
  "attestation": {
    "present": true, "checked": true, "required": true, "verified": true,
    "status": "verified", "reason": null,
    "iss": "https://rp-broker.example", "jti": "rpa_…",
    "origin": "https://vaporcloud.example", "audience": "vaporcloud",
    "level": "domain", "checked_at": "2026-10-24T00:00:00.000Z",
    "jwks_source": "fixtures/keys/fixture-jwks-broker-1.json",
    "checks": [{ "id": "attestation.signature", "status": "pass", "message": "…" }],
    "errors": [], "warnings": []
  }
}
```

`valid` remains the **run result** (`valid === (exitCode === 0)`), so existing consumers do not break.
`conformance.valid` is the document-only verdict, so a consumer can print “conformant, unverified”.
`conformance.evaluated` is `false` and `conformance.valid` is `null` only when the run never obtained a
document (exit `2`); a fetch failure is not a conformance verdict. `attestation` is always an object,
never `null`.

`attestation.status` is one of `verified`, `unverified`, `attested_untrusted_broker`, `invalid`,
`expired`, `unavailable`, or `not_checked` (no verification was performed: `--verify-attestation` was
not requested, or the field itself is malformed and failed conformance). The validator never emits
`suspended`; that status comes from the broker or the status endpoint. A malformed `rp_attestation`
field is **conformance-only**: exit `1`, `attestation.status` `not_checked`, reason `field_malformed`.
`invalid` is reserved for a structurally valid JWS whose header, claims, or signature fail.

Stable attestation check ids: `attestation.field.present`, `.field.format`, `.jws.parse`, `.typ`,
`.alg`, `.kid`, `.claims`, `.window`, `.origin`, `.audience`, `.issuer_trusted`, `.jwks`, `.signature`.

Human output adds `ATTESTATION: <status>`, prints attestation warnings as `[WARN] attestation.warning …`,
`DOCUMENT: VALID|INVALID|NOT CHECKED`, and `RESULT: OK|FAILED|COULD NOT FETCH`. `DOCUMENT: NOT CHECKED`
is printed on exit `2` (with `n/a`) because there is no document to judge.

## 6. Exit codes

| Code | Meaning |
| :--- | :--- |
| `0` | Document fetched, parsed, and conformant; no required check failed. `unverified` / `expired` / `invalid` without `--require-attestation` stays `0`. |
| `1` | Document parsed and a required check failed: a conformance error (including malformed JSON or a malformed `rp_attestation` field), or an attestation failure under `--require-attestation`. |
| `2` | The run could not obtain what it needed: document read/fetch failure (missing file, network, status, size), or JWKS unavailable under `--require-attestation`. Never a conformance verdict: `conformance.valid` is `null`, `conformance.evaluated` is `false`, and human output prints `DOCUMENT: NOT CHECKED`. |

Status-to-exit mapping (when the document is otherwise conformant):

| Attestation status | No flag | `--verify-attestation` | `--require-attestation` |
| :--- | :--- | :--- | :--- |
| absent (`unverified`) | `0` | `0` + warning | `1` (`rp_unverified` equivalent) |
| `verified` | `0` | `0` | `0` |
| `not_checked` (no verification performed: flag absent, or the field is malformed) | `0` | `0` | n/a |
| `expired` | `0` | `0` + warning | `1` |
| `invalid` / `attested_untrusted_broker` | `0` | `0` + warning | `1` |
| `unavailable` | `0` | `0` + warning | `2` |

A malformed `rp_attestation` field is a conformance failure (`1`) regardless of flags; the
`attestation` object reports `not_checked` with reason `field_malformed` because there is no JWS to
verify. `invalid` means a structurally valid JWS failed a named verification check. The exit-code
distinction is “no document / no evidence” (`2`, operational, `DOCUMENT: NOT CHECKED`) versus “bad
document or failed gate” (`1`, conformance/verification). Both are non-zero, so any gate that only
checks exit status still fails correctly.

## 7. Flags added in v1.2.0

| Flag | Behavior |
| :--- | :--- |
| `--verify-attestation` | Parse and verify `rp_attestation` if present; opt-in issuer JWKS fetch. Absent field → `unverified` + warning, exit unchanged. |
| `--require-attestation` | Implies `--verify-attestation`; a non-`verified` result fails the run. |
| `--trusted-rp-broker <issuer>` | Repeatable. Flags override the env fallback; if any flag is present the env list is ignored. Env fallback `AGENT_IDENTITY_TRUSTED_RP_BROKERS`. Empty effective list = nothing trusted. |
| `--jwks <path-or-url>` | Pin exactly one issuer’s JWKS for offline runs; never bypasses signature checks and never merges issuers. |
| `--at <rfc3339\|epoch>` | Freeze the clock for deterministic fixture runs; not for production use. |

The existing `--json`, `--probe-jwks` (alias `--probe-issuers`), `--probe-endpoints`, `--timeout`, and
`--max-bytes` flags are unchanged, and their JSON fields are retained.

## 8. Opt-in probes (safe, non-destructive, off by default)

The default run performs **no** extra requests beyond the document itself. Probes are opt-in:

```bash
# Fetch GET <issuer>/.well-known/jwks.json for every issuer and require >=1 verification key:
pnpm validate:discovery https://example.com/.well-known/agent-signup.json --probe-jwks

# Non-destructively HEAD (then OPTIONS) the advertised agent_signup endpoint:
pnpm validate:discovery https://example.com/.well-known/agent-signup.json --probe-endpoints
```

Probes never `POST`, never trigger signup or provisioning, and are limited to the issuers in
`issuer_allowlist` and the advertised `endpoints.agent_signup`. A failed probe makes the overall result
invalid (exit `1`). `--probe-jwks` checks the **assertion** issuers in `issuer_allowlist`; the RP
broker JWKS used for `rp_attestation` is fetched only by `--verify-attestation`.

## 9. Why vendor capability fields fail conformance

`agent-signup.json` is a **parameter document, not a capability catalog** (spec §5.3,
`scope-boundaries.md`). Moving a vendor capability under `extensions` does **not** make it conformant.
The validator fails the document if it finds, at **any** depth:

- `instance_catalog` (and catalog/SKU/pricing/tier/quota keys such as `sku`, `pricing`, `tiers`);
- `endpoints.provision`, `endpoints.email_signup`, `endpoints.verify_otp`,
  `endpoints.broker_signup_receipt`;
- provisioning/resource/instance/lifecycle metadata and resource credentials (`api_key`, `secret`, …);
- the same keys smuggled inside `extensions` (for example
  `extensions["dev.vendor"].instance_catalog`).

Correct place for vendor capabilities: the vendor’s **post-signup context guide** (for example a
`SKILL.md`), returned as an opaque `context.url` + `context.sha256` pointer **after** signup — never in
discovery.

Unknown top-level fields and `extensions` keys that are **not** reverse-DNS namespaced produce
warnings only, so producers can evolve additively without silently losing visibility.

## 10. Safety

- Only the top-level URL you provide, an explicitly requested probe target, or the explicitly
  requested attestation issuer JWKS is ever fetched.
- URLs discovered inside the document body — including `terms.url`, `spec`, `provider_url`, and
  anything under `extensions` — are **never** followed by default.
- An untrusted attestation `iss` is rejected **before** any network call, so a document cannot steer
  the verifier at a third-party host.
- For a trusted issuer without `--jwks`, broker metadata is fetched from that issuer's
  `/.well-known/agent-broker.json`; only a validated, same-origin HTTPS `jwks_uri` is followed,
  otherwise the fixed `/.well-known/jwks.json` fallback is used.
- `terms.text` and all document content are treated as data and are never executed or interpreted.
- Every fetch applies the timeout, the 1 MiB read cap, and the three-hop same-origin redirect limit.
- JWKS are cached per `iss` and never merged; `--jwks` applies to one issuer.
- `http://localhost` / `http://127.0.0.1` are permitted for development only.

## 11. Fixture harness and registry validator

Both are **manual harnesses, not test frameworks** (`AGENTS.md` forbids tests in this repository).

### `pnpm validate:fixtures [fixtures/expected.json]`

Reads the expected result for every standalone fixture from `fixtures/expected.json`, exercises the
same code as the CLI, and exits `0` (all rows match) or `1` (a row differs). It covers the discovery
matrix, every attestation JWS (status plus producer/verifier schema mode), receipts, abuse reports,
status responses, broker metadata, and provider request/response examples. See
[`fixtures/README.md`](./fixtures/README.md).

### `pnpm validate:registry [path] [--json]`

Validates `registry/implementations.json` against `registry/implementations.schema.json` and the
registry rules: conformance and verification are separate, `verification` is an optional five-field
snapshot, and duplicate discovery URLs are an error. Exit `0` valid, `1` invalid, `2` unreadable or
unparseable. `--json` emits `{valid, exitCode, errors, warnings}`.

## 12. `--json` field reference (for the implementation registry)

| Field | Type | Notes |
| :--- | :--- | :--- |
| `validator` | string | Always `"agent-identity-v1"`. |
| `validatorVersion` | string | The `VALIDATOR_VERSION` constant, `"1.2.0"`. |
| `mode` | `"file"` \| `"url"` | How the document was obtained. |
| `source` | string | The path or URL that was validated. |
| `valid` | boolean | `true` iff `exitCode === 0` (the run result). |
| `exitCode` | number | `0`, `1`, or `2` (see §6). |
| `conformance` | object | `{ valid, evaluated, errors, warnings }` — the document-only verdict. `valid` is `true`/`false`, or `null` when the document was never obtained; `evaluated` is `false` only on exit `2`. |
| `attestation` | object | `{ present, checked, required, verified, status, reason, iss, jti, origin, audience, level, checked_at, jwks_source, checks, errors, warnings }`. Always an object. |
| `protocol` | string \| null | `protocol` from the document, if present. |
| `audience` | string \| null | `audience` from the document, if present. |
| `providerName` | string \| null | `provider_name`, if present. |
| `signupEndpoint` | string \| null | `endpoints.agent_signup`, if present. |
| `terms` | object \| null | `{ version, url, sha256 }` (the digest that was recomputed). |
| `fetchFailure` | string \| null | Non-null only on exit `2`. |
| `counts` | object | `{ passed, failed, warnings, probes }` — stable keys. |
| `checks` | array | One entry per document check: `{ id, title, status, message, expected?, actual?, path? }`. |
| `probes` | array | `{ id, kind, target, status, message }`; `kind` is `jwks` or `endpoint`. |
| `errors` | array of strings | Failing document checks and probes, each `"<id>: <message>"`; on exit `2` this holds the operational `source` failure. |
| `warnings` | array of strings | Document warnings plus attestation warnings/errors, each `"<id>: <message>"`. |

The registry records `source` as `discovery_url` and reads `audience` and `protocol` directly;
`capabilities` remain protocol capabilities only (`agent_signup`, `post_signup_context`). A registry
`verification` object is a **snapshot** at `checked_at`; it is not produced by this validator.
