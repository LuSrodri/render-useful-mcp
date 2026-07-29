import { describe, expect, it } from 'vitest';

import { PolicyError, ValidationError } from '../src/errors.js';
import { loadOperations } from '../src/generated/catalogue.js';
import type { OperationDefinition } from '../src/generated/types.js';
import { buildApiTools, execute } from '../src/tools/api-tools.js';
import { ToolRegistry } from '../src/tools/registry.js';
import { validateArgs } from '../src/tools/validate.js';
import { DEFAULT_TOOLSETS } from '../src/tools/toolsets.js';
import { parseUrl, stubFetch, testContext } from './helpers.js';

const operations = loadOperations();
const byName = new Map(operations.map((operation) => [operation.name, operation]));

function operation(name: string): OperationDefinition {
  const found = byName.get(name);
  if (found === undefined) throw new Error(`no such operation: ${name}`);
  return found;
}

describe('request mapping', () => {
  it('substitutes path parameters and URL-encodes them', async () => {
    const { fetch, requests } = stubFetch({ body: { id: 'srv-1' } });
    await execute(operation('render_retrieve_service'), { serviceId: 'srv-a/b' }, testContext(fetch));

    expect(parseUrl(requests[0]!.url).path).toBe('/v1/services/srv-a%2Fb');
  });

  it('flattens body properties back into a JSON body', async () => {
    const { fetch, requests } = stubFetch({ status: 201, body: {} });
    await execute(
      operation('render_create_deploy'),
      { serviceId: 'srv-1', clearCache: 'clear', commitId: 'abc123' },
      testContext(fetch),
    );

    expect(parseUrl(requests[0]!.url).path).toBe('/v1/services/srv-1/deploys');
    expect(requests[0]!.method).toBe('POST');
    expect(JSON.parse(requests[0]!.body!)).toEqual({ clearCache: 'clear', commitId: 'abc123' });
  });

  it('keeps path parameters out of the request body', async () => {
    const { fetch, requests } = stubFetch({ status: 201, body: {} });
    const op = operation('render_create_deploy');
    await execute(op, { serviceId: 'srv-1', clearCache: 'do_not_clear' }, testContext(fetch));

    expect(JSON.parse(requests[0]!.body!)).not.toHaveProperty('serviceId');
    expect(op.bodyProps).not.toContain('serviceId');
  });

  it('sends wrapped bodies verbatim for array-valued endpoints', async () => {
    const op = operation('render_update_env_vars_for_service');
    expect(op.bodyMode).toBe('wrapped');

    const { fetch, requests } = stubFetch({ body: [] });
    await execute(op, { serviceId: 'srv-1', body: [{ key: 'A', value: '1' }] }, testContext(fetch));

    expect(JSON.parse(requests[0]!.body!)).toEqual([{ key: 'A', value: '1' }]);
  });

  it('omits the body entirely when no body arguments were supplied', async () => {
    const { fetch, requests } = stubFetch({ body: {} });
    await execute(operation('render_restart_service'), { serviceId: 'srv-1' }, testContext(fetch));
    expect(requests[0]!.body).toBeUndefined();
  });

  it('reports a 204 as an explicit success instead of a bare null', async () => {
    const { fetch } = stubFetch({ status: 204 });
    const result = await execute(operation('render_delete_service'), { serviceId: 'srv-1' }, testContext(fetch));
    expect(result).toMatchObject({ ok: true, status: 204 });
  });
});

describe('workspace defaulting', () => {
  it('injects RENDER_WORKSPACE_ID into array-typed ownerId parameters', async () => {
    const { fetch, requests } = stubFetch({ body: [] });
    await execute(operation('render_list_services'), {}, testContext(fetch, { defaultOwnerId: 'tea-default' }));

    expect(parseUrl(requests[0]!.url).params).toContainEqual(['ownerId', 'tea-default']);
  });

  it('injects it into string-typed ownerId parameters', async () => {
    const { fetch, requests } = stubFetch({ body: { logs: [] } });
    await execute(
      operation('render_list_logs'),
      { resource: ['srv-1'] },
      testContext(fetch, { defaultOwnerId: 'tea-default' }),
    );

    expect(parseUrl(requests[0]!.url).params).toContainEqual(['ownerId', 'tea-default']);
  });

  it('never overrides an explicit ownerId', async () => {
    const { fetch, requests } = stubFetch({ body: [] });
    await execute(
      operation('render_list_services'),
      { ownerId: ['tea-explicit'] },
      testContext(fetch, { defaultOwnerId: 'tea-default' }),
    );

    const owners = parseUrl(requests[0]!.url).params.filter(([key]) => key === 'ownerId');
    expect(owners).toEqual([['ownerId', 'tea-explicit']]);
  });

  it('does nothing when no default workspace is configured', async () => {
    const { fetch, requests } = stubFetch({ body: [] });
    await execute(operation('render_list_services'), {}, testContext(fetch));
    expect(parseUrl(requests[0]!.url).params).toEqual([]);
  });
});

describe('argument validation', () => {
  const listServices = operation('render_list_services');

  it('rejects unknown properties', () => {
    expect(() => validateArgs('render_list_services', listServices.inputSchema, { nope: 1 })).toThrow(ValidationError);
  });

  it('reports every problem at once', () => {
    const error = (() => {
      try {
        validateArgs('render_retrieve_deploy', operation('render_retrieve_deploy').inputSchema, {});
        return undefined;
      } catch (caught) {
        return caught as ValidationError;
      }
    })();

    expect(error).toBeInstanceOf(ValidationError);
    expect(error!.issues).toHaveLength(2);
    expect(error!.toToolMessage()).toContain('serviceId');
    expect(error!.toToolMessage()).toContain('deployId');
  });

  it('coerces the stringified numbers and booleans models tend to send', () => {
    const coerced = validateArgs('render_list_services', listServices.inputSchema, {
      limit: '20',
      includePreviews: 'true',
    });
    expect(coerced['limit']).toBe(20);
    expect(coerced['includePreviews']).toBe(true);
  });

  it('enforces enums from the spec', () => {
    expect(() => validateArgs('render_list_services', listServices.inputSchema, { region: ['atlantis'] })).toThrow(
      ValidationError,
    );
    expect(() => validateArgs('render_list_services', listServices.inputSchema, { region: ['oregon'] })).not.toThrow();
  });

  it("leaves the caller's object untouched", () => {
    const args = { limit: '20' };
    validateArgs('render_list_services', listServices.inputSchema, args);
    expect(args.limit).toBe('20');
  });

  it('accepts a valid argument set for every generated tool schema', () => {
    // Compiling all 207 schemas proves none of them is malformed JSON Schema.
    for (const op of operations) {
      expect(() => validateArgs(op.name, op.inputSchema, buildMinimalArgs(op)), op.name).not.toThrow();
    }
  });
});

/** Builds the smallest argument object that satisfies an operation's required properties. */
function buildMinimalArgs(op: OperationDefinition): Record<string, unknown> {
  const properties = (op.inputSchema['properties'] ?? {}) as Record<string, Record<string, unknown>>;
  const args: Record<string, unknown> = {};
  for (const name of (op.inputSchema['required'] ?? []) as string[]) {
    args[name] = sampleFor(properties[name] ?? { type: 'string' });
  }
  return args;
}

function sampleFor(schema: Record<string, unknown>): unknown {
  const enumValues = schema['enum'] as unknown[] | undefined;
  if (enumValues !== undefined && enumValues.length > 0) return enumValues[0];
  // Many Render ids carry a `pattern`; the spec's own example is the reliable sample.
  if (schema['example'] !== undefined && schema['type'] !== 'array' && schema['type'] !== 'object') {
    return schema['example'];
  }
  if (Array.isArray(schema['oneOf'])) return sampleFor(schema['oneOf'][0] as Record<string, unknown>);
  if (schema['format'] === 'date-time') return '2026-01-01T00:00:00Z';
  if (schema['format'] === 'uri') return 'https://example.com';
  if (schema['format'] === 'email') return 'user@example.com';
  switch (schema['type']) {
    case 'array':
      return [sampleFor((schema['items'] ?? { type: 'string' }) as Record<string, unknown>)];
    case 'integer':
    case 'number':
      return 1;
    case 'boolean':
      return true;
    case 'object': {
      const nested = (schema['properties'] ?? {}) as Record<string, Record<string, unknown>>;
      const result: Record<string, unknown> = {};
      for (const name of (schema['required'] ?? []) as string[]) {
        result[name] = sampleFor(nested[name] ?? { type: 'string' });
      }
      return result;
    }
    default:
      return 'x';
  }
}

describe('ToolRegistry', () => {
  const options = { enabledToolsets: DEFAULT_TOOLSETS, readOnly: false, dynamicToolsets: true };
  /** An operator who deliberately narrowed the surface; `metrics` is excluded. */
  const narrowed = { ...options, enabledToolsets: ['services'] as const };

  it('registers every generated tool plus the composite and meta tools', () => {
    const registry = new ToolRegistry(options);
    expect(registry.all()).toHaveLength(operations.length + 5);
  });

  it('exposes every toolset by default, so nothing the API allows is withheld', () => {
    const registry = new ToolRegistry(options);
    const visible = new Set(registry.visible().map((tool) => tool.name));

    expect(registry.visible()).toHaveLength(registry.all().length);
    for (const name of ['render_list_services', 'render_get_cpu', 'render_list_redis', 'render_list_workflows']) {
      expect(visible, name).toContain(name);
    }
  });

  it('hides tools when the operator narrows the surface', () => {
    const registry = new ToolRegistry(narrowed);
    const visible = new Set(registry.visible().map((tool) => tool.name));

    expect(visible).toContain('render_list_services');
    expect(visible).not.toContain('render_get_cpu');
  });

  it('explains how to reach a hidden tool instead of denying it exists', () => {
    const registry = new ToolRegistry(narrowed);
    const error = (() => {
      try {
        registry.resolve('render_get_cpu');
        return undefined;
      } catch (caught) {
        return caught as PolicyError;
      }
    })();

    expect(error).toBeInstanceOf(PolicyError);
    expect(error!.toToolMessage()).toContain('metrics');
    // The only way to reach it is a config change, so the hint must say exactly that.
    expect(error!.toToolMessage()).toContain('RENDER_MCP_TOOLSETS');
    expect(error!.toToolMessage()).toContain('restart');
  });

  it('gives the same env-var hint whether or not the meta-tool is registered', () => {
    const withMetaTool = new ToolRegistry(narrowed);
    const withoutMetaTool = new ToolRegistry({ ...narrowed, dynamicToolsets: false });

    for (const registry of [withMetaTool, withoutMetaTool]) {
      try {
        registry.resolve('render_get_cpu');
        expect.unreachable('expected a PolicyError');
      } catch (caught) {
        expect(caught).toBeInstanceOf(PolicyError);
        expect((caught as PolicyError).toToolMessage()).toContain('RENDER_MCP_TOOLSETS');
      }
    }
  });

  it('never changes the visible set once constructed', async () => {
    const registry = new ToolRegistry(narrowed);
    const before = registry.visible().map((tool) => tool.name);

    // Calling the meta-tool is the only path that used to mutate visibility.
    const metaTool = registry.resolve('render_toolsets');
    await metaTool.handler({}, {} as never);

    expect(registry.visible().map((tool) => tool.name)).toEqual(before);
    expect(() => registry.resolve('render_get_cpu')).toThrow(PolicyError);
  });

  it('withholds every mutating tool in read-only mode', () => {
    const registry = new ToolRegistry({ ...options, readOnly: true });

    expect(registry.visible().every((tool) => !tool.mutating)).toBe(true);
    expect(() => registry.resolve('render_delete_service')).toThrow(PolicyError);
    expect(() => registry.resolve('render_delete_service')).toThrow(/read-only/);
    expect(registry.resolve('render_list_services')).toBeDefined();
  });

  it('rejects an unknown tool name distinctly from a disabled one', () => {
    const registry = new ToolRegistry(options);
    expect(() => registry.resolve('render_not_a_tool')).toThrow(/Unknown tool/);
  });

  it('reports per-toolset stats covering every tool', () => {
    const registry = new ToolRegistry(options);
    const total = registry.stats().reduce((sum, entry) => sum + entry.tools, 0);
    expect(total).toBe(registry.all().length);
  });
});

describe('tool annotations', () => {
  it('mirrors the operation semantics clients use for auto-approval', () => {
    const tools = new Map(buildApiTools().map((tool) => [tool.name, tool]));

    expect(tools.get('render_list_services')!.annotations).toMatchObject({
      readOnlyHint: true,
      destructiveHint: false,
    });
    expect(tools.get('render_delete_service')!.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
    });
    expect(tools.get('render_create_service')!.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
    });
  });
});
