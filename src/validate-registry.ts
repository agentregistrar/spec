/**
 * Implementation registry validator (`pnpm validate:registry [path] [--json]`).
 *
 * Validates `registry/implementations.json` against
 * `registry/implementations.schema.json` and adds the registry rules the schema
 * cannot express:
 *
 * - a registry entry is about a discovery document, never a vendor capability;
 * - conformance and verification are separate, and `verification` is a snapshot
 *   at `checked_at` (the badge renders only for `active` at that instant);
 * - duplicate discovery URLs are an error, and a duplicate audience is a
 *   warning worth review.
 *
 * Exit codes match the discovery validator's semantics:
 *
 *   0  registry read, parsed, and valid
 *   1  registry read and parsed but failed validation
 *   2  could not read or parse a usable registry file
 */
import { readFile } from "node:fs/promises";

import { checkAgainstRootSchema, type SchemaError } from "./json-schema";

const DEFAULT_REGISTRY = "registry/implementations.json";
const SCHEMA_FILE = "registry/implementations.schema.json";

interface RegistryOptions {
  path: string;
  json: boolean;
  help: boolean;
}

interface RegistryResult {
  path: string;
  valid: boolean;
  exitCode: number;
  errors: string[];
  warnings: string[];
}

class UsageError extends Error {}

function parseArgs(argv: string[]): RegistryOptions {
  const options: RegistryOptions = { path: DEFAULT_REGISTRY, json: false, help: false };
  for (const arg of argv) {
    if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else if (arg === "--json") {
      options.json = true;
    } else if (arg.startsWith("-")) {
      throw new UsageError(`unknown flag: ${arg}`);
    } else {
      options.path = arg;
    }
  }
  return options;
}

function printHelp(): void {
  console.log(
    [
      "Implementation Registry Validator (agent-identity-v1)",
      "",
      "Usage:",
      "  pnpm validate:registry [path] [--json]",
      "",
      "Default path: registry/implementations.json (schema: registry/implementations.schema.json)",
      "",
      "Exit codes:",
      "  0  registry read, parsed, and valid",
      "  1  registry read and parsed but failed validation",
      "  2  could not read or parse a usable registry file",
      "",
      "A registry entry is a statement about a discovery document. Conformance and",
      "verification are separate: `verification` is an OPTIONAL snapshot at",
      "`checked_at`, and only `status: \"active\"` earns a verified badge.",
    ].join("\n"),
  );
}

function formatSchemaError(error: SchemaError): string {
  return `${error.path}: ${error.message}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function semanticChecks(registry: Record<string, unknown>): {
  errors: string[];
  warnings: string[];
} {
  const errors: string[] = [];
  const warnings: string[] = [];
  const entries = Array.isArray(registry.implementations)
    ? registry.implementations.filter(isRecord)
    : [];

  const seenUrls = new Map<string, string>();
  const seenAudiences = new Map<string, string>();

  entries.forEach((entry, index) => {
    const label = typeof entry.name === "string" ? entry.name : `implementations[${index}]`;

    if (typeof entry.discovery_url === "string") {
      const key = entry.discovery_url.replace(/\/+$/, "").toLowerCase();
      const existing = seenUrls.get(key);
      if (existing !== undefined) {
        errors.push(`${label}: discovery_url duplicates ${existing}`);
      } else {
        seenUrls.set(key, label);
      }
    }

    if (typeof entry.audience === "string") {
      const existing = seenAudiences.get(entry.audience);
      if (existing !== undefined) {
        warnings.push(
          `${label}: audience "${entry.audience}" is also used by ${existing}; audiences are meant to be stable and unique per provider`,
        );
      } else {
        seenAudiences.set(entry.audience, label);
      }
    }

    if (entry.verification === undefined) {
      // Absent `verification` is the normal "conformant, unverified" state.
      return;
    }
    const verification = isRecord(entry.verification) ? entry.verification : null;
    if (verification === null) {
      errors.push(`${label}: verification must be an object`);
      return;
    }
    if (verification.status !== "active") {
      warnings.push(
        `${label}: verification.status is "${String(verification.status)}" at checked_at; no verified badge renders`,
      );
    }
    if (typeof verification.checked_at === "string") {
      const checkedAt = Date.parse(verification.checked_at);
      if (!Number.isFinite(checkedAt)) {
        errors.push(`${label}: verification.checked_at is not an RFC 3339 timestamp`);
      } else if (checkedAt > Date.now() + 60_000) {
        warnings.push(`${label}: verification.checked_at is in the future`);
      }
    }
    if (
      typeof verification.attestation_jti === "string" &&
      !/^rpa_[0-9a-hjkmnp-tv-z]{26}$/.test(verification.attestation_jti)
    ) {
      errors.push(`${label}: verification.attestation_jti is not an rpa_ attestation id`);
    }
  });

  const latestValidated =
    entries
      .map((entry) => (typeof entry.validated_at === "string" ? entry.validated_at : null))
      .filter((value): value is string => value !== null)
      .sort()
      .at(-1) ?? null;
  if (
    latestValidated !== null &&
    typeof registry.updated_at === "string" &&
    registry.updated_at < latestValidated
  ) {
    warnings.push(
      `registry.updated_at (${registry.updated_at}) is older than the latest entry validated_at (${latestValidated})`,
    );
  }

  return { errors, warnings };
}

function humanResult(result: RegistryResult): string {
  const lines = [
    "agent-identity-v1 implementation registry validator",
    "",
    `Registry: ${result.path}`,
    `Schema  : ${SCHEMA_FILE}`,
    "",
  ];
  if (result.errors.length > 0) {
    lines.push("ERRORS");
    for (const error of result.errors) {
      lines.push(`  [FAIL] ${error}`);
    }
    lines.push("");
  }
  if (result.warnings.length > 0) {
    lines.push("WARNINGS");
    for (const warning of result.warnings) {
      lines.push(`  [WARN] ${warning}`);
    }
    lines.push("");
  }
  const verdict = result.exitCode === 0 ? "VALID" : result.exitCode === 2 ? "COULD NOT READ" : "INVALID";
  lines.push(
    `RESULT: ${verdict} — ${result.errors.length} error(s), ${result.warnings.length} warning(s), exit ${result.exitCode}`,
  );
  return lines.join("\n");
}

async function main(): Promise<void> {
  let options: RegistryOptions;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    console.error("Run `pnpm validate:registry --help` for usage.");
    process.exitCode = 2;
    return;
  }
  if (options.help) {
    printHelp();
    return;
  }

  let raw: string;
  try {
    raw = await readFile(options.path, "utf8");
  } catch (error) {
    const message = `could not read registry: ${error instanceof Error ? error.message : String(error)}`;
    if (options.json) {
      console.log(JSON.stringify({ valid: false, exitCode: 2, errors: [message], warnings: [] }));
    } else {
      console.error(message);
    }
    process.exitCode = 2;
    return;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    const message = `registry is not valid JSON: ${error instanceof Error ? error.message : String(error)}`;
    if (options.json) {
      console.log(JSON.stringify({ valid: false, exitCode: 2, errors: [message], warnings: [] }));
    } else {
      console.error(message);
    }
    process.exitCode = 2;
    return;
  }

  if (!isRecord(parsed)) {
    const message = "registry must be a JSON object";
    if (options.json) {
      console.log(JSON.stringify({ valid: false, exitCode: 1, errors: [message], warnings: [] }));
    } else {
      console.error(message);
    }
    process.exitCode = 1;
    return;
  }

  const schema = checkAgainstRootSchema(parsed, SCHEMA_FILE);
  const semantic = semanticChecks(parsed);
  const errors = [...schema.errors.map(formatSchemaError), ...semantic.errors];
  const result: RegistryResult = {
    path: options.path,
    valid: errors.length === 0,
    exitCode: errors.length === 0 ? 0 : 1,
    errors,
    warnings: semantic.warnings,
  };

  if (options.json) {
    console.log(
      JSON.stringify({
        valid: result.valid,
        exitCode: result.exitCode,
        errors: result.errors,
        warnings: result.warnings,
      }),
    );
  } else {
    console.log(humanResult(result));
  }
  process.exitCode = result.exitCode;
}

main().catch((error: unknown) => {
  console.error("Registry validator crashed:", error instanceof Error ? error.stack ?? error.message : error);
  process.exitCode = 2;
});
