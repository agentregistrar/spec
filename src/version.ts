/**
 * Validator identity and version constants.
 *
 * `VALIDATOR_VERSION` is the version of the validator's *behaviour*, surfaced in
 * `--json` evidence and in the `User-Agent` header. It tracks the specification
 * release. The value is derived from `package.json` so the package version is
 * the single source of truth. `new URL("../package.json", import.meta.url)`
 * resolves the same file from `src/version.ts` (under `tsx`) and from
 * `dist/version.js` (under Node.js), because both directories are direct
 * children of the package root. `v2.1.0` renames the protocol from
 * `agent-identity-v1` to the Agent Identity Protocol
 * (`protocol: "agent-identity-protocol"`, `protocol_version: "2.0"`, broker
 * metadata `protocol_versions: ["2.0"]`, and attestation
 * `aud: "agent-identity-protocol"`).
 */
import { readFileSync } from "node:fs";

const pkg = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as { version: string };

export const VALIDATOR_ID = "agent-identity-protocol";
export const VALIDATOR_VERSION: string = pkg.version;
