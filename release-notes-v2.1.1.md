# Release Notes - Agent Identity Protocol `v2.1.1`

- **Protocol identifier:** `agent-identity-protocol`
- **Protocol version:** `2.0`
- **Specification / package version:** `v2.1.1`
- **Release date:** 2026-11-22
- **Normative specification:** [`agent-identity-protocol.md`](./agent-identity-protocol.md)
- **Previous release:** [`release-notes-v2.1.0.md`](./release-notes-v2.1.0.md)

`v2.1.1` is a package and documentation patch. It ships the compiled JavaScript package with a
working `npx` CLI, makes `package.json` the single source of the validator version, and corrects the
`v2.1.0` documentation. It changes no wire format, schema, fixture, or validator behavior.

---

## 1. Compiled JS package and CLI `bin`

The npm package ships compiled JavaScript in `dist/` and declares `dist/cli.js` as its `bin`, so the
validator runs without cloning this repository:

```bash
npx @agentregistrar/discovery validate https://example.com/.well-known/agent-signup.json
npx @agentregistrar/discovery validate fixtures/valid-full.json --json
npx @agentregistrar/discovery --version
```

- Both `validate <target>` and a direct `<target>` are supported, so
  `npx @agentregistrar/discovery <url-or-file>` works as well.
- `--version` prints the package version.
- TypeScript declarations and the schema `exports` subpaths ship alongside the compiled entry points.
- `pnpm build` regenerates `dist/`; do not hand-edit it.

## 2. Single-source validator version and release gate

`VALIDATOR_VERSION` is read from `package.json` when the validator module loads at runtime, so
`package.json` remains the single source of truth. The version is not repeated in the validator
source, so the package version, specification header, release notes, and CLI output cannot drift
independently.

`pnpm check:release` is the release-consistency gate. The tag-triggered publish workflow runs it
after `pnpm build` and before publishing. It verifies:

- `dist/version.js` matches `package.json`;
- the specification header names the release;
- `release-notes-vX.Y.Z.md` exists;
- `dist/index.js`, `dist/index.d.ts`, and `dist/cli.js` exist and `dist/cli.js` has the Node shebang;
- the built CLI validates `fixtures/valid-full.json` as JSON and reports the same `validatorVersion`;
- the built CLI `--version` output matches the package version.

## 3. Documentation errata

This release closes the documentation errata tracked as `agentregistrar/spec#9`. It corrects current
release and package references, restores `agent-identity-v1` in the historical changelog and release
records, fixes the broker metadata `protocol_versions` value to `"2.0"`, adds the `protocol_version`
conformance requirement, and adds an ordered migration checklist to the `v2.1.0` release notes. There
is no wire format, schema, fixture, or validator-behavior change.

## 4. Validation evidence

No test framework is added (`AGENTS.md`). The manual gates were run from this repository:

| Check | Command | Result |
| :--- | :--- | :--- |
| Typecheck | `pnpm typecheck` | exit `0`, no diagnostics |
| Build | `pnpm build` | exit `0`, `dist/` rebuilt |
| Release consistency | `pnpm check:release` | exit `0`, version consistent across package, spec header, release notes, and built CLI |
| Fixture matrix | `pnpm validate:fixtures` | `Summary: 81 passed, 0 failed`, exit `0` |
| Registry | `pnpm validate:registry registry/implementations.json --json` | `{"valid":true,"exitCode":0,"errors":[],"warnings":[]}`, exit `0` |
