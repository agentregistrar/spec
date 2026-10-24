/**
 * Validator identity and version constants.
 *
 * `VALIDATOR_VERSION` is the version of the validator's *behaviour*, surfaced in
 * `--json` evidence and in the `User-Agent` header. It tracks the specification
 * release from `v1.2.0` onwards: the v1.2.0 validator adds attestation
 * verification, so the constant is bumped with the package version.
 */
export const VALIDATOR_ID = "agent-identity-v1";
export const VALIDATOR_VERSION = "1.2.0";
