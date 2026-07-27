/**
 * Error types that carry enough context to produce an actionable message for the model.
 *
 * A tool error is not a crash: it is a result the model has to reason about. Every error
 * here therefore renders to a short explanation plus, where one exists, a concrete
 * suggestion for the next call.
 */

export abstract class RenderMcpError extends Error {
  abstract readonly kind: string;

  /** Guidance rendered alongside the message, when the failure has an obvious remedy. */
  readonly hint?: string;

  protected constructor(message: string, options?: { cause?: unknown; hint?: string }) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = new.target.name;
    if (options?.hint !== undefined) this.hint = options.hint;
  }

  toToolMessage(): string {
    return this.hint ? `${this.message}\n\nHint: ${this.hint}` : this.message;
  }
}

/** The server is misconfigured — bad env vars, unknown toolset, missing API key. */
export class ConfigurationError extends RenderMcpError {
  readonly kind = 'configuration';

  constructor(message: string, hint?: string) {
    super(message, hint !== undefined ? { hint } : undefined);
  }
}

/** Tool arguments failed JSON Schema validation, so no request was made. */
export class ValidationError extends RenderMcpError {
  readonly kind = 'validation';

  constructor(
    message: string,
    readonly issues: readonly string[],
    hint?: string,
  ) {
    super(message, hint !== undefined ? { hint } : undefined);
  }

  override toToolMessage(): string {
    const body =
      this.issues.length > 0 ? `${this.message}\n${this.issues.map((i) => `  - ${i}`).join('\n')}` : this.message;
    return this.hint ? `${body}\n\nHint: ${this.hint}` : body;
  }
}

/** The call is disallowed by the current server policy (read-only mode, disabled toolset). */
export class PolicyError extends RenderMcpError {
  readonly kind = 'policy';

  constructor(message: string, hint?: string) {
    super(message, hint !== undefined ? { hint } : undefined);
  }
}

/** Render returned a non-2xx response. */
export class RenderApiError extends RenderMcpError {
  readonly kind = 'api';

  constructor(
    message: string,
    readonly status: number,
    readonly method: string,
    readonly path: string,
    readonly body: unknown,
    hint?: string,
  ) {
    super(message, hint !== undefined ? { hint } : undefined);
  }

  override toToolMessage(): string {
    const rendered = renderBody(this.body);
    const detail = rendered ? `\n\nResponse body:\n${rendered}` : '';
    return `${this.method} ${this.path} failed with HTTP ${this.status}: ${this.message}${detail}${
      this.hint ? `\n\nHint: ${this.hint}` : ''
    }`;
  }
}

/** The request never produced a response — DNS failure, socket error, timeout, abort. */
export class TransportError extends RenderMcpError {
  readonly kind = 'transport';

  constructor(message: string, cause?: unknown, hint?: string) {
    super(message, { ...(cause !== undefined ? { cause } : {}), ...(hint !== undefined ? { hint } : {}) });
  }
}

function renderBody(body: unknown): string {
  if (body === undefined || body === null || body === '') return '';
  if (typeof body === 'string') return body.slice(0, 2000);
  try {
    return JSON.stringify(body, null, 2).slice(0, 2000);
  } catch {
    // Circular or otherwise unserialisable payload — the type alone is still a useful clue.
    return `[unserialisable ${typeof body} response body]`;
  }
}

/**
 * Maps a Render HTTP status onto advice the model can act on.
 *
 * Render's error bodies are terse (`{"message": "not found"}`), so without this the model
 * tends to retry the identical failing call.
 */
export function hintForStatus(status: number): string | undefined {
  switch (status) {
    case 400:
      return 'The request was rejected as malformed. Re-check required fields and enum values against the tool schema.';
    case 401:
      return 'RENDER_API_KEY is missing, expired or revoked. Create a new key at https://dashboard.render.com/u/settings#api-keys.';
    case 403:
      return 'The API key is valid but lacks permission for this workspace or resource. Confirm the key owner has the required role.';
    case 404:
      return 'The resource does not exist or is outside this API key’s workspaces. Use a list tool to confirm the id first.';
    case 402:
      return 'The workspace needs a payment method or a higher plan for this action.';
    case 406:
      return 'Render could not satisfy the requested representation. This usually indicates an unsupported parameter combination.';
    case 409:
      return 'The resource is in a conflicting state (for example a deploy is already running). Re-read its current state before retrying.';
    case 429:
      return 'Rate limited. The server already retried with backoff; wait before issuing further calls.';
    case 500:
    case 502:
    case 503:
    case 504:
      return 'Render returned a server-side error. This is usually transient; check https://status.render.com if it persists.';
    default:
      return undefined;
  }
}
