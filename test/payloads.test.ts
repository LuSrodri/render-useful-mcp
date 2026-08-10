/**
 * What a caller can actually send.
 *
 * `test/catalogue.test.ts` checks that the catalogue reads well — names, titles, prose. That
 * is not the same as checking a payload survives `validateArgs`, and the gap between the two
 * shipped: `render_create_service` carried a worked example in its own description that the
 * server rejected, for every service type except `static_site`, while the suite stayed green.
 *
 * Every test here runs the real validator over a real payload.
 */
import { describe, expect, it } from 'vitest';

import { RenderMcpError } from '../src/errors.js';
import { loadOperations } from '../src/generated/catalogue.js';
import { OPERATION_HINTS } from '../src/tools/operation-hints.js';
import { validateArgs } from '../src/tools/validate.js';
import type { OperationDefinition } from '../src/generated/types.js';

const operations = loadOperations();

function operation(name: string): OperationDefinition {
  const found = operations.find((candidate) => candidate.name === name);
  if (found === undefined) throw new Error(`No such tool: ${name}`);
  return found;
}

/**
 * The rejection a caller would see for a payload, or `undefined` when it is accepted.
 *
 * Reports `toToolMessage()` rather than `message`, because the itemised issues are what
 * reaches the model and are the only part that says which field is wrong.
 */
function rejection(toolName: string, args: Record<string, unknown>): string | undefined {
  try {
    validateArgs(toolName, operation(toolName).inputSchema, args);
    return undefined;
  } catch (error) {
    if (error instanceof RenderMcpError) return error.toToolMessage();
    return error instanceof Error ? error.message : String(error);
  }
}

describe('published examples', () => {
  it('accepts every worked example the tool descriptions publish', () => {
    const rejected: string[] = [];

    for (const [operationId, hint] of Object.entries(OPERATION_HINTS)) {
      const target = operations.find((candidate) => candidate.operationId === operationId);
      // A hint for an unknown operation is the generator's error to raise, not ours.
      if (target === undefined) continue;

      for (const example of hint.examples ?? []) {
        const failure = rejection(target.name, { ...example.args });
        if (failure !== undefined) rejected.push(`${target.name} — ${example.summary}: ${failure}`);
      }
    }

    expect(rejected).toEqual([]);
  });

  it('publishes at least one example for the two tools with a branching body', () => {
    // These are the operations where the shape depends on another field's value, which is
    // exactly where an untested example is most likely to be wrong.
    for (const operationId of ['create-service', 'update-service']) {
      expect(OPERATION_HINTS[operationId]?.examples?.length ?? 0, operationId).toBeGreaterThan(0);
    }
  });
});

describe('render_create_service', () => {
  const base = { name: 'example', ownerId: 'tea-abc123', repo: 'https://github.com/acme/example', branch: 'main' };

  // One correct payload per service type. Before `serviceDetails` was made satisfiable, only
  // `static_site` passed: every other type matched both its own branch and the static-site
  // branch, which has no `required` and so accepts anything.
  const byType: ReadonlyArray<readonly [string, Record<string, unknown>]> = [
    ['static_site', { buildCommand: 'npm run build', publishPath: './dist' }],
    [
      'web_service',
      {
        runtime: 'node',
        plan: 'starter',
        region: 'oregon',
        envSpecificDetails: { buildCommand: 'npm ci', startCommand: 'node server.js' },
      },
    ],
    [
      'private_service',
      {
        runtime: 'go',
        plan: 'starter',
        region: 'oregon',
        envSpecificDetails: { buildCommand: 'go build -o app', startCommand: './app' },
      },
    ],
    [
      'background_worker',
      {
        runtime: 'python',
        plan: 'starter',
        region: 'oregon',
        envSpecificDetails: { buildCommand: 'pip install -r requirements.txt', startCommand: 'python worker.py' },
      },
    ],
    [
      'cron_job',
      {
        runtime: 'docker',
        schedule: '0 3 * * *',
        plan: 'starter',
        region: 'oregon',
        envSpecificDetails: { dockerfilePath: './Dockerfile', dockerContext: '.', dockerCommand: 'python report.py' },
      },
    ],
  ];

  it.each(byType)('accepts a %s', (type, serviceDetails) => {
    expect(rejection('render_create_service', { ...base, type, serviceDetails })).toBeUndefined();
  });

  // Acceptance alone proves little here: `web_service`, `private_service` and
  // `background_worker` payloads were accepted before the union was discriminated, but
  // through the static-site branch, which requires nothing and allows anything. Every
  // constraint on those three types was unenforced while the tool looked like it worked.
  // Each case below plants a field belonging to a different type's branch.
  const foreignField: ReadonlyArray<readonly [string, Record<string, unknown>]> = [
    ['static_site', { publishPath: './dist', runtime: 'node' }],
    ['web_service', { runtime: 'node', schedule: '0 3 * * *' }],
    ['private_service', { runtime: 'go', healthCheckPath: '/healthz' }],
    ['background_worker', { runtime: 'python', publishPath: './dist' }],
    ['cron_job', { runtime: 'node', schedule: '0 3 * * *', publishPath: './dist' }],
  ];

  it.each(foreignField)('rejects a %s carrying another branch’s field', (type, serviceDetails) => {
    expect(rejection('render_create_service', { ...base, type, serviceDetails })).toBeDefined();
  });

  it('still rejects a cron job with no schedule', () => {
    // The point of discriminating the branch is stricter validation, not weaker: `schedule`
    // is required for a cron job and nothing else supplies it.
    const failure = rejection('render_create_service', {
      ...base,
      type: 'cron_job',
      serviceDetails: {
        runtime: 'node',
        envSpecificDetails: { buildCommand: 'npm ci', startCommand: 'node job.js' },
      },
    });
    expect(failure).toContain('schedule');
  });

  it("rejects a payload whose serviceDetails belong to another type's branch", () => {
    // `publishPath` is a static-site field; sending it under `type: cron_job` is the mistake
    // an ambiguous union made invisible.
    const failure = rejection('render_create_service', {
      ...base,
      type: 'cron_job',
      serviceDetails: { runtime: 'node', schedule: '0 3 * * *', publishPath: './dist' },
    });
    expect(failure).toBeDefined();
  });
});

describe('render_update_service', () => {
  it("accepts a change to a cron job's schedule", () => {
    expect(
      rejection('render_update_service', { serviceId: 'srv-abc123', serviceDetails: { schedule: '30 4 * * *' } }),
    ).toBeUndefined();
  });

  it('accepts a plan change on a web service', () => {
    expect(
      rejection('render_update_service', {
        serviceId: 'srv-abc123',
        serviceDetails: { plan: 'standard', healthCheckPath: '/healthz' },
      }),
    ).toBeUndefined();
  });

  it('accepts a build command change', () => {
    expect(
      rejection('render_update_service', {
        serviceId: 'srv-abc123',
        serviceDetails: {
          runtime: 'node',
          envSpecificDetails: { buildCommand: 'npm ci', startCommand: 'node app.js' },
        },
      }),
    ).toBeUndefined();
  });
});

describe('schema satisfiability', () => {
  it('leaves no oneOf branch a caller cannot select', () => {
    // A `oneOf` demands exactly one match. When a minimal valid instance of one branch also
    // satisfies a sibling, that branch is unreachable — no payload a caller writes for it can
    // ever validate. This is the invariant `render_create_service` violated for four of its
    // five service types, undetected, because nothing here executed a payload.
    const unreachable: string[] = [];

    for (const op of operations) {
      walkUnions(op.inputSchema, op.name, (union, path) => {
        union.forEach((branch, index) => {
          const instance = minimalInstance(branch);
          const accepting = union
            .map((sibling, siblingIndex) => (satisfies(sibling, instance) ? siblingIndex : -1))
            .filter((siblingIndex) => siblingIndex >= 0);

          if (accepting.length > 1) {
            const others = accepting.filter((i) => i !== index).map((i) => branchName(union[i]!, i));
            unreachable.push(`${path}: ${branchName(branch, index)} is also accepted by ${others.join(', ')}`);
          }
        });
      });
    }

    expect(unreachable).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type Schema = Record<string, unknown>;

function branchName(branch: Schema, index: number): string {
  return typeof branch['title'] === 'string' ? branch['title'] : `oneOf[${index}]`;
}

/** Visits every `oneOf` in a schema, with a readable path to it. */
function walkUnions(node: unknown, path: string, visit: (union: Schema[], path: string) => void): void {
  if (Array.isArray(node)) {
    node.forEach((item, index) => walkUnions(item, `${path}[${index}]`, visit));
    return;
  }
  if (node === null || typeof node !== 'object') return;

  for (const [keyword, value] of Object.entries(node as Schema)) {
    if (keyword === 'oneOf' && Array.isArray(value) && value.length > 1) {
      visit(value as Schema[], path);
    }
    if (keyword === 'properties' && value !== null && typeof value === 'object') {
      for (const [name, sub] of Object.entries(value as Schema)) walkUnions(sub, `${path}.${name}`, visit);
    } else {
      walkUnions(value, keyword === 'oneOf' || keyword === 'anyOf' ? path : `${path}.${keyword}`, visit);
    }
  }
}

/** The smallest instance a branch accepts: every `required` property, recursively. */
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

function satisfies(schema: Schema, instance: unknown): boolean {
  try {
    // `validateArgs` clones before coercing, so branches never see each other's mutations.
    validateArgs('branch', schema, instance as Record<string, unknown>);
    return true;
  } catch {
    return false;
  }
}
