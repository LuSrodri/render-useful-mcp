/**
 * End-to-end tests over a real in-memory MCP client/server pair.
 *
 * These exercise the actual protocol surface — `tools/list`, `tools/call`, error results —
 * rather than calling handlers directly, so schema serialisation and transport-level
 * behaviour are covered too.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { beforeEach, describe, expect, it } from 'vitest';

import { createServer, serialise } from '../src/server.js';
import { RenderClient } from '../src/render/client.js';
import { createLogger } from '../src/logging.js';
import { stubFetch, testConfig, type StubResponse } from './helpers.js';

async function connect(
  script: StubResponse | StubResponse[],
  configOverrides: Partial<ReturnType<typeof testConfig>> = {},
): Promise<{ client: Client; requests: ReturnType<typeof stubFetch>['requests'] }> {
  const config = testConfig(configOverrides);
  const { fetch, requests } = stubFetch(script);
  const renderClient = new RenderClient({
    apiKey: config.apiKey,
    baseUrl: config.baseUrl,
    userAgent: config.userAgent,
    timeoutMs: config.requestTimeoutMs,
    logger: createLogger('silent'),
    retryPolicy: { maxRetries: 0, baseDelayMs: 1, maxDelayMs: 1 },
    fetchImpl: fetch,
  });

  const { server } = createServer({
    config,
    version: 'test',
    logger: createLogger('silent'),
    client: renderClient,
  });

  const client = new Client({ name: 'test-client', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

  return { client, requests };
}

describe('MCP server', () => {
  let client: Client;

  beforeEach(async () => {
    ({ client } = await connect({ body: [] }));
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
    const result = (await connected.callTool({
      name: 'render_list_services',
      arguments: { limit: 5 },
    })) as CallToolResult;

    expect(result.isError).toBeFalsy();
    expect((result.content[0] as { text: string }).text).toContain('srv-1');
  });

  it('returns validation failures as readable error results, not protocol errors', async () => {
    const result = (await client.callTool({
      name: 'render_retrieve_service',
      arguments: {},
    })) as CallToolResult;

    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toContain('serviceId');
  });

  it('reports Render API failures with status and hint', async () => {
    const { client: connected } = await connect({ status: 404, body: { message: 'service not found' } });
    const result = (await connected.callTool({
      name: 'render_retrieve_service',
      arguments: { serviceId: 'srv-missing' },
    })) as CallToolResult;

    expect(result.isError).toBe(true);
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain('HTTP 404');
    expect(text).toContain('service not found');
    expect(text).toContain('Hint:');
  });

  it('refuses an unknown tool with a recoverable message', async () => {
    const result = (await client.callTool({ name: 'render_nope', arguments: {} })) as CallToolResult;
    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toContain('Unknown tool');
  });

  it('grows the tool list when a toolset is enabled at runtime', async () => {
    const before = (await client.listTools()).tools.length;

    const result = (await client.callTool({
      name: 'render_toolsets',
      arguments: { enable: 'metrics' },
    })) as CallToolResult;
    expect(result.isError).toBeFalsy();

    const after = await client.listTools();
    expect(after.tools.length).toBeGreaterThan(before);
    expect(after.tools.map((tool) => tool.name)).toContain('render_get_cpu');
  });

  it('blocks mutating tools in read-only mode', async () => {
    const { client: readOnly } = await connect({ body: {} }, { readOnly: true });

    const { tools } = await readOnly.listTools();
    expect(tools.map((tool) => tool.name)).not.toContain('render_delete_service');

    const result = (await readOnly.callTool({
      name: 'render_delete_service',
      arguments: { serviceId: 'srv-1' },
    })) as CallToolResult;
    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toContain('read-only');
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
