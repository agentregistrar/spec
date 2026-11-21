/**
 * Validator identity and version constants.
 *
 * `VALIDATOR_VERSION` is the version of the validator's *behaviour*, surfaced in
 * `--json` evidence and in the `User-Agent` header. It tracks the specification
 * release. `v2.0.0` is the URL-hosted-terms and keyless-RP-attestation release:
 * the validator no longer requires or recomputes `terms.text`/`terms.sha256`,
 * and Contract G `keys` allows 0-8 entries.
 */
export const VALIDATOR_ID = "agent-identity-v1";
export const VALIDATOR_VERSION = "2.0.0";
