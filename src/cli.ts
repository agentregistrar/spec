#!/usr/bin/env node
/**
 * Published `bin` entry point for `@agentregistrar/discovery`.
 *
 * Supports both `npx @agentregistrar/discovery validate <url-or-file>` and
 * `npx @agentregistrar/discovery <url-or-file>`, plus `--version`/`-v`.
 *
 * It deliberately does not compare `process.argv[1]` with
 * `fileURLToPath(import.meta.url)`: that guard breaks when npm/npx invokes the
 * package through a symlinked bin shim. The dedicated bin file is always the
 * entry point, so no direct-invocation check is needed here.
 */
import { VALIDATOR_VERSION } from "./version.js";
import { runDiscoveryCli } from "./validate-discovery.js";

const args = process.argv.slice(2);

if (args[0] === "--version" || args[0] === "-v") {
  console.log(VALIDATOR_VERSION);
  process.exitCode = 0;
} else {
  const cliArgs = args[0] === "validate" ? args.slice(1) : args;
  runDiscoveryCli(cliArgs).catch((error: unknown) => {
    console.error("Validator crashed:", error instanceof Error ? error.stack ?? error.message : error);
    process.exitCode = 2;
  });
}
