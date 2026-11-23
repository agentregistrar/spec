# Release Notes — Agent Identity Protocol `v2.3.0`

- **Protocol identifier:** `agent-identity-protocol`
- **Protocol version:** `2.0`
- **Specification / package version:** `v2.3.0`
- **Release date:** 2026-11-23
- **Normative specification:** [`agent-identity-protocol.md`](./agent-identity-protocol.md)
- **Previous release:** [`release-notes-v2.2.1.md`](./release-notes-v2.2.1.md)

`v2.3.0` is a strictly additive minor release under `protocol_version: "2.0"`. It adds optional
`signup_receipt_endpoint` to Contract I broker metadata (`/.well-known/agent-broker.json`) so
relying parties can discover a broker's Contract F receipt ingestion URL instead of hardcoding a
path, and documents the recommended asynchronous outbox delivery pattern and explicit HTTP
retryability matrix for Contract F. Signed receipts remain optional and strictly RP-signed:
keyless providers (`keys: []` or unverified) remain 100% conformant for base signup.

---

## 1. Contract I Broker Metadata (`/.well-known/agent-broker.json`)

- Added OPTIONAL `signup_receipt_endpoint` (`$ref: "#/$defs/httpsUrl"`, absolute HTTPS URL with no
  userinfo or whitespace) to [`broker-metadata.schema.json`](./broker-metadata.schema.json) and
  `BrokerMetadataSchema` (`src/schema.ts`).
- The six existing required fields (`issuer`, `jwks_uri`, `attestation_status_uri`,
  `abuse_endpoint`, `protocol_versions`, `contact`) remain unchanged, and
  `additionalProperties: false` / `.strict()` remains enforced with this 7th optional property.
- Cross-origin `signup_receipt_endpoint` is permitted under the same SSRF rules as
  `attestation_status_uri` and `abuse_endpoint`; same-origin is RECOMMENDED.
- Existing 6-field broker metadata documents without `signup_receipt_endpoint` remain 100% valid;
  clients fall back to `<issuer>/api/broker/signup-receipt` when metadata is absent or omits the
  field.
- Tightened `$defs.httpsUrl` in `broker-metadata.schema.json` and `absoluteHttpsUrl` in
  `src/schema.ts` so JSON Schema and Zod agree on rejecting URL userinfo and whitespace while
  keeping zero `node:*` imports in `src/schema.ts` (Edge/Cloudflare Workers compatible).

---

## 2. Contract F Asynchronous Delivery Profile & Retryability Matrix

- Documented the recommended non-blocking Contract F delivery pattern in
  [`agent-identity-protocol.md`](./agent-identity-protocol.md) §11.6 and
  [`implementing-agent-identity-protocol.md`](./implementing-agent-identity-protocol.md) §12:
  persist account → sign Contract E receipt using the captured attestation → enqueue
  `{ signup_token, rp_attestation }` in a durable outbox → return signup response immediately to
  the agent → deliver asynchronously to `signup_receipt_endpoint` with exponential-backoff retries.
- Documented the explicit HTTP retryability matrix:
  - **Retry with exponential backoff:** network errors, timeouts, `429` (`rate_limited`, respecting
    `Retry-After`), `503` (`rp_broker_unavailable`), and other `5xx` responses.
  - **Terminal (do not retry):** `200`/`201` (delivered / `deduplicated: true`), `400`
    (`invalid_request`), `401` (`invalid_attestation`, `rp_broker_untrusted`,
    `invalid_signup_token`, `attestation_not_valid_at_signing`, `attestation_unavailable`), and
    `409` (`signup_conflict`).
- Reaffirmed keyless base conformance: providers without RP signing keys remain conformant for
  brokered signup without issuing Contract E/F receipts.

---

## 3. Fixtures

- Existing [`fixtures/broker-metadata.json`](./fixtures/broker-metadata.json) continues to verify
  the omitted-`signup_receipt_endpoint` case.
- Added [`fixtures/broker-metadata-with-signup-receipt.json`](./fixtures/broker-metadata-with-signup-receipt.json)
  (valid, same-origin HTTPS `signup_receipt_endpoint`).
- Added [`fixtures/broker-metadata-cross-origin-signup-receipt.json`](./fixtures/broker-metadata-cross-origin-signup-receipt.json)
  (valid, cross-origin HTTPS `signup_receipt_endpoint`).
- Added [`fixtures/invalid-broker-metadata-http-signup-receipt.json`](./fixtures/invalid-broker-metadata-http-signup-receipt.json)
  (invalid, non-HTTPS `signup_receipt_endpoint`).
- Added [`fixtures/invalid-broker-metadata-userinfo-signup-receipt.json`](./fixtures/invalid-broker-metadata-userinfo-signup-receipt.json)
  (invalid, URL userinfo in `signup_receipt_endpoint`).
- Added [`fixtures/invalid-broker-metadata-unknown-property.json`](./fixtures/invalid-broker-metadata-unknown-property.json)
  (invalid, unknown 8th property rejected by `additionalProperties: false` / `.strict()`).
- Updated [`fixtures/expected.json`](./fixtures/expected.json) and
  [`fixtures/README.md`](./fixtures/README.md).

---

## 4. Validation evidence

No test framework is added (`AGENTS.md`). The manual gates were run from this repository:

| Check | Command | Result |
| :--- | :--- | :--- |
| Typecheck | `pnpm typecheck` | exit `0`, no diagnostics |
| Build | `pnpm build` | exit `0`, `dist/` rebuilt |
| Release consistency | `pnpm check:release` | exit `0`, version consistent across package, spec header, release notes, and built CLI |
| Fixture matrix | `pnpm validate:fixtures` | `Summary: 88 passed, 0 failed`, exit `0` |
| Registry | `pnpm validate:registry` | `RESULT: VALID — 0 error(s), 0 warning(s), exit 0` |
| Package dry-run | `npm pack --dry-run` | exit `0`, clean tarball contents |
