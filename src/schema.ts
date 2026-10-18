/**
 * Contract D.1 — Relying Party Discovery (identity-only v1).
 *
 * Published by a relying party at `GET /.well-known/agent-signup.json` and
 * consumed by agents to drive brokered signup. The normative definition lives in
 * `agent-identity-v1.md`; this Zod schema is the canonical implementation
 * source of truth for that identity-only v1 document. Consumers (the private
 * monorepo, future npm users of `@agentregistrar/discovery`) depend on this
 * package, so the public copy here is authoritative.
 *
 * The document is a **parameter document, not a capability catalog**. Vendor
 * capability surface (product catalogs/SKUs, provisioning endpoints, legacy
 * email/OTP endpoints, and broker receipt callbacks) is forbidden and is
 * actively rejected by {@link AgentSignupDiscoverySchema}.
 *
 * Field-preservation policy (spec §5.4 and §13):
 * - Unknown *additive* fields are allowed and **preserved** (`.passthrough()`),
 *   so v1 can evolve additively without silent data loss.
 * - Non-capability vendor metadata SHOULD be namespaced under
 *   `extensions.<reverse-dns-namespace>`; the conformance validator warns about
 *   unknown non-namespaced fields so typos stay visible.
 * - Only the explicitly removed vendor fields are rejected; a blanket `.strict()`
 *   would make additive evolution impossible.
 */
import { createHash } from "node:crypto";

import { z } from "zod";

/**
 * Computes the canonical `sha256:<64 lowercase hex>` content hash used to
 * reference immutable content (the relying party terms text, the Master ToS,
 * etc.) over the exact UTF-8 bytes of `content`.
 */
function computeSha256Prefixed(content: string): string {
  const digest = createHash("sha256").update(content, "utf8").digest("hex");
  return `sha256:${digest}`;
}

/** Hostnames that may use plain `http://` as the documented development exception. */
const DEV_LOCALHOST_HOSTNAMES = new Set(["localhost", "127.0.0.1"]);

/** Parses `value` as an absolute `http(s)` URL, returning `null` otherwise. */
function parseAbsoluteHttpUrl(value: string): URL | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return null;
  }
  return url;
}

/** True for `http://localhost` / `http://127.0.0.1` development origins. */
function isDevelopmentOrigin(url: URL): boolean {
  return url.protocol === "http:" && DEV_LOCALHOST_HOSTNAMES.has(url.hostname);
}

/**
 * Absolute protocol URL: `https://` everywhere, with the documented
 * `http://localhost` / `http://127.0.0.1` development exception (spec §5.4).
 */
function isAbsoluteProtocolUrl(value: string): boolean {
  const url = parseAbsoluteHttpUrl(value);
  if (url === null) {
    return false;
  }
  return url.protocol === "https:" || isDevelopmentOrigin(url);
}

/**
 * Absolute issuer origin: scheme + host (optional port), no path, query,
 * fragment, or wildcard. A single trailing slash is tolerated (normalized away).
 */
function isAbsoluteOrigin(value: string): boolean {
  if (value.includes("*")) {
    return false;
  }
  const trimmed = value.replace(/\/+$/, "");
  const url = parseAbsoluteHttpUrl(trimmed);
  if (url === null) {
    return false;
  }
  if (url.protocol !== "https:" && !isDevelopmentOrigin(url)) {
    return false;
  }
  if (url.pathname !== "/" && url.pathname !== "") {
    return false;
  }
  return url.search === "" && url.hash === "";
}

/** Normalizes an origin for duplicate detection (trailing slashes removed). */
function normalizeOrigin(value: string): string {
  return value.replace(/\/+$/, "");
}

/** True when every entry of `values` (after normalization) is unique. */
function hasNoDuplicates(values: readonly string[]): boolean {
  const normalized = values.map(normalizeOrigin);
  return new Set(normalized).size === normalized.length;
}

/** Minimal email shape accepted for the optional `contact` field. */
const EMAIL_PATTERN = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/** Absolute `http(s)` protocol URL, with the localhost development exception. */
const absoluteProtocolUrl = z
  .string()
  .min(1)
  .refine(isAbsoluteProtocolUrl, {
    message:
      "must be an absolute http(s) URL (https required except http://localhost / http://127.0.0.1)",
  });

/** Absolute issuer origin with no path/query/fragment/wildcard (spec §5.4). */
const issuerOrigin = z
  .string()
  .min(1)
  .refine(isAbsoluteOrigin, {
    message:
      "must be an absolute issuer origin with no path, query, fragment, or wildcard",
  });

/** `sha256:<64 lowercase hex characters>` (spec §6). */
const sha256Hash = z
  .string()
  .regex(
    /^sha256:[0-9a-f]{64}$/,
    "must use the form `sha256:<64 lowercase hex characters>`",
  );

/** Non-empty, whitespace-free service identifier (spec §5.1). */
const audience = z
  .string()
  .min(1)
  .refine((value) => !/\s/.test(value), {
    message: "must be a stable, whitespace-free service identifier",
  });

/** Email address or absolute `http(s)` URL (spec §5.2). */
const contact = z
  .string()
  .min(1)
  .refine((value) => EMAIL_PATTERN.test(value) || isAbsoluteProtocolUrl(value), {
    message: "must be an email address or an absolute http(s) URL",
  });

/**
 * Strict RFC 3339 / ISO 8601 date-time for human/debuggability (spec §5.2).
 * `offset: true` accepts an explicit `Z` or numeric offset and rejects bare
 * dates and implementation-specific strings that `Date.parse` would accept, so
 * Zod agrees with the checked-in JSON Schema's `format: date-time`.
 */
const iso8601Timestamp = z
  .string()
  .datetime({ offset: true, message: "must be a valid RFC 3339 date-time" });

/**
 * Identity-only v1 discovery document served at `/.well-known/agent-signup.json`.
 *
 * Required: `protocol`, `audience`, `provider_name`, `issuer_allowlist`,
 * `required_scopes`, `terms` (`version`/`url`/`sha256`/`text`), and
 * `endpoints.agent_signup` — the only endpoint.
 *
 * The removed vendor fields (`instance_catalog`, `endpoints.provision`,
 * `endpoints.email_signup`, `endpoints.verify_otp`, and
 * `endpoints.broker_signup_receipt`) are declared as `z.never()` so the schema
 * *rejects* them, while genuinely unknown additive identity fields and
 * `extensions` data are allowed and preserved.
 */
export const AgentSignupDiscoverySchema = z
  .object({
    protocol: z.literal("agent-identity-v1"),

    audience,
    provider_name: z.string().min(1),

    // Optional identity metadata.
    spec: absoluteProtocolUrl.optional(),
    provider_url: absoluteProtocolUrl.optional(),
    contact: contact.optional(),
    updated_at: iso8601Timestamp.optional(),

    issuer_allowlist: z
      .array(issuerOrigin)
      .min(1, "issuer_allowlist must contain at least one issuer origin")
      .refine(hasNoDuplicates, "issuer_allowlist entries must be unique"),

    required_scopes: z
      .array(z.string().min(1))
      .min(1, "required_scopes must contain at least one scope")
      .refine(hasNoDuplicates, "required_scopes entries must be unique")
      .refine(
        (scopes) => scopes.includes("tos:accept"),
        "required_scopes must include `tos:accept`",
      ),

    terms: z
      .object({
        version: z.string().min(1),
        url: absoluteProtocolUrl,
        sha256: sha256Hash,
        text: z.string().min(1),
      })
      .passthrough()
      .superRefine((value, ctx) => {
        // spec §6: the advertised hash MUST be the SHA-256 of the exact UTF-8
        // bytes of `text` (no normalization, trimming, or HTML extraction).
        const expected = computeSha256Prefixed(value.text);
        if (value.sha256 !== expected) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["sha256"],
            message:
              "terms.sha256 must equal the SHA-256 of the exact UTF-8 bytes " +
              `of terms.text (expected ${expected})`,
          });
        }
      }),

    // `agent_signup` is the only v1 endpoint. The removed vendor endpoints are
    // forbidden and rejected; unknown additive endpoints are preserved.
    endpoints: z
      .object({
        agent_signup: absoluteProtocolUrl,

        // Forbidden vendor endpoints (removed from v1).
        provision: z.never().optional(),
        email_signup: z.never().optional(),
        verify_otp: z.never().optional(),
        broker_signup_receipt: z.never().optional(),
      })
      .passthrough(),

    // Non-capability vendor metadata keyed by reverse-DNS namespace.
    extensions: z.record(z.unknown()).optional(),

    // Forbidden vendor capability surface (removed from v1).
    instance_catalog: z.never().optional(),
  })
  .passthrough();

export type AgentSignupDiscovery = z.infer<typeof AgentSignupDiscoverySchema>;
