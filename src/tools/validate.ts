/**
 * JSON Schema validation of tool arguments.
 *
 * Tool schemas come straight from Render's OpenAPI document, so they use the full
 * expressive range of JSON Schema (`oneOf`, `format`, nested objects). Ajv validates them
 * faithfully; hand-rolling or down-converting to Zod would lose constraints and let
 * invalid requests reach the API, where the resulting error is far less actionable.
 */
// `ajv` and `ajv-formats` are CommonJS. Under NodeNext the named export is the reliable
// import form for Ajv, and the formats plugin needs its interop default unwrapped.
import { Ajv, type ErrorObject, type ValidateFunction } from 'ajv';
import addFormatsModule from 'ajv-formats';

type FormatsPlugin = (ajv: Ajv) => unknown;

// Node's CJS interop hands back the plugin function itself, while the shipped types
// describe the module namespace. Accept either so the code is correct under both.
const interop = addFormatsModule as unknown as FormatsPlugin | { default: FormatsPlugin };
const addFormats: FormatsPlugin = typeof interop === 'function' ? interop : interop.default;

import { ValidationError } from '../errors.js';
import type { JsonSchema } from '../generated/types.js';

const ajv = new Ajv({
  allErrors: true,
  // Render's schemas carry OpenAPI vocabulary (`example`, `nullable`) that is not part of
  // JSON Schema. These must not be treated as validation failures.
  strict: false,
  // Coercion is what makes tool calls forgiving: models routinely send "10" for an integer
  // or "true" for a boolean, and rejecting those helps nobody.
  coerceTypes: true,
  useDefaults: true,
  removeAdditional: false,
});
addFormats(ajv);

const compiled = new WeakMap<JsonSchema, ValidateFunction>();

function compile(schema: JsonSchema): ValidateFunction {
  let validate = compiled.get(schema);
  if (validate === undefined) {
    validate = ajv.compile(schema);
    compiled.set(schema, validate);
  }
  return validate;
}

/**
 * Validates and coerces `args` in place against `schema`.
 *
 * Returns the (possibly coerced) arguments; throws `ValidationError` listing every problem
 * so the model can fix them all in one retry rather than one per round trip.
 */
export function validateArgs(
  toolName: string,
  schema: JsonSchema,
  args: Record<string, unknown>,
): Record<string, unknown> {
  const validate = compile(schema);
  // Ajv mutates its input when coercing or applying defaults; work on a copy so a failed
  // validation never leaves the caller's object half-modified.
  const candidate = structuredClone(args);

  if (validate(candidate)) {
    return candidate;
  }

  throw new ValidationError(
    `Invalid arguments for "${toolName}":`,
    (validate.errors ?? []).map(formatError),
    "Re-read the tool's inputSchema and resend the call with corrected arguments.",
  );
}

function formatError(error: ErrorObject): string {
  const location = error.instancePath === '' ? '(root)' : error.instancePath.replace(/^\//, '').replace(/\//g, '.');

  switch (error.keyword) {
    case 'required':
      return `missing required property "${(error.params as { missingProperty: string }).missingProperty}"`;
    case 'additionalProperties':
      return `unknown property "${(error.params as { additionalProperty: string }).additionalProperty}" at ${location}`;
    case 'enum': {
      const allowed = (error.params as { allowedValues?: unknown[] }).allowedValues ?? [];
      return `${location} must be one of: ${allowed.map((value) => JSON.stringify(value)).join(', ')}`;
    }
    default:
      return `${location} ${error.message ?? 'is invalid'}`;
  }
}
