/**
 * A small, dependency-free JSON Schema (draft 2020-12 subset) evaluator.
 *
 * It exists for two jobs, both internal to this package:
 *
 * 1. the discovery validator's Zod/JSON-Schema agreement signal, and
 * 2. the fixture harness and registry validator, which must prove that the
 *    checked-in schema files actually validate (or reject) the checked-in
 *    fixtures without adding a JSON Schema library dependency.
 *
 * It deliberately implements only the keywords the schemas in this repository
 * use. A keyword it does not implement is ignored, exactly like a validator
 * that does not know an annotation — so the schemas here stay within the
 * supported subset. Cross-field invariants that JSON Schema cannot express
 * (`exp - iat`, `rp.id === sub`, unique `kid`, receipt windows) are enforced by
 * Zod and by the written spec.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { isRecord, parseAbsoluteHttpUrl } from "./http";

export interface SchemaError {
  path: string;
  message: string;
}

function resolveJsonPointer(root: unknown, ref: string): unknown {
  if (!ref.startsWith("#/")) {
    return undefined;
  }
  const parts = ref
    .slice(2)
    .split("/")
    .map((part) => part.replace(/~1/g, "/").replace(/~0/g, "~"));
  let current: unknown = root;
  for (const part of parts) {
    if (!isRecord(current) && !Array.isArray(current)) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function jsonTypeOf(value: unknown): string {
  if (value === null) {
    return "null";
  }
  if (Array.isArray(value)) {
    return "array";
  }
  return typeof value;
}

function matchesJsonType(value: unknown, type: string): boolean {
  if (type === "integer") {
    return typeof value === "number" && Number.isInteger(value);
  }
  return jsonTypeOf(value) === type;
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function deepEqual(a: unknown, b: unknown): boolean {
  return stableStringify(a) === stableStringify(b);
}

// --- JSON Schema `format: date-time` (ajv-formats `full`-mode parity) -------
//
// The checked-in discovery schema declares `updated_at` as `format: date-time`.
// A real `ajv` + `ajv-formats` run evaluates that format, so this subset
// evaluator mirrors it in order to keep its Zod-divergence signal honest
// instead of claiming an agreement it cannot check.
//
// It is deliberately NOT the same predicate as the authoritative Zod
// `z.string().datetime({ offset: true })` used by `AgentSignupDiscoverySchema`:
// ajv-formats accepts a lowercase `t`/`z` and a space separator and rejects an
// out-of-range offset, while Zod requires an uppercase `T` and a `Z`/numeric
// offset and (by regex) accepts `+25:00`. Where the two differ, Zod plus the
// written spec (§5.2) win, and the `schema.json-schema` check reports the
// divergence rather than overstating agreement.

const JSON_SCHEMA_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const JSON_SCHEMA_TIME_PATTERN =
  /^(\d{2}):(\d{2}):(\d{2}(?:\.\d+)?)(z|([+-])(\d{2})(?::?(\d{2}))?)?$/i;
const JSON_SCHEMA_DAYS_IN_MONTH = [0, 31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function isJsonSchemaFullDate(value: string): boolean {
  const match = JSON_SCHEMA_DATE_PATTERN.exec(value);
  if (match === null) {
    return false;
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const daysInMonth =
    month === 2 && isLeapYear(year) ? 29 : JSON_SCHEMA_DAYS_IN_MONTH[month] ?? 0;
  return month >= 1 && month <= 12 && day >= 1 && day <= daysInMonth;
}

function isJsonSchemaFullTime(value: string): boolean {
  const match = JSON_SCHEMA_TIME_PATTERN.exec(value);
  if (match === null) {
    return false;
  }
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  const second = Number(match[3]);
  const offset = match[4];
  const offsetSign = match[5] === "-" ? -1 : 1;
  const offsetHour = Number(match[6] ?? 0);
  const offsetMinute = Number(match[7] ?? 0);
  // `full` mode requires an explicit, range-checked timezone.
  if (offset === undefined || offsetHour > 23 || offsetMinute > 59) {
    return false;
  }
  if (hour <= 23 && minute <= 59 && second < 60) {
    return true;
  }
  // RFC 3339 permits a leap second only at 23:59:60 UTC.
  const utcMinute = minute - offsetMinute * offsetSign;
  const utcHour = hour - offsetHour * offsetSign - (utcMinute < 0 ? 1 : 0);
  return (
    (utcHour === 23 || utcHour === -1) &&
    (utcMinute === 59 || utcMinute === -1) &&
    second < 61
  );
}

function isJsonSchemaDateTime(value: string): boolean {
  const parts = value.split(/t|\s/i);
  return (
    parts.length === 2 &&
    isJsonSchemaFullDate(parts[0]) &&
    isJsonSchemaFullTime(parts[1])
  );
}

const EMAIL_PATTERN = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

function isUri(value: string): boolean {
  const url = parseAbsoluteHttpUrl(value);
  return url !== null;
}

export function validateJsonSchema(
  node: unknown,
  schema: unknown,
  root: unknown,
  path: string,
  errors: SchemaError[],
): void {
  if (schema === true || schema === undefined) {
    return;
  }
  if (schema === false) {
    errors.push({ path, message: "must not be present" });
    return;
  }
  if (!isRecord(schema)) {
    return;
  }

  if (typeof schema.$ref === "string") {
    validateJsonSchema(node, resolveJsonPointer(root, schema.$ref), root, path, errors);
    return;
  }

  if (typeof schema.type === "string" && !matchesJsonType(node, schema.type)) {
    errors.push({ path, message: `must be of type ${schema.type}` });
    return;
  }
  if (Array.isArray(schema.type)) {
    const types = schema.type.filter((entry): entry is string => typeof entry === "string");
    if (!types.some((type) => matchesJsonType(node, type))) {
      errors.push({ path, message: `must be of type ${types.join(" or ")}` });
      return;
    }
  }

  if ("const" in schema && !deepEqual(node, schema.const)) {
    errors.push({ path, message: `must equal ${JSON.stringify(schema.const)}` });
  }

  if (Array.isArray(schema.enum)) {
    const allowed = schema.enum as unknown[];
    if (!allowed.some((candidate) => deepEqual(node, candidate))) {
      errors.push({
        path,
        message: `must be one of ${allowed.map((value) => JSON.stringify(value)).join(", ")}`,
      });
    }
  }

  if (
    typeof schema.minLength === "number" &&
    typeof node === "string" &&
    node.length < schema.minLength
  ) {
    errors.push({ path, message: `must be at least ${schema.minLength} characters` });
  }

  if (
    typeof schema.maxLength === "number" &&
    typeof node === "string" &&
    node.length > schema.maxLength
  ) {
    errors.push({ path, message: `must be at most ${schema.maxLength} characters` });
  }

  if (typeof schema.minimum === "number" && typeof node === "number" && node < schema.minimum) {
    errors.push({ path, message: `must be >= ${schema.minimum}` });
  }

  if (typeof schema.maximum === "number" && typeof node === "number" && node > schema.maximum) {
    errors.push({ path, message: `must be <= ${schema.maximum}` });
  }

  if (typeof schema.pattern === "string" && typeof node === "string") {
    try {
      if (!new RegExp(schema.pattern).test(node)) {
        errors.push({ path, message: `must match pattern ${schema.pattern}` });
      }
    } catch {
      // Ignore malformed patterns in the checked-in schema.
    }
  }

  if (schema.format === "date-time" && typeof node === "string" && !isJsonSchemaDateTime(node)) {
    errors.push({ path, message: 'must match format "date-time"' });
  }
  if (schema.format === "uri" && typeof node === "string" && !isUri(node)) {
    errors.push({ path, message: 'must match format "uri"' });
  }
  if (schema.format === "email" && typeof node === "string" && !EMAIL_PATTERN.test(node)) {
    errors.push({ path, message: 'must match format "email"' });
  }

  if (Array.isArray(node)) {
    if (typeof schema.minItems === "number" && node.length < schema.minItems) {
      errors.push({ path, message: `must contain at least ${schema.minItems} items` });
    }
    if (typeof schema.maxItems === "number" && node.length > schema.maxItems) {
      errors.push({ path, message: `must contain at most ${schema.maxItems} items` });
    }
    if (schema.uniqueItems === true) {
      for (let i = 0; i < node.length; i += 1) {
        for (let j = i + 1; j < node.length; j += 1) {
          if (deepEqual(node[i], node[j])) {
            errors.push({ path, message: `items must be unique (duplicate at ${i} and ${j})` });
          }
        }
      }
    }
    if (isRecord(schema.items)) {
      node.forEach((item, index) =>
        validateJsonSchema(item, schema.items, root, `${path}[${index}]`, errors),
      );
    }
    if (isRecord(schema.contains)) {
      const anyMatch = node.some((item) => {
        const probeErrors: SchemaError[] = [];
        validateJsonSchema(item, schema.contains, root, path, probeErrors);
        return probeErrors.length === 0;
      });
      if (!anyMatch) {
        errors.push({ path, message: "must contain a matching item" });
      }
    }
  }

  if (isRecord(node)) {
    if (Array.isArray(schema.required)) {
      for (const required of schema.required) {
        if (typeof required === "string" && !(required in node)) {
          errors.push({ path, message: `missing required property "${required}"` });
        }
      }
    }
    const properties = isRecord(schema.properties) ? schema.properties : {};
    for (const [key, value] of Object.entries(node)) {
      const child = `${path}.${key}`;
      if (key in properties) {
        validateJsonSchema(value, properties[key], root, child, errors);
      } else if (schema.additionalProperties === false) {
        errors.push({ path, message: `additional property "${key}" is not allowed` });
      } else if (isRecord(schema.additionalProperties)) {
        validateJsonSchema(value, schema.additionalProperties, root, child, errors);
      }
    }
  }
}

/** Loads a checked-in root schema file (`<name>.schema.json`) from this repository. */
export function loadRootSchema(fileName: string): unknown | null {
  try {
    const schemaPath = fileURLToPath(new URL(`../${fileName}`, import.meta.url));
    return JSON.parse(readFileSync(schemaPath, "utf8"));
  } catch {
    return null;
  }
}

/** Validates `value` against a root schema file; returns JSON-pointer-ish error paths. */
export function checkAgainstRootSchema(
  value: unknown,
  fileName: string,
): { ok: boolean; errors: SchemaError[] } {
  const schema = loadRootSchema(fileName);
  if (schema === null) {
    return { ok: false, errors: [{ path: "$", message: `could not load ${fileName}` }] };
  }
  const errors: SchemaError[] = [];
  validateJsonSchema(value, schema, schema, "$", errors);
  return { ok: errors.length === 0, errors };
}

/**
 * Projects `value` onto the properties a closed schema declares, recursively.
 *
 * This is the fixture harness's mirror of **verifier mode**: an older verifier
 * validates every field it knows and ignores additive fields it does not. The
 * projection is only used to prove a fixture differs between the two modes; it
 * is never a relaxation of a known check.
 */
export function stripUnknownToSchema(
  value: unknown,
  schema: unknown,
  root: unknown = schema,
): unknown {
  if (schema === true || schema === undefined || schema === false || !isRecord(schema)) {
    return value;
  }
  if (typeof schema.$ref === "string") {
    return stripUnknownToSchema(value, resolveJsonPointer(root, schema.$ref), root);
  }
  if (Array.isArray(value)) {
    return isRecord(schema.items)
      ? value.map((item) => stripUnknownToSchema(item, schema.items, root))
      : value;
  }
  if (!isRecord(value)) {
    return value;
  }
  const properties = isRecord(schema.properties) ? schema.properties : {};
  const projected: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (key in properties) {
      projected[key] = stripUnknownToSchema(child, properties[key], root);
    } else if (schema.additionalProperties === false) {
      continue;
    } else {
      projected[key] = child;
    }
  }
  return projected;
}

