/**
 * Turns Render's undiscriminated `oneOf` unions into ones a caller can actually satisfy.
 *
 * `POST /services` describes `serviceDetails` as five branches and says nowhere which one
 * goes with which `type` — the spec carries no `discriminator`, and no branch sets
 * `additionalProperties: false`. `staticSiteDetailsPOST` requires nothing and forbids
 * nothing, so it accepts every payload. Under `oneOf`'s exactly-one rule that makes four of
 * the five service types unreachable, and makes the fifth (`static_site`) the branch every
 * other type is silently validated against. Render's own API is unaffected: it reads `type`
 * and picks the shape itself, which is the step JSON Schema has no way to infer.
 *
 * So we say it explicitly. A union whose branches are listed in `BRANCH_DISCRIMINATORS`
 * becomes an `if`/`then` rule per branch, keyed on the sibling property that selects it.
 * Validation becomes exact rather than impossible, and the `type` → shape mapping stops
 * being prose in a usage hint and becomes part of the schema a model reads.
 *
 * Where the payload contains no discriminator at all, `if`/`then` has nothing to key on.
 * `PATCH /services/{id}` is the case: a service cannot change type, so `type` is not in the
 * body, and nothing distinguishes the five PATCH branches. Those are listed in
 * `UNDISCRIMINATED_UNIONS` and downgraded to `anyOf` — weaker validation, but a caller can
 * at least send the request, and Render validates it against the real service. The list is
 * explicit so the trade-off is a decision on the record rather than an accident.
 */
import { Ajv } from 'ajv';
import addFormatsModule from 'ajv-formats';

import type { JsonSchema } from '../generated/types.js';

type FormatsPlugin = (ajv: Ajv) => unknown;
const interop = addFormatsModule as unknown as FormatsPlugin | { default: FormatsPlugin };
const addFormats: FormatsPlugin = typeof interop === 'function' ? interop : interop.default;

/** Language runtimes, i.e. everything that builds from source rather than an image. */
const NATIVE_RUNTIMES = ['elixir', 'go', 'node', 'python', 'ruby', 'rust'] as const;

/** The sibling property, and its values, that select a branch. */
export interface BranchDiscriminator {
  readonly property: string;
  readonly values: readonly string[];
}

/**
 * Keyed by the branch's schema name in Render's spec, which the generator carries across as
 * `title` when it inlines the `$ref`. A name Render withdraws stops matching and the union
 * falls back to being reported as unreachable, so this cannot rot silently.
 */
export const BRANCH_DISCRIMINATORS: Readonly<Record<string, BranchDiscriminator>> = {
  staticSiteDetailsPOST: { property: 'type', values: ['static_site'] },
  webServiceDetailsPOST: { property: 'type', values: ['web_service'] },
  privateServiceDetailsPOST: { property: 'type', values: ['private_service'] },
  backgroundWorkerDetailsPOST: { property: 'type', values: ['background_worker'] },
  cronJobDetailsPOST: { property: 'type', values: ['cron_job'] },

  // `runtime: image` deliberately selects neither: a prebuilt image takes only the
  // `dockerCommand` to run, which satisfies no branch the spec defines. Leaving it
  // unconstrained beats inventing a shape Render never described.
  dockerDetails: { property: 'runtime', values: ['docker'] },
  dockerDetailsPOST: { property: 'runtime', values: ['docker'] },
  dockerDetailsPATCH: { property: 'runtime', values: ['docker'] },
  nativeEnvironmentDetails: { property: 'runtime', values: NATIVE_RUNTIMES },
  nativeEnvironmentDetailsPOST: { property: 'runtime', values: NATIVE_RUNTIMES },
  nativeEnvironmentDetailsPATCH: { property: 'runtime', values: NATIVE_RUNTIMES },
};

/**
 * Unions the payload gives us no way to discriminate, downgraded to `anyOf` on purpose.
 *
 * Keyed `operationId:property`. Adding an entry weakens validation for that property, so
 * the bar is that no field in the request identifies the branch — not that discriminating
 * it is inconvenient.
 */
export const UNDISCRIMINATED_UNIONS: readonly string[] = ['update-service:serviceDetails'];

type Schema = Record<string, unknown>;

function isSchema(value: unknown): value is Schema {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Rewrites every discriminable union in `schema`, in place, and reports what it did.
 *
 * Returns the property paths it rewrote so the generator can log them; throws on a union it
 * can neither discriminate nor find on the `UNDISCRIMINATED_UNIONS` list, because emitting
 * one would ship a tool with an unsatisfiable argument.
 */
export function discriminateUnions(schema: JsonSchema, operationId: string): string[] {
  const rewritten: string[] = [];
  visit(schema, '', operationId, rewritten);
  return rewritten;
}

function visit(container: Schema, path: string, operationId: string, rewritten: string[]): void {
  const properties = container['properties'];
  if (isSchema(properties)) {
    for (const [name, sub] of Object.entries(properties)) {
      if (!isSchema(sub)) continue;
      const here = path === '' ? name : `${path}.${name}`;

      // Depth first: `envSpecificDetails` lives inside the `serviceDetails` branches, so it
      // must be rewritten while those branches are still reachable as plain objects.
      const branches = sub['oneOf'];
      if (Array.isArray(branches)) {
        for (const branch of branches) if (isSchema(branch)) visit(branch, here, operationId, rewritten);
        resolveUnion(container, name, here, branches as Schema[], operationId, rewritten);
      } else {
        visit(sub, here, operationId, rewritten);
      }
    }
  }

  for (const keyword of ['items', 'additionalProperties'] as const) {
    const value = container[keyword];
    if (isSchema(value)) visit(value, `${path}.${keyword}`, operationId, rewritten);
  }
}

function resolveUnion(
  container: Schema,
  property: string,
  path: string,
  branches: Schema[],
  operationId: string,
  rewritten: string[],
): void {
  const discriminator = sharedDiscriminator(branches);
  const containerProperties = (container['properties'] ?? {}) as Record<string, Schema>;

  if (discriminator === undefined || containerProperties[discriminator] === undefined) {
    // A union nothing can discriminate is only a problem when a branch is unreachable.
    // Disjoint branches — `envVars`, where `value` and `generateValue` exclude each other —
    // are already decidable and are left exactly as the spec wrote them.
    if (findUnreachableBranches(branches).length === 0) return;

    if (UNDISCRIMINATED_UNIONS.includes(`${operationId}:${path}`)) {
      // Every branch still carries its title, so the caller can read the shapes even though
      // the schema can no longer check which one applies.
      const target = containerProperties[property]!;
      delete target['oneOf'];
      target['anyOf'] = branches;
      rewritten.push(`${path} → anyOf (no discriminator in the payload)`);
      return;
    }
    throw new Error(
      `${operationId}: the \`oneOf\` at "${path}" has branches no caller can select, and nothing ` +
        `discriminates them. Give each branch an entry in BRANCH_DISCRIMINATORS, or — if the ` +
        `payload genuinely carries no discriminator — add "${operationId}:${path}" to ` +
        `UNDISCRIMINATED_UNIONS in src/tools/schema-unions.ts.`,
    );
  }

  // Applied to every discriminable union, not only the unsatisfiable ones. A `oneOf` whose
  // branches happen to be disjoint still forces a caller into one of the shapes the spec
  // enumerated: `runtime: image` takes a `dockerCommand` and nothing else, which matches
  // neither branch, and was rejected on a payload Render accepts. Keying on `runtime`
  // constrains the runtimes the spec describes and leaves the rest alone.
  const rules = branches.map((branch) => ({
    if: {
      properties: { [discriminator]: { enum: [...BRANCH_DISCRIMINATORS[branch['title'] as string]!.values] } },
      required: [discriminator],
    },
    then: { properties: { [property]: { ...branch, additionalProperties: false } } },
  }));

  containerProperties[property] = {
    type: 'object',
    description: describeMapping(discriminator, branches),
  };
  container['allOf'] = [...((container['allOf'] as unknown[]) ?? []), ...rules];
  rewritten.push(`${path} → if/then on \`${discriminator}\``);
}

/** The discriminator shared by every branch, or `undefined` if they disagree or are unknown. */
function sharedDiscriminator(branches: Schema[]): string | undefined {
  const properties = new Set<string>();
  for (const branch of branches) {
    const title = branch['title'];
    const entry = typeof title === 'string' ? BRANCH_DISCRIMINATORS[title] : undefined;
    if (entry === undefined) return undefined;
    properties.add(entry.property);
  }
  return properties.size === 1 ? [...properties][0] : undefined;
}

function describeMapping(discriminator: string, branches: Schema[]): string {
  const mapping = branches
    .map((branch) => {
      const title = branch['title'] as string;
      return `${BRANCH_DISCRIMINATORS[title]!.values.map((value) => `\`${value}\``).join('/')} → ${title}`;
    })
    .join(', ');
  return (
    `Selected by \`${discriminator}\`: ${mapping}. The matching schema is applied by this ` +
    `object's \`allOf\` rules, where each branch's fields are listed; sending a field from ` +
    `another branch is rejected.`
  );
}

// ---------------------------------------------------------------------------
// The invariant
// ---------------------------------------------------------------------------

const ajv = new Ajv({ allErrors: false, strict: false, coerceTypes: true, useDefaults: true });
addFormats(ajv);

/**
 * Branch indices no caller can select, because a minimal instance of the branch also
 * satisfies a sibling and `oneOf` demands exactly one match.
 */
export function findUnreachableBranches(branches: readonly Schema[]): number[] {
  const validators = branches.map((branch) => {
    try {
      return ajv.compile(branch);
    } catch {
      return undefined;
    }
  });

  const unreachable: number[] = [];
  branches.forEach((branch, index) => {
    const instance = minimalInstance(branch);
    const accepting = validators.filter((validate) => validate?.(structuredClone(instance)) === true);
    if (accepting.length > 1) unreachable.push(index);
  });
  return unreachable;
}

/** Every `oneOf` in a schema, as `path → unreachable branch names`. */
export function auditUnions(schema: JsonSchema, toolName: string): string[] {
  const problems: string[] = [];

  const walk = (node: unknown, path: string): void => {
    if (Array.isArray(node)) {
      node.forEach((item, index) => walk(item, `${path}[${index}]`));
      return;
    }
    if (!isSchema(node)) return;

    for (const [keyword, value] of Object.entries(node)) {
      if (keyword === 'oneOf' && Array.isArray(value) && value.length > 1) {
        for (const index of findUnreachableBranches(value as Schema[])) {
          const branch = value[index] as Schema;
          problems.push(`${path}: ${(branch['title'] as string | undefined) ?? `oneOf[${index}]`} is unreachable`);
        }
      }
      if (keyword === 'properties' && isSchema(value)) {
        for (const [name, sub] of Object.entries(value)) walk(sub, `${path}.${name}`);
      } else {
        walk(value, keyword === 'oneOf' || keyword === 'anyOf' ? path : `${path}.${keyword}`);
      }
    }
  };

  walk(schema, toolName);
  return problems;
}

/** The smallest instance a schema accepts: every `required` property, recursively. */
function minimalInstance(schema: Schema, depth = 0): unknown {
  if (depth > 6) return {};
  if (Array.isArray(schema['oneOf'])) return minimalInstance((schema['oneOf'] as Schema[])[0]!, depth + 1);
  if (Array.isArray(schema['anyOf'])) return minimalInstance((schema['anyOf'] as Schema[])[0]!, depth + 1);

  const enumValues = schema['enum'] as unknown[] | undefined;
  if (enumValues !== undefined && enumValues.length > 0) return enumValues[0];
  if (schema['format'] === 'date-time') return '2026-01-01T00:00:00Z';
  if (schema['format'] === 'uri') return 'https://example.com';
  if (schema['format'] === 'email') return 'user@example.com';

  switch (schema['type']) {
    case 'array':
      return [minimalInstance((schema['items'] ?? { type: 'string' }) as Schema, depth + 1)];
    case 'integer':
    case 'number':
      return 1;
    case 'boolean':
      return true;
    case 'string':
      return typeof schema['example'] === 'string' ? schema['example'] : 'x';
    default: {
      const properties = (schema['properties'] ?? {}) as Record<string, Schema>;
      const instance: Record<string, unknown> = {};
      for (const name of (schema['required'] ?? []) as string[]) {
        instance[name] = minimalInstance(properties[name] ?? { type: 'string' }, depth + 1);
      }
      return instance;
    }
  }
}
