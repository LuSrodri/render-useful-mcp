/**
 * HTTP client for the Render Public API.
 *
 * Concerns kept here rather than in tool handlers: authentication, timeouts, retries,
 * rate-limit handling, error normalisation, cursor pagination and SSE collection. Tool
 * handlers stay declarative as a result.
 */
import { RenderApiError, TransportError, hintForStatus } from '../errors.js';
import type { Logger } from '../logging.js';
import { DEFAULT_RETRY_POLICY, isRetryable, nextDelayMs, retryAfterMs, sleep, type RetryPolicy } from './retry.js';

export type QueryValue = string | number | boolean | null | undefined | Array<string | number | boolean>;

export interface RequestOptions {
  readonly method: string;
  /** Path relative to the base URL, already templated (`/services/srv-123`). */
  readonly path: string;
  readonly query?: Readonly<Record<string, QueryValue>>;
  readonly body?: unknown;
  /** Sends `body` (a `Record<string, string>`) as `multipart/form-data`. */
  readonly multipart?: boolean;
  readonly signal?: AbortSignal;
  /** Overrides the client-wide timeout for this call. */
  readonly timeoutMs?: number;
}

export interface RenderResponse<T = unknown> {
  readonly status: number;
  readonly data: T;
  readonly headers: Headers;
}

export interface RenderClientOptions {
  readonly apiKey: string;
  readonly baseUrl: string;
  readonly userAgent: string;
  readonly timeoutMs: number;
  readonly logger: Logger;
  readonly retryPolicy?: RetryPolicy;
  /** Injectable for tests. */
  readonly fetchImpl?: typeof fetch;
}

/** Render's paginated list endpoints return `[{ <resource>: {...}, cursor: "..." }]`. */
export interface CursorPage<T> {
  readonly items: readonly T[];
  readonly cursor: string | undefined;
}

export class RenderClient {
  readonly #apiKey: string;
  readonly #baseUrl: string;
  readonly #userAgent: string;
  readonly #timeoutMs: number;
  readonly #logger: Logger;
  readonly #retryPolicy: RetryPolicy;
  readonly #fetch: typeof fetch;

  constructor(options: RenderClientOptions) {
    this.#apiKey = options.apiKey;
    this.#baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.#userAgent = options.userAgent;
    this.#timeoutMs = options.timeoutMs;
    this.#logger = options.logger.child({ component: 'render-client' });
    this.#retryPolicy = options.retryPolicy ?? DEFAULT_RETRY_POLICY;
    this.#fetch = options.fetchImpl ?? globalThis.fetch;
  }

  async request<T = unknown>(options: RequestOptions): Promise<RenderResponse<T>> {
    const url = this.#buildUrl(options.path, options.query);
    const method = options.method.toUpperCase();
    let delay = 0;

    for (let attempt = 0; ; attempt += 1) {
      const outcome = await this.#attempt<T>(method, url, options);

      if (outcome.ok) return outcome.response;

      const retriable = isRetryable(method, outcome.status) && attempt < this.#retryPolicy.maxRetries;
      if (!retriable) throw outcome.error;

      // A server-supplied Retry-After is authoritative; otherwise back off locally.
      delay = outcome.retryAfterMs ?? nextDelayMs(delay, this.#retryPolicy);
      this.#logger.warn('retrying Render API request', {
        method,
        path: options.path,
        status: outcome.status,
        attempt: attempt + 1,
        delayMs: delay,
      });
      await sleep(delay, options.signal);
    }
  }

  /**
   * Walks a cursor-paginated endpoint, unwrapping Render's `{ <resource>, cursor }` envelope.
   *
   * `limit` caps the total number of items so a runaway list cannot exhaust the model's
   * context; pagination stops as soon as a short page or an absent cursor is seen.
   */
  async paginate<T = unknown>(
    options: Omit<RequestOptions, 'method'> & { readonly limit?: number; readonly pageSize?: number },
  ): Promise<CursorPage<T>> {
    const limit = options.limit ?? 100;
    const pageSize = Math.min(options.pageSize ?? 100, 100);
    const items: T[] = [];
    let cursor: string | undefined;

    while (items.length < limit) {
      const response = await this.request<unknown>({
        ...options,
        method: 'GET',
        query: {
          ...options.query,
          limit: Math.min(pageSize, limit - items.length),
          ...(cursor !== undefined ? { cursor } : {}),
        },
      });

      const page = Array.isArray(response.data) ? response.data : [];
      if (page.length === 0) break;

      for (const entry of page) items.push(unwrapEnvelope<T>(entry));
      cursor = lastCursor(page);
      if (cursor === undefined || page.length < pageSize) break;
    }

    return { items: items.slice(0, limit), cursor };
  }

  /**
   * Collects server-sent events until `maxEvents`, `maxDurationMs` or end of stream.
   *
   * Render exposes live logs and workflow task events as SSE. A tool call has to terminate,
   * so this deliberately samples a bounded window rather than streaming indefinitely.
   */
  async collectEvents(
    options: Omit<RequestOptions, 'method' | 'body'> & { readonly maxEvents: number; readonly maxDurationMs: number },
  ): Promise<{ readonly events: unknown[]; readonly truncated: boolean }> {
    const url = this.#buildUrl(options.path, options.query);
    const controller = new AbortController();
    const abort = (): void => controller.abort();
    options.signal?.addEventListener('abort', abort, { once: true });
    const stopTimer = setTimeout(abort, options.maxDurationMs);

    const events: unknown[] = [];
    let truncated = false;

    try {
      const response = await this.#fetch(url, {
        method: 'GET',
        headers: { ...this.#headers(), Accept: 'text/event-stream' },
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new RenderApiError(
          response.statusText || 'request failed',
          response.status,
          'GET',
          options.path,
          await safeReadBody(response),
          hintForStatus(response.status),
        );
      }
      if (!response.body) return { events, truncated: false };

      for await (const event of parseEventStream(response.body)) {
        events.push(event);
        if (events.length >= options.maxEvents) {
          truncated = true;
          break;
        }
      }
    } catch (error) {
      // An abort here is the expected end of a bounded sample, not a failure.
      if (!isAbortError(error)) throw error;
      truncated = true;
    } finally {
      clearTimeout(stopTimer);
      options.signal?.removeEventListener('abort', abort);
      controller.abort();
    }

    return { events, truncated };
  }

  async #attempt<T>(
    method: string,
    url: string,
    options: RequestOptions,
  ): Promise<
    | { ok: true; response: RenderResponse<T> }
    | { ok: false; error: Error; status: number | undefined; retryAfterMs: number | undefined }
  > {
    const controller = new AbortController();
    const abort = (): void => controller.abort();
    options.signal?.addEventListener('abort', abort, { once: true });
    const timeoutMs = options.timeoutMs ?? this.#timeoutMs;
    const timer = setTimeout(() => controller.abort(new Error(`Request timed out after ${timeoutMs}ms`)), timeoutMs);
    const startedAt = Date.now();

    try {
      const { body, contentType } = this.#encodeBody(options);
      const response = await this.#fetch(url, {
        method,
        headers: {
          ...this.#headers(),
          ...(contentType !== undefined ? { 'Content-Type': contentType } : {}),
        },
        ...(body !== undefined ? { body } : {}),
        signal: controller.signal,
      });

      const data = await safeReadBody(response);
      this.#logger.debug('Render API response', {
        method,
        path: options.path,
        status: response.status,
        durationMs: Date.now() - startedAt,
      });

      if (response.ok) {
        return { ok: true, response: { status: response.status, data: data as T, headers: response.headers } };
      }

      return {
        ok: false,
        status: response.status,
        retryAfterMs: retryAfterMs(response.headers),
        error: new RenderApiError(
          extractMessage(data) ?? response.statusText ?? 'request failed',
          response.status,
          method,
          options.path,
          data,
          hintForStatus(response.status),
        ),
      };
    } catch (error) {
      if (options.signal?.aborted) {
        return { ok: false, status: undefined, retryAfterMs: undefined, error: toCancellation(options.signal) };
      }
      const timedOut = isAbortError(error);
      return {
        ok: false,
        status: undefined,
        retryAfterMs: undefined,
        error: new TransportError(
          timedOut
            ? `${method} ${options.path} timed out after ${timeoutMs}ms.`
            : `${method} ${options.path} could not reach the Render API: ${describe(error)}`,
          error,
          timedOut
            ? 'Increase RENDER_MCP_TIMEOUT_MS, or narrow the request (shorter time range, smaller limit).'
            : 'Check network connectivity and https://status.render.com.',
        ),
      };
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', abort);
    }
  }

  #headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.#apiKey}`,
      Accept: 'application/json',
      'User-Agent': this.#userAgent,
    };
  }

  #encodeBody(options: RequestOptions): { body: string | FormData | undefined; contentType: string | undefined } {
    if (options.body === undefined || options.body === null) {
      return { body: undefined, contentType: undefined };
    }
    if (options.multipart === true) {
      const form = new FormData();
      for (const [key, value] of Object.entries(options.body as Record<string, unknown>)) {
        if (value === undefined || value === null) continue;
        form.append(key, typeof value === 'string' ? value : JSON.stringify(value));
      }
      // `FormData` makes fetch set its own boundary-bearing Content-Type.
      return { body: form, contentType: undefined };
    }
    return { body: JSON.stringify(options.body), contentType: 'application/json' };
  }

  #buildUrl(path: string, query: Readonly<Record<string, QueryValue>> | undefined): string {
    const url = new URL(`${this.#baseUrl}${path.startsWith('/') ? path : `/${path}`}`);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value === undefined || value === null) continue;
      // Render expects repeated keys for array parameters (`?ownerId=a&ownerId=b`).
      if (Array.isArray(value)) {
        for (const entry of value) url.searchParams.append(key, String(entry));
      } else {
        url.searchParams.append(key, String(value));
      }
    }
    return url.toString();
  }
}

function unwrapEnvelope<T>(entry: unknown): T {
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return entry as T;
  const record = entry as Record<string, unknown>;
  const keys = Object.keys(record).filter((key) => key !== 'cursor');
  // The envelope has exactly one payload key next to `cursor`; anything else is already flat.
  if (keys.length === 1 && 'cursor' in record) {
    return record[keys[0]!] as T;
  }
  return entry as T;
}

function lastCursor(page: readonly unknown[]): string | undefined {
  for (let index = page.length - 1; index >= 0; index -= 1) {
    const entry = page[index];
    if (entry !== null && typeof entry === 'object' && 'cursor' in entry) {
      const cursor = entry.cursor;
      if (typeof cursor === 'string' && cursor !== '') return cursor;
    }
  }
  return undefined;
}

async function safeReadBody(response: Response): Promise<unknown> {
  const contentType = response.headers.get('content-type') ?? '';
  try {
    if (response.status === 204 || response.headers.get('content-length') === '0') return null;
    const text = await response.text();
    if (text === '') return null;
    if (contentType.includes('json')) {
      try {
        return JSON.parse(text) as unknown;
      } catch {
        return text;
      }
    }
    return text;
  } catch {
    return null;
  }
}

function extractMessage(data: unknown): string | undefined {
  if (typeof data === 'string' && data.trim() !== '') return data.slice(0, 500);
  if (data === null || typeof data !== 'object') return undefined;
  const record = data as Record<string, unknown>;
  for (const key of ['message', 'error', 'detail', 'description']) {
    const value = record[key];
    if (typeof value === 'string' && value.trim() !== '') return value;
  }
  return undefined;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError');
}

function toCancellation(signal: AbortSignal): Error {
  const reason: unknown = signal.reason;
  return reason instanceof Error ? reason : new TransportError('The request was cancelled by the client.');
}

function describe(error: unknown): string {
  if (error instanceof Error) {
    const cause = error.cause;
    const causeText = cause instanceof Error ? ` (${cause.message})` : '';
    return `${error.message}${causeText}`;
  }
  return String(error);
}

/**
 * Incrementally parses a `text/event-stream` into decoded event payloads.
 *
 * Handles the parts of the SSE grammar Render actually uses: `data:` lines accumulated
 * until a blank line, with comment lines ignored. JSON payloads are parsed; anything
 * else is yielded as text.
 */
export async function* parseEventStream(stream: ReadableStream<Uint8Array>): AsyncGenerator<unknown> {
  const decoder = new TextDecoder();
  const reader = stream.getReader();
  let buffer = '';

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // Events are separated by a blank line, which is CRLFCRLF or LFLF depending on the hop.
      const separator = /\r?\n\r?\n/g;
      for (let match = separator.exec(buffer); match !== null; match = separator.exec(buffer)) {
        const payload = decodeEvent(buffer.slice(0, match.index));
        buffer = buffer.slice(match.index + match[0].length);
        separator.lastIndex = 0;
        if (payload !== undefined) yield payload;
      }
    }
    const tail = decodeEvent(buffer);
    if (tail !== undefined) yield tail;
  } finally {
    reader.releaseLock();
  }
}

function decodeEvent(rawEvent: string): unknown {
  const data = rawEvent
    .split(/\r?\n/)
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trimStart())
    .join('\n');

  if (data === '') return undefined;
  try {
    return JSON.parse(data) as unknown;
  } catch {
    return data;
  }
}
