/**
 * Validator identity and version constants.
 *
 * `VALIDATOR_VERSION` is the version of the validator's *behaviour*, surfaced in
 * `--json` evidence and in the `User-Agent` header. It tracks the specification
 * release from `v1.3.0` onwards: the v1.3.0 validator adds the attestation-source
 * mode, host binding, removed-carrier check, and source fetch; v1.3.1 is a
 * contract-text patch with no validator behavior change, so the constant tracks
 * the package version.
 */
export const VALIDATOR_ID = "agent-identity-v1";
export const VALIDATOR_VERSION = "1.3.1";
