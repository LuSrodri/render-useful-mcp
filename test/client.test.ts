import { describe, expect, it } from 'vitest';

import { RenderApiError, TransportError } from '../src/errors.js';
import { createLogger } from '../src/logging.js';
import { RenderClient, parseEventStream } from '../src/render/client.js';
import { isRetryable, nextDelayMs, retryAfterMs } from '../src/render/retry.js';
import { parseUrl, stubFetch } from './helpers.js';

function client(fetchImpl: typeof fetch, maxRetries = 3): RenderClient {
  return new RenderClient({
    apiKey: 'rnd_key',
    baseUrl: 'https://api.render.com/v1',
    userAgent: 'test',
    timeoutMs: 2_000,
    logger: createLogger('silent'),
    retryPolicy: { maxRetries, baseDelayMs: 1, maxDelayMs: 4 },
    fetchImpl,
  });
}

describe('RenderClient.request', () => {
  it('authenticates and targets the configured base URL', async () => {
    const { fetch, requests } = stubFetch({ body: { id: 'srv-1' } });
    const response = await client(fetch).request({ method: 'GET', path: '/services/srv-1' });

    expect(response.data).toEqual({ id: 'srv-1' });
    expect(requests[0]!.url).toBe('https://api.render.com/v1/services/srv-1');
    expect(requests[0]!.headers['Authorization']).toBe('Bearer rnd_key');
  });

  it('serialises array query parameters as repeated keys, as Render expects', async () => {
    const { fetch, requests } = stubFetch({ body: [] });
    await client(fetch).request({
      method: 'GET',
      path: '/services',
      query: { ownerId: ['tea-1', 'tea-2'], limit: 20, includePreviews: false, cursor: undefined },
    });

    const { params } = parseUrl(requests[0]!.url);
    expect(params).toEqual([
      ['ownerId', 'tea-1'],
      ['ownerId', 'tea-2'],
      ['limit', '20'],
      ['includePreviews', 'false'],
    ]);
  });

  it('surfaces the API error message and an actionable hint', async () => {
    const { fetch } = stubFetch({ status: 404, body: { message: 'service not found' } });
    const error = await client(fetch)
      .request({ method: 'GET', path: '/services/srv-missing' })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(RenderApiError);
    const apiError = error as RenderApiError;
    expect(apiError.status).toBe(404);
    expect(apiError.toToolMessage()).toContain('service not found');
    expect(apiError.toToolMessage()).toContain('Hint:');
  });

  it('retries 429 responses and honours Retry-After', async () => {
    const { fetch, requests } = stubFetch([
      { status: 429, body: { message: 'slow down' }, headers: { 'retry-after': '0' } },
      { body: { ok: true } },
    ]);
    const response = await client(fetch).request({ method: 'GET', path: '/services' });

    expect(response.data).toEqual({ ok: true });
    expect(requests).toHaveLength(2);
  });

  it('retries 503 for idempotent methods', async () => {
    const { fetch, requests } = stubFetch([{ status: 503 }, { status: 503 }, { body: { ok: true } }]);
    await client(fetch).request({ method: 'GET', path: '/services' });
    expect(requests).toHaveLength(3);
  });

  it('never replays a failed POST, which could duplicate a deploy', async () => {
    const { fetch, requests } = stubFetch({ status: 503, body: { message: 'unavailable' } });
    await expect(client(fetch).request({ method: 'POST', path: '/services' })).rejects.toBeInstanceOf(RenderApiError);
    expect(requests).toHaveLength(1);
  });

  it('gives up after maxRetries', async () => {
    const { fetch, requests } = stubFetch({ status: 500 });
    await expect(client(fetch, 2).request({ method: 'GET', path: '/services' })).rejects.toBeInstanceOf(RenderApiError);
    expect(requests).toHaveLength(3); // initial attempt + 2 retries
  });

  it('reports network failures as transport errors', async () => {
    const failing = (() => Promise.reject(new Error('ECONNREFUSED'))) as unknown as typeof fetch;

    const error = await client(failing, 0)
      .request({ method: 'GET', path: '/services' })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(TransportError);
    expect((error as TransportError).message).toContain('ECONNREFUSED');
  });

  it('turns an empty 204 into a null payload rather than throwing', async () => {
    const { fetch } = stubFetch({ status: 204 });
    const response = await client(fetch).request({ method: 'DELETE', path: '/services/srv-1' });
    expect(response.status).toBe(204);
    expect(response.data).toBeNull();
  });

  it('sends JSON bodies with the right content type', async () => {
    const { fetch, requests } = stubFetch({ body: {} });
    await client(fetch).request({ method: 'POST', path: '/services', body: { name: 'api' } });

    expect(requests[0]!.headers['Content-Type']).toBe('application/json');
    expect(requests[0]!.body).toBe('{"name":"api"}');
  });
});

describe('RenderClient.paginate', () => {
  it('unwraps Render list envelopes and follows the cursor', async () => {
    const { fetch, requests } = stubFetch([
      {
        body: [
          { service: { id: 'srv-1' }, cursor: 'c1' },
          { service: { id: 'srv-2' }, cursor: 'c2' },
        ],
      },
      { body: [{ service: { id: 'srv-3' }, cursor: 'c3' }] },
    ]);

    const page = await client(fetch).paginate<{ id: string }>({ path: '/services', limit: 10, pageSize: 2 });

    expect(page.items).toEqual([{ id: 'srv-1' }, { id: 'srv-2' }, { id: 'srv-3' }]);
    // The continuation cursor is the one attached to the last item of the previous page.
    expect(parseUrl(requests[1]!.url).params).toContainEqual(['cursor', 'c2']);
  });

  it('stops at the requested limit', async () => {
    const { fetch } = stubFetch({
      body: Array.from({ length: 100 }, (_, index) => ({ service: { id: `srv-${index}` }, cursor: `c${index}` })),
    });
    const page = await client(fetch).paginate<{ id: string }>({ path: '/services', limit: 5 });
    expect(page.items).toHaveLength(5);
  });

  it('stops on an empty page', async () => {
    const { fetch, requests } = stubFetch({ body: [] });
    const page = await client(fetch).paginate({ path: '/services', limit: 50 });
    expect(page.items).toEqual([]);
    expect(requests).toHaveLength(1);
  });
});

describe('retry policy', () => {
  it('only retries statuses that can succeed on a replay', () => {
    expect(isRetryable('GET', 500)).toBe(true);
    expect(isRetryable('GET', 404)).toBe(false);
    expect(isRetryable('GET', 400)).toBe(false);
    expect(isRetryable('POST', 429)).toBe(true);
    expect(isRetryable('POST', 500)).toBe(false);
    expect(isRetryable('PUT', 503)).toBe(true);
    expect(isRetryable('DELETE', undefined)).toBe(true);
    expect(isRetryable('POST', undefined)).toBe(false);
  });

  it('keeps decorrelated jitter within its bounds', () => {
    const policy = { maxRetries: 5, baseDelayMs: 100, maxDelayMs: 5_000 };
    for (const random of [0, 0.5, 0.999]) {
      const delay = nextDelayMs(400, policy, () => random);
      expect(delay).toBeGreaterThanOrEqual(policy.baseDelayMs);
      expect(delay).toBeLessThanOrEqual(1_200);
    }
    expect(nextDelayMs(100_000, policy, () => 1)).toBe(policy.maxDelayMs);
  });

  it('parses both Retry-After forms', () => {
    expect(retryAfterMs(new Headers({ 'retry-after': '2' }))).toBe(2_000);
    const now = Date.parse('2026-01-01T00:00:00Z');
    const later = new Date(now + 3_000).toUTCString();
    expect(retryAfterMs(new Headers({ 'retry-after': later }), now)).toBeGreaterThanOrEqual(2_000);
    expect(retryAfterMs(new Headers())).toBeUndefined();
    expect(retryAfterMs(new Headers({ 'retry-after': 'nonsense' }))).toBeUndefined();
  });
});

describe('parseEventStream', () => {
  async function collect(chunks: readonly string[]): Promise<unknown[]> {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder();
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
    });
    const events: unknown[] = [];
    for await (const event of parseEventStream(stream)) events.push(event);
    return events;
  }

  it('decodes JSON events split across chunk boundaries', async () => {
    expect(await collect(['data: {"a":1}\n\ndata: {"b', '":2}\n\n'])).toEqual([{ a: 1 }, { b: 2 }]);
  });

  it('handles CRLF separators and multi-line data', async () => {
    expect(await collect(['data: line1\r\ndata: line2\r\n\r\n'])).toEqual(['line1\nline2']);
  });

  it('ignores comments and emits a trailing event without a blank line', async () => {
    expect(await collect([': keep-alive\n\ndata: {"c":3}'])).toEqual([{ c: 3 }]);
  });
});
