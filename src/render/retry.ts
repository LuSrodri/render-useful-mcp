/**
 * Retry policy for calls to the Render API.
 *
 * Uses decorrelated jitter (AWS's "Exponential Backoff and Jitter"), which spreads retries
 * better than plain exponential backoff and avoids the thundering herd that full-sync
 * backoff produces when several tool calls fail at once.
 */

/** Statuses worth retrying: rate limiting plus transient server-side failures. */
const RETRYABLE_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);

export interface RetryPolicy {
  readonly maxRetries: number;
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxRetries: 3,
  baseDelayMs: 250,
  maxDelayMs: 20_000,
};

/**
 * Whether a failed attempt should be retried.
 *
 * Only idempotent methods are retried on server errors: replaying a `POST` that timed out
 * could create a second deploy or a second Postgres instance. `429` is the exception —
 * Render rejects those before any work happens, so replaying is safe for every method.
 */
export function isRetryable(method: string, status: number | undefined): boolean {
  if (status === undefined) return isIdempotent(method); // network-level failure
  if (!RETRYABLE_STATUSES.has(status)) return false;
  if (status === 429) return true;
  return isIdempotent(method);
}

function isIdempotent(method: string): boolean {
  return ['GET', 'HEAD', 'PUT', 'DELETE', 'OPTIONS'].includes(method.toUpperCase());
}

/**
 * Decorrelated jitter: `delay = min(cap, random(base, previous * 3))`.
 *
 * `random` is injectable so tests can assert bounds deterministically.
 */
export function nextDelayMs(previousDelayMs: number, policy: RetryPolicy, random: () => number = Math.random): number {
  const upper = Math.max(policy.baseDelayMs, previousDelayMs * 3);
  const delay = policy.baseDelayMs + random() * (upper - policy.baseDelayMs);
  return Math.min(policy.maxDelayMs, Math.round(delay));
}

/**
 * Reads `Retry-After`, which Render sends on 429 and which always wins over local backoff.
 * Supports both the delta-seconds and HTTP-date forms.
 */
export function retryAfterMs(headers: Headers, now: number = Date.now()): number | undefined {
  const raw = headers.get('retry-after');
  if (raw === null) return undefined;

  const seconds = Number(raw.trim());
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);

  const date = Date.parse(raw);
  if (Number.isNaN(date)) return undefined;
  return Math.max(0, date - now);
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      const reason: unknown = signal?.reason;
      reject(reason instanceof Error ? reason : new Error('Aborted'));
    };
    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
