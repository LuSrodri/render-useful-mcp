/**
 * Test doubles shared across suites.
 */
import type { Config } from '../src/config.js';
import { createLogger } from '../src/logging.js';
import { RenderClient } from '../src/render/client.js';
import type { ToolContext } from '../src/tools/types.js';
import { DEFAULT_TOOLSETS } from '../src/tools/toolsets.js';

export interface RecordedRequest {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body: string | undefined;
}

export interface StubResponse {
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
}

/**
 * A `fetch` stub that records calls and replays a queued script of responses.
 *
 * The last queued response repeats, so retry tests can assert "keeps failing" without
 * enumerating every attempt.
 */
export function stubFetch(script: StubResponse | StubResponse[]): {
  fetch: typeof fetch;
  requests: RecordedRequest[];
} {
  const queue = Array.isArray(script) ? [...script] : [script];
  const requests: RecordedRequest[] = [];

  const impl = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const stub = (queue.length > 1 ? queue.shift() : queue[0]) ?? {};
    requests.push({
      url: typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
      method: init?.method ?? 'GET',
      headers: { ...((init?.headers ?? {}) as Record<string, string>) },
      body: typeof init?.body === 'string' ? init.body : undefined,
    });

    const status = stub.status ?? 200;
    const payload = stub.body === undefined ? null : JSON.stringify(stub.body);
    return Promise.resolve(
      new Response(payload, {
        status,
        headers: { 'content-type': 'application/json', ...(stub.headers ?? {}) },
      }),
    );
  };

  return { fetch: impl, requests };
}

export function testConfig(overrides: Partial<Config> = {}): Config {
  return {
    apiKey: 'rnd_test_key',
    baseUrl: 'https://api.render.com/v1',
    defaultOwnerId: undefined,
    toolsets: new Set(DEFAULT_TOOLSETS),
    readOnly: false,
    dynamicToolsets: true,
    requestTimeoutMs: 5_000,
    maxRetries: 3,
    maxResponseBytes: 400_000,
    logLevel: 'silent',
    userAgent: 'render-useful-mcp/test',
    ...overrides,
  };
}

export function testContext(
  fetchImpl: typeof fetch,
  configOverrides: Partial<Config> = {},
): ToolContext & { client: RenderClient } {
  const config = testConfig(configOverrides);
  const logger = createLogger('silent');
  const client = new RenderClient({
    apiKey: config.apiKey,
    baseUrl: config.baseUrl,
    userAgent: config.userAgent,
    timeoutMs: config.requestTimeoutMs,
    logger,
    retryPolicy: { maxRetries: config.maxRetries, baseDelayMs: 1, maxDelayMs: 5 },
    fetchImpl,
  });
  return {
    client,
    config,
    logger,
    signal: undefined,
    callTool: () => Promise.reject(new Error('callTool is not wired in tests')),
  };
}

/** Parses a recorded request URL into path plus repeated-key query pairs. */
export function parseUrl(url: string): { path: string; params: Array<[string, string]> } {
  const parsed = new URL(url);
  return { path: parsed.pathname, params: [...parsed.searchParams.entries()] };
}
