# Agent Identity Protocol — Release Notes (`v2.2.1`)

- **Date:** 2026-11-23
- **Package:** `@agentregistrar/discovery@2.2.1`
- **Wire protocol:** `agent-identity-protocol` (`protocol_version: "2.0"`) — **no wire, schema, or validator-behavior changes**.

## Summary

Edge / Cloudflare Workers / Next.js Turbopack runtime compatibility patch for `@agentregistrar/discovery`:

1. Decoupled `src/schema.ts` from `src/http.ts` by keeping `isHttpsCanonicalOrigin` pure and local inside `schema.ts`, so the package root entry (`dist/index.js`) has zero `node:*` runtime imports and runs cleanly in Cloudflare Workers (`workerd`), Edge runtimes, Next.js `transpilePackages`, and browsers.
2. Removed the top-level `node:fs` `readFileSync("../package.json")` call from `src/version.ts` (version consistency remains enforced by `pnpm check:release`).
