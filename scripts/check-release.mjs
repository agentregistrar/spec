#!/usr/bin/env node
/**
 * Lightweight release-consistency gate (`pnpm check:release`).
 *
 * Plain Node ESM with zero dependencies. It proves the package version, the
 * compiled validator version, the specification header, the release notes, and
 * the built CLI all agree before a tag can publish. Exits 0 with a one-line
 * summary on success; prints every failure and exits 1 otherwise.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const failures = [];

function fail(message) {
  failures.push(message);
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

// 1. Read package.json version.
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const version = pkg.version;
if (typeof version !== "string" || version.length === 0) {
  fail("package.json has no string version");
}

// 2. The compiled validator version must equal the package version.
let builtVersion = null;
try {
  ({ VALIDATOR_VERSION: builtVersion } = await import(
    pathToFileURL(join(root, "dist", "version.js")).href
  ));
} catch (error) {
  fail(`could not import dist/version.js: ${errorMessage(error)}`);
}
if (builtVersion !== null && builtVersion !== version) {
  fail(`dist/version.js VALIDATOR_VERSION is ${JSON.stringify(builtVersion)}, expected ${JSON.stringify(version)}`);
}

// 3. The specification header must name this release in both places.
const specPath = join(root, "agent-identity-protocol.md");
if (!existsSync(specPath)) {
  fail("agent-identity-protocol.md is missing");
} else {
  const head = readFileSync(specPath, "utf8").split(/\r?\n/).slice(0, 15);
  const versionTag = `v${version}`;
  for (const marker of ["**Status:**", "**Specification release:**"]) {
    const line = head.find((entry) => entry.includes(marker));
    if (line === undefined) {
      fail(`agent-identity-protocol.md top 15 lines do not contain ${marker}`);
    } else if (!line.includes(versionTag)) {
      fail(`agent-identity-protocol.md ${marker} line does not contain ${versionTag}`);
    }
  }
}

// 4. The release notes for this version must exist.
const releaseNotes = `release-notes-v${version}.md`;
if (!existsSync(join(root, releaseNotes))) {
  fail(`${releaseNotes} is missing`);
}

// 5. The compiled package entry points must exist and the CLI must be executable
//    by a Node shebang.
for (const relativePath of ["dist/index.js", "dist/index.d.ts", "dist/cli.js"]) {
  if (!existsSync(join(root, relativePath))) {
    fail(`${relativePath} is missing (run \`pnpm build\`)`);
  }
}
const cliPath = join(root, "dist", "cli.js");
if (existsSync(cliPath)) {
  const firstLine = readFileSync(cliPath, "utf8").split(/\r?\n/, 1)[0];
  if (firstLine !== "#!/usr/bin/env node") {
    fail(`dist/cli.js must start with #!/usr/bin/env node (found ${JSON.stringify(firstLine)})`);
  }
}

// 6. The built CLI must validate the full conformant fixture as JSON.
const fixtureRun = spawnSync(
  process.execPath,
  ["dist/cli.js", "validate", "fixtures/valid-full.json", "--json"],
  { cwd: root, encoding: "utf8", maxBuffer: 10 * 1024 * 1024 },
);
if (fixtureRun.error !== undefined) {
  fail(`could not run dist/cli.js on fixtures/valid-full.json: ${errorMessage(fixtureRun.error)}`);
} else if (fixtureRun.status !== 0) {
  fail(
    `dist/cli.js validate fixtures/valid-full.json --json exited ${fixtureRun.status}: ${fixtureRun.stderr.trim()}`,
  );
} else {
  let parsed = null;
  try {
    parsed = JSON.parse(fixtureRun.stdout);
  } catch (error) {
    fail(`dist/cli.js fixture output is not valid JSON: ${errorMessage(error)}`);
  }
  if (parsed !== null) {
    if (parsed.valid !== true) {
      fail(`dist/cli.js fixture output has valid=${JSON.stringify(parsed.valid)}, expected true`);
    }
    if (parsed.validatorVersion !== version) {
      fail(
        `dist/cli.js fixture output has validatorVersion=${JSON.stringify(parsed.validatorVersion)}, expected ${JSON.stringify(version)}`,
      );
    }
  }
}

// 7. The built CLI must report the package version.
const versionRun = spawnSync(process.execPath, ["dist/cli.js", "--version"], {
  cwd: root,
  encoding: "utf8",
});
if (versionRun.error !== undefined) {
  fail(`could not run dist/cli.js --version: ${errorMessage(versionRun.error)}`);
} else if (versionRun.status !== 0) {
  fail(`dist/cli.js --version exited ${versionRun.status}: ${versionRun.stderr.trim()}`);
} else if (versionRun.stdout.trim() !== version) {
  fail(
    `dist/cli.js --version printed ${JSON.stringify(versionRun.stdout.trim())}, expected ${JSON.stringify(version)}`,
  );
}

// 8. Report every failure, or a one-line success summary.
if (failures.length > 0) {
  console.error(`check:release failed (${failures.length} problem(s)):`);
  for (const failure of failures) {
    console.error(`  - ${failure}`);
  }
  process.exit(1);
}

console.log(
  `check:release passed: @agentregistrar/discovery ${version} is consistent across package.json, spec header, release notes, and the built CLI.`,
);
