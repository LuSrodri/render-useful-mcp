/**
 * Shape of `operations.json`, shared by the generator and the runtime.
 *
 * Keeping the contract in one place means a change to the emitted catalogue that the
 * runtime cannot consume is a compile error rather than a runtime surprise.
 */
import type { ToolsetId } from '../tools/toolsets.js';

/** A JSON Schema fragment. Untyped by design — it is passed through to MCP clients verbatim. */
export type JsonSchema = {
  type?: string;
  description?: string;
  [keyword: string]: unknown;
};

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/**
 * How the tool's flat argument object maps back onto an HTTP request body.
 *
 * - `none`      — the operation takes no body.
 * - `flattened` — body properties are top-level tool arguments (the common case).
 * - `wrapped`   — the body is an array or a `oneOf`, so it lives under the `body` argument.
 * - `multipart` — the body is sent as `multipart/form-data`.
 */
export type BodyMode = 'none' | 'flattened' | 'wrapped' | 'multipart';

export interface OperationDefinition {
  /** MCP tool name, e.g. `render_list_services`. */
  readonly name: string;
  /** Upstream OpenAPI `operationId`, e.g. `list-services`. */
  readonly operationId: string;
  readonly method: HttpMethod;
  /** Path template relative to the API base URL, e.g. `/services/{serviceId}`. */
  readonly path: string;
  readonly title: string;
  readonly description: string;
  /** Upstream OpenAPI tag. */
  readonly tag: string;
  readonly toolset: ToolsetId;
  readonly deprecated: boolean;
  readonly readOnly: boolean;
  readonly destructive: boolean;
  readonly idempotent: boolean;
  /** True when the endpoint responds with `text/event-stream`. */
  readonly streaming: boolean;
  readonly pathParams: readonly string[];
  readonly queryParams: readonly string[];
  readonly bodyMode: BodyMode;
  /** Argument names that belong in the request body when `bodyMode` is `flattened`/`multipart`. */
  readonly bodyProps: readonly string[];
  readonly inputSchema: JsonSchema;
}

export interface OperationCatalogue {
  readonly $comment: string;
  readonly specTitle: string;
  readonly specVersion: string;
  readonly baseUrl: string;
  readonly operations: readonly OperationDefinition[];
}
