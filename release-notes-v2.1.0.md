# Release Notes — Agent Identity Protocol `v2.1.0`

- **Protocol identifier:** `agent-identity-protocol` (renamed from `agent-identity-v1`)
- **Protocol version:** `2.0` (carried separately in discovery `protocol_version` and broker metadata `protocol_versions`)
- **Specification / package version:** `v2.1.0`
- **Release date:** 2026-11-21
- **Normative specification:** [`agent-identity-protocol.md`](./agent-identity-protocol.md)
- **Previous release:** [`release-notes-v2.0.0.md`](./release-notes-v2.0.0.md)

`v2.1.0` renames the protocol from `agent-identity-v1` to the **Agent Identity Protocol**
(`agent-identity-protocol`) and separates the protocol name from the protocol version (`2.0`),
eliminating the `agent-identity-v1 (v2.0.0)` naming mismatch.

---

## 1. Protocol name and version split

### Discovery (`/.well-known/agent-signup.json`)

**Before (`v2.0.0`):**

```json
{
  "protocol": "agent-identity-v1",
  "audience": "vaporcloud"
}
```

**After (`v2.1.0`):**

```json
{
  "protocol": "agent-identity-protocol",
  "protocol_version": "2.0",
  "audience": "vaporcloud"
}
```

- `protocol` **MUST** be `"agent-identity-protocol"`.
- `protocol_version` is a new **REQUIRED** top-level field and **MUST** be `"2.0"`.
- Any other `protocol` or unsupported `protocol_version` value means the service is unsupported
  (never best-effort).

### Broker metadata (`/.well-known/agent-broker.json`)

- `protocol_versions` **MUST** contain `"2.0"` (replacing `"agent-identity-v1"`).

### Signed attestations and attestation status JWS

- Contract G RP attestations (`agent-rp-attestation+jwt`) and Contract I attestation status
  responses (`agent-rp-attestation-status+jwt`) use `"aud": "agent-identity-protocol"` (replacing
  `"agent-identity-v1"`).

---

## 2. Spec files, schema IDs, and validator updates

- Renamed normative specification file: `agent-identity-v1.md` -> `agent-identity-protocol.md`.
- Renamed relying-party guide: `implementing-agent-identity-v1.md` ->
  `implementing-agent-identity-protocol.md`.
- Updated canonical JSON Schema `$id` URLs from `/agent-identity/v1/*.schema.json` to
  `/protocol/*.schema.json`.
- Updated validator identity (`VALIDATOR_ID = "agent-identity-protocol"`,
  `VALIDATOR_VERSION = "2.1.0"`), added `field.protocol_version` conformance check, and exported
  `PROTOCOL_NAME`, `PROTOCOL_VERSION`, and `PROTOCOL_AUDIENCE` from `@agentregistrar/discovery`.
- Regenerated all discovery, broker metadata, attestation, status, and registry fixtures.

---

## 3. Migration checklist

1. **Broker metadata.** Serve `/.well-known/agent-broker.json` with `protocol_versions` containing
   `"2.0"` instead of `"agent-identity-v1"`.
2. **Discovery.** Publish `"protocol": "agent-identity-protocol"` and add the required
   `"protocol_version": "2.0"` to `/.well-known/agent-signup.json`.
3. **RP attestation audience.** Issue and verify Contract G RP attestations and Contract I status
   responses with `"aud": "agent-identity-protocol"` instead of `"agent-identity-v1"`.
4. **Validator check.** Run `npx @agentregistrar/discovery validate <url-or-file> --json` (or
   `pnpm validate:discovery ...` from a clone) and confirm `valid: true`; read `protocol` and
   `validatorVersion` from the output.

## 4. Validation evidence

No test framework is added (`AGENTS.md`). The manual harnesses were run from this repository:

| Check | Command | Result |
| :--- | :--- | :--- |
| Typecheck | `npm run typecheck` | exit `0`, no diagnostics |
| Fixture matrix | `npm run validate:fixtures` | `Summary: 81 passed, 0 failed`, exit `0` |
| Registry | `npm run validate:registry` | `RESULT: VALID — 0 error(s), 0 warning(s), exit 0` |
| Signed fixtures | `npm run sign:fixtures` | regenerated deterministically |

---

## 5. Related artifacts

- Normative spec: [`agent-identity-protocol.md`](./agent-identity-protocol.md)
- Implementation guide: [`implementing-agent-identity-protocol.md`](./implementing-agent-identity-protocol.md)
- Validator guide: [`validator.md`](./validator.md)
- Fixture matrix: [`fixtures/README.md`](./fixtures/README.md)
- Previous release: [`release-notes-v2.0.0.md`](./release-notes-v2.0.0.md)
