# Discovery Conformance Validator (`agent-identity-v1`)

- **Source:** `src/validate-discovery.ts` — run with `pnpm validate:discovery`.
- **Normative references:** [`agent-identity-v1.md`](./agent-identity-v1.md),
  [`scope-boundaries.md`](./scope-boundaries.md).
- The validator is the objective mechanism behind the rule “a Relying Party that claims
  `agent-identity-v1` support MUST publish a valid discovery document.” It validates against the
  `AgentSignupDiscoverySchema` exported by this package (the implementation source of truth) and the
  checked-in [`agent-signup.schema.json`](./agent-signup.schema.json), and it independently enforces
  the identity-only scope boundary.

## 1. What it does

Given a discovery URL or a local JSON file, the validator:

1. Fetches (URL mode) or reads (file mode) the document with a timeout, a bounded read (1 MiB cap),
   and a same-origin redirect limit of three hops; in URL mode it also requires HTTPS, `200 OK`, and
   `Content-Type: application/json` (and reports cache/CORS headers).
2. Validates the body against `AgentSignupDiscoverySchema` and against
   `agent-signup.schema.json`. Zod + the written specification win; any divergence between the two
   schemas is reported, never hidden.
3. Recomputes the SHA-256 over the exact UTF-8 bytes of `terms.text` and fails on mismatch, printing the
   expected and actual digest.
4. Fails any forbidden vendor capability surface **at any nesting depth — including under
   `extensions`** — and warns (without failing) on unknown top-level fields and non-reverse-DNS
   `extensions` keys.

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

## 3. URL mode

Validate a live discovery document. HTTPS is required; `http://localhost` / `http://127.0.0.1` are the
documented development exception to the HTTPS requirement:

```bash
# Production: canonical HTTPS origin
pnpm validate:discovery https://example.com/.well-known/agent-signup.json

# A local development server
pnpm validate:discovery http://localhost:3001/.well-known/agent-signup.json
```

## 4. Machine-readable output (`--json`)

`--json` prints a single stable machine-readable result on stdout:

```bash
pnpm --silent validate:discovery https://example.com/.well-known/agent-signup.json --json | jq .
```

> **Use `--silent`.** `pnpm` prints its own run banner (`> package@version script …`) to stdout. Pass
> `--silent` (`-s`) so that stdout is *pure* JSON. The validator itself always writes only the JSON
> object.

Exit status is the contract; the JSON is evidence. Stable top-level fields (see §9 for the full
reference):

```json
{
  "validator": "agent-identity-v1",
  "validatorVersion": "1.0.0",
  "mode": "url",
  "source": "https://example.com/.well-known/agent-signup.json",
  "valid": true,
  "exitCode": 0,
  "protocol": "agent-identity-v1",
  "audience": "vaporcloud",
  "providerName": "VaporCloud",
  "signupEndpoint": "https://example.com/api/signup/agent",
  "terms": { "version": "2026.1", "url": "https://example.com/terms", "sha256": "sha256:…" },
  "fetchFailure": null,
  "counts": { "passed": 15, "failed": 0, "warnings": 0, "probes": 0 },
  "checks": [{ "id": "field.protocol", "title": "protocol", "status": "pass", "message": "…" }],
  "probes": [],
  "errors": [],
  "warnings": []
}
```

## 5. Exit codes

| Code | Meaning |
| :--- | :--- |
| `0` | Valid conformant document (warnings are allowed and do not change the code). |
| `1` | A document was obtained and parsed, but it failed conformance (schema, hash, forbidden vendor fields, invalid fields, or a failed opt-in probe). |
| `2` | Could **not** fetch a usable document: unreadable file, network/timeout failure, redirect limit or cross-origin redirect, non-`200` status, wrong content type, over the size cap, or an unparseable JSON body. |

The distinction is “no document” (`2`, operational) versus “bad document” (`1`, conformance). Both are
non-zero, so any gate that only checks exit status still fails correctly.

## 6. Opt-in probes (safe, non-destructive, off by default)

The default run performs **no** extra requests. Probes are opt-in:

```bash
# Fetch GET <issuer>/.well-known/jwks.json for every issuer and require >=1 verification key:
pnpm validate:discovery https://example.com/.well-known/agent-signup.json --probe-jwks

# Non-destructively HEAD (then OPTIONS) the advertised agent_signup endpoint:
pnpm validate:discovery https://example.com/.well-known/agent-signup.json --probe-endpoints
```

Probes never `POST`, never trigger signup or provisioning, and are limited to the issuers in
`issuer_allowlist` and the advertised `endpoints.agent_signup`. A failed probe makes the overall result
invalid (exit `1`).

## 7. Why vendor capability fields fail conformance

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

## 8. Safety

- Only the top-level URL you provide (and explicitly requested probe targets) is ever fetched.
- URLs discovered inside the document body — including `terms.url`, `spec`, `provider_url`, and
  anything under `extensions` — are **never** followed by default.
- `terms.text` and all document content are treated as data and are never executed or interpreted.
- Every fetch applies the timeout, the 1 MiB read cap, and the three-hop same-origin redirect limit.
- `http://localhost` / `http://127.0.0.1` are permitted for development only.

## 9. `--json` field reference (for the implementation registry)

| Field | Type | Notes |
| :--- | :--- | :--- |
| `validator` | string | Always `"agent-identity-v1"`. |
| `validatorVersion` | string | Validator release, currently `"1.0.0"`. |
| `mode` | `"file"` \| `"url"` | How the document was obtained. |
| `source` | string | The path or URL that was validated. |
| `valid` | boolean | `true` iff `exitCode === 0`. |
| `exitCode` | number | `0`, `1`, or `2` (see §5). |
| `protocol` | string \| null | `protocol` from the document, if present. |
| `audience` | string \| null | `audience` from the document, if present. |
| `providerName` | string \| null | `provider_name`, if present. |
| `signupEndpoint` | string \| null | `endpoints.agent_signup`, if present. |
| `terms` | object \| null | `{ version, url, sha256 }` (the digest that was recomputed). |
| `fetchFailure` | string \| null | Non-null only on exit `2`. |
| `counts` | object | `{ passed, failed, warnings, probes }` — stable keys. |
| `checks` | array | One entry per check: `{ id, title, status, message, expected?, actual?, path? }`. `status` is `pass`/`fail`/`warn`/`skip`; the array order is stable. |
| `probes` | array | `{ id, kind, target, status, message }`; `kind` is `jwks` or `endpoint`. |
| `errors` | array of strings | Combined failing checks and probes, each `"<id>: <message>"`. |
| `warnings` | array of strings | Warning checks, each `"<id>: <message>"`. |

The registry should record `source` as `discovery_url` and read `audience` and `protocol` directly;
`capabilities` remain protocol capabilities only (`agent_signup`, `post_signup_context`).
