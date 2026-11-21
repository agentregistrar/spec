# Discovery Conformance and Attestation Validator (`agent-identity-protocol`)

- **Source:** `src/validate-discovery.ts` — run with `pnpm validate:discovery`.
- **Package:** `@agentregistrar/discovery` `2.0.0`, licensed **Apache-2.0**. It is self-contained and
  source-first: `pnpm install` from a clean clone, then run the CLI. The `v2.0.0` tag publishes it to
  npm. Run it from this repository, or after the tag exists use the pinned git dependency
  (`github:agentregistrar/spec#v2.0.0`). There is no `bin` entry — invoke it with
  `pnpm validate:discovery`.
- **Normative references:** [`agent-identity-protocol.md`](./agent-identity-protocol.md),
  [`scope-boundaries.md`](./scope-boundaries.md).
- **Related harnesses:** `pnpm validate:fixtures` (standalone JWS/schema matrix) and
  `pnpm validate:registry` (implementation registry) — both in §11.

The validator is the objective mechanism behind the rule “a Relying Party that claims
`agent-identity-protocol` support MUST publish a valid discovery document.” It reports **two independent
results**:

1. **Document conformance** — schema, URL-hosted terms shape, scope boundary, field rules, and the
   `attestation` object's mode/URI/host binding. This never contacts an RP broker or fetches
   `terms.url`.
2. **Attestation verification** — optional, opt-in fetching of the source named by `attestation.uri`
   and local verification of the returned Contract G JWS. Only this can contact the attestation source
   and the issuing broker, and only when explicitly requested.

A document can therefore be **conformant and unverified**. That is a complete, honest result, not a
partial failure. A document can also be **conformant and suspended/revoked/unavailable**: a typed
broker failure is a verification result, never a conformance failure.

## 1. What it does

Given a discovery URL or a local JSON file, the validator:

1. Fetches (URL mode) or reads (file mode) the document with a timeout, a bounded read (1 MiB cap),
   and a same-origin redirect limit of three hops; in URL mode it also requires HTTPS, `200 OK`, and
   `Content-Type: application/json` (and reports cache/CORS headers). **A body that is not valid JSON
   is a conformance error (exit `1`), not a fetch failure.**
2. Validates the body against `AgentSignupDiscoverySchema` and against
   `agent-signup.schema.json`. Zod + the written specification win; any divergence between the two
   schemas is reported, never hidden.
3. Checks `terms` as URL-hosted terms: `version` is a non-empty string and `url` is an absolute
   protocol URL. The validator never fetches `terms.url`; the broker does that at signup and hashes
   the exact response bytes. Removed `terms.text` / `terms.sha256` fields, if present, are ignored.
4. Fails any forbidden vendor capability surface **at any nesting depth — including under
   `extensions`** — and warns (without failing) on unknown top-level fields and non-reverse-DNS
   `extensions` keys.
5. Checks the `attestation` **object shape and URI**: it must be an object with `mode` exactly
   `broker` or `provider` (`field.attestation.mode` / `attestation_mode_invalid`) and a `uri` that is
   an absolute HTTPS URL with no userinfo and no fragment — `http://localhost` / `http://127.0.0.1`
   is the development exception — (`field.attestation.uri` / `attestation_uri_invalid`). A malformed
   object has no source to select, so `attestation.status` is `not_checked` with reason
   `field_malformed`, never `invalid`.
6. Checks the **host binding** (`field.attestation.binding`): a `broker` URI origin must be a member of
   the document's `issuer_allowlist` and, when a trusted broker list is supplied, a trusted broker
   origin (`attestation_uri_host_untrusted`); a `provider` URI origin must be the discovery origin or a
   subdomain of it (`attestation_uri_host_unbound`). In file mode with no `__fixture_origin` there is no
   fetch origin, so the provider binding is `skip` / `attestation_binding_unchecked` and is never a
   pass.
7. Fails a document that still contains the removed `rp_attestation` field
   (`field.rp_attestation` / `rp_attestation_removed`), reported **once** and never repeated as an
   "ignored unknown field".
8. With `--verify-attestation`, fetches and verifies the source: the bounded fetch, the
   `application/json` + `{ "attestation": "<compact JWS>" }` document, JWS parse, `typ`, `alg`, `kid`,
   claims, trusted issuer before any JWKS fetch (the source URI is host-bound before its own fetch),
   signature by the selected key, 60-second skew, `rp.origin` against the fetched document origin, and
   `rp.audience` against `audience`. An absent `attestation` object is `unverified` + warning and
   leaves the exit code unchanged; a present object without the flag is `not_checked`.

## 2. File mode

Validate a checked-in fixture or any local document without any network access:

```bash
pnpm validate:discovery fixtures/valid-minimal.json
pnpm validate:discovery fixtures/valid-full.json
pnpm validate:discovery fixtures/valid-localhost.json
pnpm validate:discovery fixtures/valid-attestation-broker.json
pnpm validate:discovery fixtures/valid-attestation-provider.json
pnpm validate:discovery fixtures/invalid-rp-attestation-removed.json   # exit 1
```

Every `valid-*` fixture passes (exit `0`); every `invalid-*` fixture fails (exit `1`) with a specific,
field-level message. A fixture’s `__fixture_note` field is an unknown top-level field and produces a
warning only. The `attestation` conformance checks report these stable ids: `field.attestation.mode`,
`field.attestation.uri`, `field.attestation.binding`, and `field.rp_attestation` (see §5 for the reason
codes).

**File mode and the attestation binding.** Attestation verification binds `rp.origin` to the origin of
the document the verifier actually fetched. A local file has no fetch origin, so a fixture declares it
with `__fixture_origin` (for example `"https://vaporcloud.example"`). Without a declared origin, the
source token is `unavailable` with reason `origin_unverifiable` in **either** mode — never `verified`.
Within that outcome:

- a `provider` source binding is also `skip` with reason `attestation_binding_unchecked`; and
- a `broker` source binding is still enforced from the document's `issuer_allowlist` (and the
  configured trusted-broker list), because that check does not need a fetch origin.

`__fixture_origin` is fixture-only metadata: it is not protocol surface, real runs should validate the
URL, and it never substitutes for the fetch origin when the URL is validated. A `provider` URI on the
declared origin (or a subdomain) passes the binding; one on any other host fails it.

## 3. URL mode

Validate a live discovery document. HTTPS is required; `http://localhost` / `http://127.0.0.1` are the
documented development exception to the HTTPS requirement:

```bash
# Production: canonical HTTPS origin (fetch origin is authoritative)
pnpm validate:discovery https://example.com/.well-known/agent-signup.json

# Broker-managed source (the origin must be in issuer_allowlist and trusted)
pnpm validate:discovery https://example.com/.well-known/agent-signup.json \
  --verify-attestation --trusted-rp-broker https://rp-broker.example

# Provider-managed source (bound to the fetched discovery origin or a subdomain;
# the issuer must still be in the verifier's trusted-broker list)
pnpm validate:discovery https://example.com/.well-known/agent-signup.json \
  --verify-attestation --trusted-rp-broker https://rp-broker.example

# Hard gate: a non-verified attestation fails the run
pnpm validate:discovery https://example.com/.well-known/agent-signup.json \
  --require-attestation --trusted-rp-broker https://rp-broker.example

# A local development server
pnpm validate:discovery http://localhost:3001/.well-known/agent-signup.json
```

`--verify-attestation` fetches `attestation.uri` only after the mode and host binding pass. A typed
broker answer is reported as the attestation status (`suspended`, `unverified`, `invalid`, or
`unavailable`) and the discovery document stays conformant; the run exits `0` unless
`--require-attestation` is set. A source URI on a loopback/private address is refused unless the input
origin itself is `localhost`/`127.0.0.1`, and plain `http` sources are refused outside the localhost
development exception.

## 4. Offline, deterministic runs

Attestation verification is reproducible without network access. Two fixture modes are supported: a
pinned `--source-response` (the source response is injected, no fetch at all) and a live fetch of a
local URL.

```bash
# Broker-managed, offline: inject the source response
pnpm validate:discovery fixtures/valid-attestation-broker.json \
  --verify-attestation --require-attestation \
  --trusted-rp-broker https://rp-broker.example \
  --jwks fixtures/keys/fixture-jwks-broker-1.json \
  --source-response fixtures/attestation-sources/ok-broker.json \
  --at 2026-10-24T00:00:00Z --json

# Provider-managed, offline: same flags, provider fixture and source body
pnpm validate:discovery fixtures/valid-attestation-provider.json \
  --verify-attestation --require-attestation \
  --trusted-rp-broker https://rp-broker.example \
  --jwks fixtures/keys/fixture-jwks-broker-1.json \
  --source-response fixtures/attestation-sources/ok-provider.json \
  --at 2026-10-24T00:00:00Z --json
```

- `--source-response <path>` is a **fixture-only offline testing flag**. The file is
  `{ "status": <number>, "body": <json>, "contentType": "<optional MIME>" }`. `contentType` defaults
  to `application/json` and is honoured by the `200` content-type check; the body is never echoed in
  an error. An injected response performs **no network I/O**, so the network-target probe refusal does
  not apply. A broker `403`/`404`/`410`/`503` fixture is how a typed broker failure is exercised
  offline.
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
with no trust flags performs no attestation verification and makes no network call for one. The two
checks are different questions and use different inputs:

- `issuer_allowlist` is a **host binding**: it says which broker origins this RP accepts for its
  `broker` source URI. It is read from the document under test.
- The trusted-broker list (`--trusted-rp-broker` / `AGENT_IDENTITY_TRUSTED_RP_BROKERS`) is
  **identity trust**: it says which broker issuers *this verifier* accepts. A URI may pass the
  `issuer_allowlist` host binding and still fail the trusted-broker check, and vice versa. When no
  trusted-broker list is configured, the binding check applies `issuer_allowlist` only and says so in
  the check message.

## 5. Machine-readable output (`--json`)

`--json` prints a single stable machine-readable result on stdout:

```bash
pnpm --silent validate:discovery https://example.com/.well-known/agent-signup.json --json | jq .
```

> **Use `--silent`.** `pnpm` prints its own run banner to stdout. Pass `--silent` (`-s`) so that
> stdout is *pure* JSON.

Exit status is the contract; the JSON is evidence. The v1.3.0 additions:

```json
{
  "validator": "agent-identity-protocol",
  "validatorVersion": "2.0.0",
  "valid": true,
  "exitCode": 0,
  "conformance": { "valid": true, "evaluated": true, "errors": [], "warnings": [] },
  "attestation": {
    "present": true, "checked": true, "required": true, "verified": true,
    "status": "verified", "reason": null,
    "mode": "broker",
    "source_uri": "https://rp-broker.example/api/broker/provider-verification?origin=…&audience=vaporcloud",
    "iss": "https://rp-broker.example", "jti": "rpa_…",
    "origin": "https://vaporcloud.example", "audience": "vaporcloud",
    "level": "domain", "expires_at": 1792886400,
    "checked_at": "2026-10-24T00:00:00.000Z",
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
`expired`, `unavailable`, `suspended`, or `not_checked` (no verification was performed:
`--verify-attestation` was not requested, or the `attestation` object itself is malformed and failed
conformance). `suspended` is emitted only for a broker-managed typed `403 provider_suspended`; the
validator never calls the signed status endpoint. `attestation.mode` and `attestation.source_uri`
record which publication mode and URI produced the token, and `attestation.expires_at` is the JWT
`exp` in epoch seconds when the claims parsed.

`invalid` is reserved for evidence that was obtained but failed verification:
`source_document_invalid`, `source_uri_invalid`, `attestation_issuer_mismatch`, a typed `400`/`410`,
or the unchanged JWT reasons. A malformed `attestation` object is **conformance-only**: exit `1`,
`attestation.status` `not_checked`, reason `field_malformed`. A failed host binding is also
conformance-only: `not_checked` with reason `binding_failed`, and the URI is never fetched.

Stable attestation check ids: `attestation.field.present`, `attestation.field.format`,
`attestation.source` (skip when verification was not requested), `attestation.source_document`,
`attestation.source_issuer`, `attestation.jws.parse`, `attestation.typ`, `attestation.alg`,
`attestation.kid`, `attestation.claims`, `attestation.window`, `attestation.origin`,
`attestation.audience`, `attestation.issuer_trusted`, `attestation.jwks`, and `attestation.signature`.

### Verification reason codes

`attestation.reason` is one of the frozen strings below (`null` when `verified`). Downstream verifiers
consume them; do not rename one without a contract decision.

| Reason | Status | Meaning |
| :--- | :--- | :--- |
| `absent` | `unverified` | No `attestation` object in discovery. Conformant. |
| `not_checked` | `not_checked` | A source is present but verification was not requested. |
| `field_malformed` | `not_checked` | The `attestation` object is not `{ mode, uri }`. Conformance failure. |
| `binding_failed` | `not_checked` | The source URI failed its mode host binding; it was never fetched. Conformance failure. |
| `attestation_expired` | `expired` | `exp` is before now minus 60 seconds of skew. |
| `origin_unverifiable` | `unavailable` | No fetch/declared origin, so `rp.origin` cannot be bound (file mode). |
| `provider_suspended` | `suspended` | Typed broker `403`. |
| `attestation_not_found` | `unverified` | Typed broker `404`: unknown pair, wrong mode, unverified origin, or no attestation. |
| `attestation_revoked` | `invalid` | Typed broker `410`. |
| `invalid_request` | `invalid` | Typed broker `400`. |
| `rate_limited` | `unavailable` | Typed broker `429`. |
| `broker_unavailable` | `unavailable` | Broker `5xx`, or the broker source could not be fetched. |
| `source_unavailable` | `unavailable` | Provider source could not be fetched, or returned a non-`200`. |
| `source_document_invalid` | `invalid` | Non-JSON body, wrong `Content-Type`, wrong envelope key, raw JWT body, oversize value. |
| `source_response_unreadable` | `unavailable` | The fixture `--source-response` file could not be read or parsed. |
| `attestation_issuer_mismatch` | `invalid` | Broker mode: `iss` does not equal the source URI origin. |
| `source_uri_invalid` | `invalid` | Broker mode: the source URI cannot be parsed as an absolute URL for the `iss` binding. |

The unchanged JWT reasons are `jws_parse`, `wrong_typ`, `wrong_alg`, `missing_kid`, `claims_invalid`,
`unknown_kid`, `duplicate_jwk_kid`, `bad_signature`, `not_yet_valid`, `wrong_origin`, `wrong_audience`,
`audience_unverifiable`, `rp_broker_untrusted`, and `rp_broker_unavailable`.

Human output adds `ATTESTATION: <status>`, prints attestation warnings as `[WARN] attestation.warning …`,
`DOCUMENT: VALID|INVALID|NOT CHECKED`, and `RESULT: OK|FAILED|COULD NOT FETCH`. `DOCUMENT: NOT CHECKED`
is printed on exit `2` (with `n/a`) because there is no document to judge.

## 6. Exit codes

| Code | Meaning |
| :--- | :--- |
| `0` | Document fetched, parsed, and conformant; no required check failed. `unverified` / `expired` / `invalid` / `suspended` without `--require-attestation` stays `0`. |
| `1` | Document parsed and a required check failed: a conformance error (including malformed JSON, a malformed `attestation` object, a failed source host binding, or a present `rp_attestation`), or an attestation failure under `--require-attestation` that is not `unavailable`. |
| `2` | The run could not obtain what it needed: document read/fetch failure (missing file, network, status, size), or JWKS/source unavailable under `--require-attestation`. Never a conformance verdict: `conformance.valid` is `null`, `conformance.evaluated` is `false`, and human output prints `DOCUMENT: NOT CHECKED`. |

Status-to-exit mapping (when the document is otherwise conformant):

| Attestation status | No flag | `--verify-attestation` | `--require-attestation` |
| :--- | :--- | :--- | :--- |
| absent (`unverified`) | `0` | `0` + warning | `1` (`rp_unverified` equivalent) |
| `verified` | `0` | `0` | `0` |
| `not_checked` (no verification performed: flag absent, or the object is malformed) | `0` | `0` | n/a |
| `expired` | `0` | `0` + warning | `1` |
| `invalid` / `attested_untrusted_broker` / `suspended` | `0` | `0` + warning | `1` |
| `unavailable` (including a typed `429`/`5xx`) | `0` | `0` + warning | `2` |

A malformed `attestation` object or a failed host binding is a conformance failure (`1`) regardless of
flags; the `attestation` object reports `not_checked` because there is no source to fetch. `invalid`
means evidence was obtained and a named verification check failed. The exit-code distinction is “no
document / no evidence” (`2`, operational, `DOCUMENT: NOT CHECKED`) versus “bad document or failed
gate” (`1`, conformance/verification). Both are non-zero, so any gate that only checks exit status
still fails correctly.

## 7. Flags

| Flag | Behavior |
| :--- | :--- |
| `--verify-attestation` | Fetch and verify the source named by `attestation.uri`; opt-in source fetch and issuer JWKS fetch. Absent `attestation` → `unverified` + warning, exit unchanged; present without the flag → `not_checked`. |
| `--require-attestation` | Implies `--verify-attestation`; a non-`verified` result fails the run (`unavailable` exits `2`). |
| `--trusted-rp-broker <issuer>` | Repeatable. Flags override the env fallback; if any flag is present the env list is ignored. Env fallback `AGENT_IDENTITY_TRUSTED_RP_BROKERS`. Empty effective list = nothing trusted. |
| `--jwks <path-or-url>` | Pin exactly one issuer’s JWKS for offline runs; never bypasses signature checks and never merges issuers. |
| `--at <rfc3339\|epoch>` | Freeze the clock for deterministic fixture runs; not for production use. |
| `--source-response <path>` | Fixture-only offline testing: read the source response from `{ status, body, contentType? }` instead of fetching. No network I/O; the body is never echoed. |

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
invalid (exit `1`). `--probe-jwks` checks the **assertion** issuers in `issuer_allowlist`; the source
named by `attestation.uri` is fetched only by `--verify-attestation` (or injected with
`--source-response`), and the RP-broker JWKS only with it.

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

- Only the top-level URL you provide, an explicitly requested probe target, an explicitly requested
  attestation source, or the explicitly requested attestation issuer JWKS is ever fetched.
- URLs discovered inside the document body — including `terms.url`, `spec`, `provider_url`, and
  anything under `extensions` — are **never** followed by default. `attestation.uri` is the single
  exception: it is fetched only under `--verify-attestation`, only after its mode and host binding
  pass, and never for a conformance-only run.
- An unbound or untrusted source host is rejected **before** the source fetch, and an untrusted
  attestation `iss` is rejected **before** any JWKS fetch, so a document cannot steer the verifier at
  a third-party host.
- A source fetch never follows a cross-origin redirect, and the source body or a token from it is never
  echoed into an error message.
- For a trusted issuer without `--jwks`, broker metadata is fetched from that issuer's
  `/.well-known/agent-broker.json`; only a validated, same-origin HTTPS `jwks_uri` is followed,
  otherwise the fixed `/.well-known/jwks.json` fallback is used.
- `terms.url` and all document content are treated as data and are never executed or interpreted.
  The validator does not fetch `terms.url`.
- Every fetch applies the timeout, the 1 MiB read cap, and the three-hop same-origin redirect limit.
- JWKS are cached per `iss` and never merged; `--jwks` applies to one issuer.
- `http://localhost` / `http://127.0.0.1` are permitted for development only. The specific development
  source case behaves like this: an `http` source is refused unless the *input* origin is
  localhost/127.0.0.1, and a source on a loopback/link-local/private address is refused the same way,
  so a public document cannot aim the validator at an internal target.

## 11. Fixture harness and registry validator

Both are **manual harnesses, not test frameworks** (`AGENTS.md` forbids tests in this repository).

### `pnpm validate:fixtures [fixtures/expected.json]`

Reads the expected result for every standalone fixture from `fixtures/expected.json`, exercises the
same code as the CLI, and exits `0` (all rows match) or `1` (a row differs). It covers the discovery
matrix (including the `attestation` modes, host binding, the removed field, and typed broker
403/404/410/503 rows), every attestation JWS (status plus producer/verifier schema mode, including the
keyless `keys: []` row), source documents, receipts, abuse reports, status responses, broker metadata,
and provider request/response examples. See [`fixtures/README.md`](./fixtures/README.md).

### `pnpm validate:registry [path] [--json]`

Validates `registry/implementations.json` against `registry/implementations.schema.json` and the
registry rules: conformance and verification are separate, `verification` is an optional five-field
snapshot, and duplicate discovery URLs are an error. Exit `0` valid, `1` invalid, `2` unreadable or
unparseable. `--json` emits `{valid, exitCode, errors, warnings}`.

## 12. `--json` field reference (for the implementation registry)

| Field | Type | Notes |
| :--- | :--- | :--- |
| `validator` | string | Always `"agent-identity-protocol"`. |
| `validatorVersion` | string | The `VALIDATOR_VERSION` constant, `"2.0.0"`. |
| `mode` | `"file"` \| `"url"` | How the document was obtained. |
| `source` | string | The path or URL that was validated. |
| `valid` | boolean | `true` iff `exitCode === 0` (the run result). |
| `exitCode` | number | `0`, `1`, or `2` (see §6). |
| `conformance` | object | `{ valid, evaluated, errors, warnings }` — the document-only verdict. `valid` is `true`/`false`, or `null` when the document was never obtained; `evaluated` is `false` only on exit `2`. |
| `attestation` | object | `{ present, checked, required, verified, status, reason, mode, source_uri, iss, jti, origin, audience, level, expires_at, checked_at, jwks_source, checks, errors, warnings }`. Always an object. |
| `protocol` | string \| null | `protocol` from the document, if present. |
| `audience` | string \| null | `audience` from the document, if present. |
| `providerName` | string \| null | `provider_name`, if present. |
| `signupEndpoint` | string \| null | `endpoints.agent_signup`, if present. |
| `terms` | object \| null | `{ version, url }` from the document; the validator does not fetch or hash `terms.url`. |
| `fetchFailure` | string \| null | Non-null only on exit `2`. |
| `counts` | object | `{ passed, failed, warnings, probes }` — stable keys. |
| `checks` | array | One entry per document check: `{ id, title, status, message, expected?, actual?, path? }`. |
| `probes` | array | `{ id, kind, target, status, message }`; `kind` is `jwks` or `endpoint`. |
| `errors` | array of strings | Failing document checks and probes, each `"<id>: <message>"`; on exit `2` this holds the operational `source` failure. |
| `warnings` | array of strings | Document warnings plus attestation warnings/errors, each `"<id>: <message>"`. |

The registry records `source` as `discovery_url` and reads `audience` and `protocol` directly;
`capabilities` remain protocol capabilities only (`agent_signup`, `post_signup_context`). A registry
`verification` object is a **snapshot** at `checked_at`; it is not produced by this validator.
