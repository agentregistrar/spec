/**
 * Validator identity and version constants.
 *
 * `VALIDATOR_VERSION` is the version of the validator's *behaviour*, surfaced in
 * `--json` evidence and in the `User-Agent` header. It tracks the specification
 * release. `v2.1.0` renames the protocol from `agent-identity-v1` to the Agent
 * Identity Protocol (`protocol: "agent-identity-protocol"`,
 * `protocol_version: "2.0"`, broker metadata `protocol_versions: ["2.0"]`, and
 * attestation `aud: "agent-identity-protocol"`).
 */
export const VALIDATOR_ID = "agent-identity-protocol";
export const VALIDATOR_VERSION = "2.1.0";
