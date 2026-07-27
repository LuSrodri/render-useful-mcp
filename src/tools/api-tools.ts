/**
 * Turns every generated operation into an MCP tool.
 *
 * The mapping from a flat argument object back to an HTTP request is fully driven by the
 * metadata the generator emitted (`pathParams`, `queryParams`, `bodyMode`, `bodyProps`),
 * so there is exactly one code path for all 207 endpoints.
 */
import type { OperationDefinition } from '../generated/types.js';
import { loadOperations } from '../generated/catalogue.js';
import type { QueryValue } from '../render/client.js';
import type { ToolAnnotations, ToolContext, ToolDefinition } from './types.js';

/** Query parameters that carry a workspace id and can be defaulted from configuration. */
const OWNER_PARAMS = ['ownerId', 'ownerIds'];

/** Bounds applied to SSE endpoints so a streaming tool call always terminates. */
const STREAM_LIMITS = { maxEvents: 200, maxDurationMs: 15_000 } as const;

export function buildApiTools(
  operations: readonly OperationDefinition[] = loadOperations(),
): readonly ToolDefinition[] {
  return operations.map(toToolDefinition);
}

function toToolDefinition(operation: OperationDefinition): ToolDefinition {
  return {
    name: operation.name,
    title: operation.title,
    description: operation.description,
    inputSchema: operation.inputSchema,
    annotations: annotationsFor(operation),
    toolset: operation.toolset,
    mutating: !operation.readOnly,
    handler: (args, context) => execute(operation, args, context),
  };
}

function annotationsFor(operation: OperationDefinition): ToolAnnotations {
  return {
    title: operation.title,
    readOnlyHint: operation.readOnly,
    destructiveHint: operation.destructive,
    idempotentHint: operation.idempotent,
    // Every tool here talks to a third-party API whose state changes independently.
    openWorldHint: true,
  };
}

export async function execute(
  operation: OperationDefinition,
  args: Record<string, unknown>,
  context: ToolContext,
): Promise<unknown> {
  const resolved = applyOwnerDefault(operation, args, context);
  const path = renderPath(operation, resolved);
  const query = collectQuery(operation, resolved);
  const body = collectBody(operation, resolved);

  if (operation.streaming) {
    const { events, truncated } = await context.client.collectEvents({
      path,
      query,
      ...(context.signal !== undefined ? { signal: context.signal } : {}),
      ...STREAM_LIMITS,
    });
    return {
      events,
      eventCount: events.length,
      truncated,
      ...(truncated
        ? {
            note:
              `Stream sampled for up to ${STREAM_LIMITS.maxDurationMs / 1000}s or ` +
              `${STREAM_LIMITS.maxEvents} events. Call again to continue sampling.`,
          }
        : {}),
    };
  }

  const response = await context.client.request({
    method: operation.method,
    path,
    query,
    ...(body !== undefined ? { body } : {}),
    ...(operation.bodyMode === 'multipart' ? { multipart: true } : {}),
    ...(context.signal !== undefined ? { signal: context.signal } : {}),
  });

  // 204 responses carry no payload; a bare `null` reads as a failure to the model.
  if (response.data === null || response.data === undefined) {
    return { ok: true, status: response.status, message: `${operation.method} ${operation.path} succeeded.` };
  }
  return response.data;
}

/**
 * Fills in `ownerId`/`ownerIds` from `RENDER_WORKSPACE_ID` when the caller omitted it.
 *
 * Most workspace-scoped list endpoints require an owner id that the model has no way to
 * know. Defaulting it removes a lookup round-trip from nearly every session, while an
 * explicit argument always wins.
 */
function applyOwnerDefault(
  operation: OperationDefinition,
  args: Record<string, unknown>,
  context: ToolContext,
): Record<string, unknown> {
  const defaultOwnerId = context.config.defaultOwnerId;
  if (defaultOwnerId === undefined) return args;

  const result = { ...args };
  for (const param of OWNER_PARAMS) {
    const accepted = operation.queryParams.includes(param) || operation.bodyProps.includes(param);
    if (!accepted || result[param] !== undefined) continue;

    const schema = (operation.inputSchema['properties'] as Record<string, { type?: string }> | undefined)?.[param];
    result[param] = schema?.type === 'array' ? [defaultOwnerId] : defaultOwnerId;
  }
  return result;
}

function renderPath(operation: OperationDefinition, args: Record<string, unknown>): string {
  return operation.path.replace(/\{([^}]+)\}/g, (_match, name: string) => {
    const value = args[name];
    // Path parameters are always scalars in this spec, and validation marks them required,
    // so anything else here means the catalogue and the runtime have drifted apart.
    if (typeof value !== 'string' && typeof value !== 'number') {
      throw new Error(`Missing or non-scalar path parameter "${name}" for ${operation.name}`);
    }
    if (value === '') {
      throw new Error(`Empty path parameter "${name}" for ${operation.name}`);
    }
    return encodeURIComponent(value);
  });
}

function collectQuery(operation: OperationDefinition, args: Record<string, unknown>): Record<string, QueryValue> {
  const query: Record<string, QueryValue> = {};
  for (const name of operation.queryParams) {
    const value = args[name];
    if (value !== undefined && value !== null) query[name] = value as QueryValue;
  }
  return query;
}

function collectBody(operation: OperationDefinition, args: Record<string, unknown>): unknown {
  switch (operation.bodyMode) {
    case 'none':
      return undefined;
    case 'wrapped':
      return args['body'];
    case 'flattened':
    case 'multipart': {
      const body: Record<string, unknown> = {};
      for (const name of operation.bodyProps) {
        const value = args[name];
        if (value !== undefined) body[name] = value;
      }
      // Sending `{}` where the API expects no body makes some endpoints 400.
      return Object.keys(body).length > 0 ? body : undefined;
    }
  }
}
