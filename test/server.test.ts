/**
 * End-to-end tests over a real in-memory MCP client/server pair.
 *
 * These exercise the actual protocol surface — `tools/list`, `tools/call`, error results —
 * rather than calling handlers directly, so schema serialisation and transport-level
 * behaviour are covered too.
 *
 * Both protocol eras are covered, because they take different code paths through the SDK
 * and produce different wire shapes. A client that opens with the 2025 `initialize`
 * handshake pins a legacy instance; `serveStdio` serves the 2026-07-28 era, where results
 * carry `resultType` and the cacheable ones carry `ttlMs`/`cacheScope`.
 */
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { beforeEach, describe, expect, it } from 'vitest';

import { createServer, serialise } from '../src/server.js';
import { RenderClient } from '../src/render/client.js';
import { createLogger } from '../src/logging.js';
import { stubFetch, testConfig, type StubResponse } from './helpers.js';

type Era = 'legacy' | 'modern';

async function connect(
  script: StubResponse | StubResponse[],
  configOverrides: Partial<ReturnType<typeof testConfig>> = {},
  era: Era = 'legacy',
): Promise<{ client: Client; requests: ReturnType<typeof stubFetch>['requests'] }> {
  const config = testConfig(configOverrides);
  const { fetch, requests } = stubFetch(script);
  const build = (): ReturnType<typeof createServer>['server'] =>
    createServer({
      config,
      version: 'test',
      logger: createLogger('silent'),
      client: new RenderClient({
        apiKey: config.apiKey,
        baseUrl: config.baseUrl,
        userAgent: config.userAgent,
        timeoutMs: config.requestTimeoutMs,
        logger: createLogger('silent'),
        retryPolicy: { maxRetries: 0, baseDelayMs: 1, maxDelayMs: 1 },
        fetchImpl: fetch,
      }),
    }).server;

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  if (era === 'modern') {
    // `serveStdio` owns the era decision, so it is what puts the server on 2026-07-28;
    // pinning the client to the same revision keeps the test from silently falling back.
    serveStdio(build, { transport: serverTransport });
    const client = new Client(
      { name: 'test-client', version: '1.0.0' },
      { versionNegotiation: { mode: { pin: '2026-07-28' } } },
    );
    await client.connect(clientTransport);
    return { client, requests };
  }

  const client = new Client({ name: 'test-client', version: '1.0.0' });
  await Promise.all([client.connect(clientTransport), build().connect(serverTransport)]);

  return { client, requests };
}

describe('MCP server', () => {
  let client: Client;

  beforeEach(async () => {
    ({ client } = await connect({ body: [] }));
  });

  it('sends usage instructions in the initialize result', () => {
    // These are the only guidance a client sees before it has listed a single tool, so a
    // silent regression here is invisible until a model picks the wrong tool.
    const instructions = client.getInstructions();

    expect(instructions).toBeTruthy();
    expect(instructions).toContain('render_find_service');
    expect(instructions).toContain('cron_job');
  });

  it('advertises tools with well-formed schemas', async () => {
    const result = await client.listTools();

    expect(result.tools.length).toBeGreaterThan(100);
    for (const tool of result.tools) {
      expect(tool.name).toMatch(/^render_/);
      expect(tool.description).toBeTruthy();
      expect(tool.inputSchema.type).toBe('object');
    }
  });

  it('exposes the composite tools regardless of toolset selection', async () => {
    const { tools } = await client.listTools();
    const names = new Set(tools.map((tool) => tool.name));

    for (const name of [
      'render_find_service',
      'render_wait_for_deploy',
      'render_service_status',
      'render_recent_logs',
      'render_toolsets',
    ]) {
      expect(names).toContain(name);
    }
  });

  it('executes a tool call and returns the API payload', async () => {
    const { client: connected } = await connect({ body: [{ service: { id: 'srv-1', name: 'api' }, cursor: 'c' }] });
    const result = await connected.callTool({
      name: 'render_list_services',
      arguments: { limit: 5 },
    });

    expect(result.isError).toBeFalsy();
    expect((result.content[0] as { text: string }).text).toContain('srv-1');
  });

  it('returns validation failures as readable error results, not protocol errors', async () => {
    const result = await client.callTool({
      name: 'render_retrieve_service',
      arguments: {},
    });

    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toContain('serviceId');
  });

  it('reports Render API failures with status and hint', async () => {
    const { client: connected } = await connect({ status: 404, body: { message: 'service not found' } });
    const result = await connected.callTool({
      name: 'render_retrieve_service',
      arguments: { serviceId: 'srv-missing' },
    });

    expect(result.isError).toBe(true);
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain('HTTP 404');
    expect(text).toContain('service not found');
    expect(text).toContain('Hint:');
  });

  it('refuses an unknown tool with a recoverable message', async () => {
    const result = await client.callTool({ name: 'render_nope', arguments: {} });
    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toContain('Unknown tool');
  });

  it('exposes every Render endpoint by default', async () => {
    const { tools } = await client.listTools();
    // 207 generated operations + 4 workflow tools + the toolsets meta-tool.
    expect(tools).toHaveLength(212);
  });

  it('keeps the tool list fixed across calls, as the protocol requires', async () => {
    const { client: narrow } = await connect({ body: [] }, { toolsets: new Set(['services' as const]) });
    const before = (await narrow.listTools()).tools.map((tool) => tool.name);

    const result = await narrow.callTool({ name: 'render_toolsets', arguments: {} });
    expect(result.isError).toBeFalsy();

    const after = (await narrow.listTools()).tools.map((tool) => tool.name);
    expect(after).toEqual(before);
    expect(after).not.toContain('render_get_cpu');
  });

  it('reports disabled toolsets and how to enable them, without enabling anything', async () => {
    const { client: narrow } = await connect({ body: [] }, { toolsets: new Set(['services' as const]) });

    const result = await narrow.callTool({ name: 'render_toolsets', arguments: {} });
    const payload = JSON.parse((result.content[0] as { text: string }).text) as {
      toolsets: { toolset: string; enabled: boolean }[];
      howToEnable?: string;
    };

    expect(payload.toolsets.find((entry) => entry.toolset === 'services')?.enabled).toBe(true);
    expect(payload.toolsets.find((entry) => entry.toolset === 'metrics')?.enabled).toBe(false);
    expect(payload.howToEnable).toContain('RENDER_MCP_TOOLSETS');
  });

  it('rejects an attempt to enable a toolset through the meta-tool', async () => {
    const result = await client.callTool({
      name: 'render_toolsets',
      arguments: { enable: 'metrics' },
    });

    expect(result.isError).toBe(true);
  });

  it('blocks mutating tools in read-only mode', async () => {
    const { client: readOnly } = await connect({ body: {} }, { readOnly: true });

    const { tools } = await readOnly.listTools();
    expect(tools.map((tool) => tool.name)).not.toContain('render_delete_service');

    const result = await readOnly.callTool({
      name: 'render_delete_service',
      arguments: { serviceId: 'srv-1' },
    });
    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toContain('read-only');
  });
});

describe('protocol revision 2026-07-28', () => {
  it('serves the tool list with the cache hints the spec requires', async () => {
    const { client } = await connect({ body: [] }, {}, 'modern');
    const result = (await client.listTools()) as Record<string, unknown> & { tools: unknown[] };

    expect(result.tools).toHaveLength(212);
    // `resultType` is not asserted here: the client consumes the discriminator while
    // lifting the result, so it is a wire-level field the caller never sees.
    // `ttlMs` and `cacheScope` are required on cacheable results.
    expect(result['ttlMs']).toBe(300_000);
    // The list is derived from configuration alone, identical for every caller.
    expect(result['cacheScope']).toBe('public');
  });

  it('declares no capability it does not implement', async () => {
    const { client } = await connect({ body: [] }, {}, 'modern');
    const capabilities = client.getServerCapabilities();

    expect(capabilities?.tools).toBeDefined();
    // Diagnostics go to stderr; the Logging feature is deprecated as of this revision.
    expect(capabilities?.logging).toBeUndefined();
    // The tool set never changes, so there is nothing to notify about.
    expect(capabilities?.tools?.listChanged).toBeFalsy();
  });

  it('executes tool calls on the new era', async () => {
    const { client } = await connect({ body: [{ service: { id: 'srv-9', name: 'api' } }] }, {}, 'modern');
    const result = await client.callTool({
      name: 'render_list_services',
      arguments: { limit: 1 },
    });

    expect(result.isError).toBeFalsy();
    expect((result.content[0] as { text: string }).text).toContain('srv-9');
  });

  it('keeps the tool list byte-identical across calls', async () => {
    const { client } = await connect({ body: [] }, { toolsets: new Set(['services' as const]) }, 'modern');
    const before = await client.listTools();

    await client.callTool({ name: 'render_toolsets', arguments: {} });

    const after = await client.listTools();
    expect(after.tools).toEqual(before.tools);
  });
});

describe('serialise', () => {
  it('pretty-prints JSON results', () => {
    expect(serialise({ a: 1 }, 1_000)).toBe('{\n  "a": 1\n}');
  });

  it('passes strings through untouched', () => {
    expect(serialise('plain', 1_000)).toBe('plain');
  });

  it('truncates oversized payloads and says how to avoid it', () => {
    const output = serialise('x'.repeat(5_000), 1_000);
    expect(output.length).toBeLessThan(2_000);
    expect(output).toContain('[truncated');
    expect(output).toContain('RENDER_MCP_MAX_RESPONSE_BYTES');
  });

  it('survives values JSON cannot represent', () => {
    const circular: Record<string, unknown> = {};
    circular['self'] = circular;
    expect(() => serialise(circular, 1_000)).not.toThrow();
  });
});
