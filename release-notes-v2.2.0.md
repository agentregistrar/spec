# Release Notes — Agent Identity Protocol `v2.2.0`

- **Protocol identifier:** `agent-identity-protocol`
- **Protocol version:** `2.0`
- **Specification / package version:** `v2.2.0`
- **Release date:** 2026-11-23
- **Normative specification:** [`agent-identity-protocol.md`](./agent-identity-protocol.md)
- **Previous release:** [`release-notes-v2.1.1.md`](./release-notes-v2.1.1.md)

`v2.2.0` is a strictly additive minor release under `protocol_version: "2.0"`. It introduces
Day-2 agent re-authentication (`endpoints.agent_login`), Contract A assertion purpose isolation and
accepted-terms version attribution, anti-ATO account resolution rules, and optional provider-to-agent
Day-2 response Zod schemas (`AgentHandoffSchema`, `HumanActionRequiredSchema`, and
`TermsReacceptanceRequiredSchema`). Existing `v2.0`/`v2.1` discovery documents without
`endpoints.agent_login` remain 100% conformant.

---

## 1. Discovery (`/.well-known/agent-signup.json`)

- Added OPTIONAL `endpoints.agent_login` to [`agent-signup.schema.json`](./agent-signup.schema.json),
  `AgentSignupDiscoverySchema` (`src/schema.ts`), and `src/validate-discovery.ts`
  (`field.endpoints.agent_login`, `loginEndpoint` metadata, and `--probe-endpoints`).
- Enforces the same absolute HTTPS URL rule as `endpoints.agent_signup` (with the documented
  `http://localhost` / `http://127.0.0.1` development exception).
- Keeps `protocol: "agent-identity-protocol"` and `protocol_version: "2.0"` unchanged, and keeps all
  forbidden vendor endpoint checks (`provision`, `email_signup`, `verify_otp`,
  `broker_signup_receipt`) and forbidden vendor catalog checks intact.

---

## 2. Contract A Extensions, `agent_login` Handshake & Anti-ATO Rules

- **Contract A additive claims** (`agent-identity-protocol.md` §7.0):
  - Top-level `purpose?: "signup" | "login"` (`endpoints.agent_login` MUST require
    `purpose === "login"` and SHOULD reject replayed `jti` values; `endpoints.agent_signup` MUST
    reject `purpose === "login"`).
  - `delegation.accepted_rp_tos_version?: string` carrying the discovery `terms.version` string at
    acceptance time.
- **`POST endpoints.agent_login` handshake & anti-ATO resolution** (§7.4):
  - Normative lookup order: verify assertion → `(iss, sub)` → broker-created accounts under
    `(iss, human.id)` → pre-existing human-registered accounts matched by `human.email` (MUST NOT
    auto-link or grant access by email alone; MUST return `human_action_required` with
    `reason: "account_link_required"`) → `404 account_not_found`.
  - Successful logins mint per-session, revocable first-party credentials without invalidating
    active sessions on other devices.

---

## 3. Provider-to-Agent Day-2 Response Schemas

Exported from `@agentregistrar/discovery` (`src/schema.ts` and `src/index.ts`), strictly separate
from `AgentSignupDiscoverySchema` and `signup-receipt.schema.json`:

- `AgentHandoffSchema` (`session`, `mcp`, `cli`, `human_urls`) — closed (`.strict()`) at the root
  and every sub-object so executable shell command fields cannot sneak in, with strict HTTPS URL
  validation (localhost dev exception). Never placed in discovery or Contract E receipts, and never
  sent to or stored by the broker.
- `HumanActionRequiredSchema` (`error: "human_action_required"`, `reason`, `verification_url`,
  optional `user_code`, `expires_in`, `retry_after_seconds`, `error_description`).
- `TermsReacceptanceRequiredSchema` (`error: "terms_reacceptance_required"`,
  `expected_terms_version`, `terms_url`, optional `error_description`).

---

## 4. Fixtures

- Added [`fixtures/valid-with-agent-login.json`](./fixtures/valid-with-agent-login.json) (conformant
  discovery document with HTTPS `endpoints.agent_login`).
- Added [`fixtures/invalid-agent-login-http.json`](./fixtures/invalid-agent-login-http.json)
  (non-conformant discovery document with non-HTTPS `endpoints.agent_login`).
- Updated [`fixtures/expected.json`](./fixtures/expected.json) and
  [`fixtures/README.md`](./fixtures/README.md).

---

## 5. Validation evidence

No test framework is added (`AGENTS.md`). The manual gates were run from this repository:

| Check | Command | Result |
| :--- | :--- | :--- |
| Build | `pnpm build` | exit `0`, `dist/` rebuilt |
| Typecheck | `pnpm typecheck` | exit `0`, no diagnostics |
| Fixture matrix | `pnpm validate:fixtures` | `Summary: 83 passed, 0 failed`, exit `0` |
| Registry | `pnpm validate:registry` | `RESULT: VALID — 0 error(s), 0 warning(s), exit 0` |
| Release consistency | `pnpm check:release` | exit `0`, version consistent across package, spec header, release notes, and built CLI |
