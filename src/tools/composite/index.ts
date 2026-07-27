/**
 * Composite tools: workflows that the raw API forces a model to assemble from several
 * calls, implemented once here so a single tool call does the whole job.
 *
 * Each one is deliberately a common, high-frequency Render workflow — finding a service by
 * name, waiting for a deploy, triaging a broken service, reading recent logs. They complement
 * the generated tools rather than replacing them.
 */
import { RenderMcpError } from '../../errors.js';
import { sleep } from '../../render/retry.js';
import type { ToolDefinition } from '../types.js';
import { pick, requireOwnerId, resolveService, summariseService, type RenderService } from './shared.js';

/** Deploy statuses from which a deploy never transitions again. */
const TERMINAL_DEPLOY_STATUSES = new Set([
  'live',
  'deactivated',
  'build_failed',
  'update_failed',
  'canceled',
  'pre_deploy_failed',
]);

const FAILED_DEPLOY_STATUSES = new Set(['build_failed', 'update_failed', 'canceled', 'pre_deploy_failed']);

interface Deploy {
  readonly id: string;
  readonly status: string;
  readonly commit?: { readonly id?: string; readonly message?: string };
  readonly createdAt?: string;
  readonly finishedAt?: string;
  readonly [key: string]: unknown;
}

export function buildCompositeTools(): readonly ToolDefinition[] {
  return [findServiceTool, waitForDeployTool, serviceStatusTool, recentLogsTool];
}

// ---------------------------------------------------------------------------
// render_find_service
// ---------------------------------------------------------------------------

const findServiceTool: ToolDefinition = {
  name: 'render_find_service',
  title: 'Find a service by name or id',
  description:
    'Resolves a service name — including a partial or approximate one — to a single Render service, ' +
    'returning its id plus close alternatives. Use this first whenever the user names a service instead ' +
    'of giving an id; every other service tool needs the id.',
  toolset: 'core',
  mutating: false,
  annotations: {
    title: 'Find a service by name or id',
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  inputSchema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'Service name, partial name, or service id (srv-…). Matching is case-insensitive and fuzzy.',
      },
      ownerId: {
        type: 'string',
        description: 'Workspace to search. Defaults to RENDER_WORKSPACE_ID when configured.',
      },
    },
    required: ['query'],
    additionalProperties: false,
    $schema: 'http://json-schema.org/draft-07/schema#',
  },
  handler: async (args, context) => {
    const { service, alternatives } = await resolveService(String(args['query']), context, {
      ownerId: args['ownerId'] as string | undefined,
    });
    return {
      service: summariseService(service),
      ...(alternatives.length > 0
        ? { alternatives: alternatives.map((entry) => pick(entry, ['id', 'name', 'type'])) }
        : {}),
    };
  },
};

// ---------------------------------------------------------------------------
// render_wait_for_deploy
// ---------------------------------------------------------------------------

const waitForDeployTool: ToolDefinition = {
  name: 'render_wait_for_deploy',
  title: 'Wait for a deploy to finish',
  description:
    'Polls a deploy until it reaches a terminal state (live, build_failed, update_failed, canceled, ' +
    "deactivated) or the timeout expires. Defaults to the service's most recent deploy. Use after " +
    'render_create_deploy instead of polling render_retrieve_deploy in a loop.',
  toolset: 'core',
  mutating: false,
  annotations: {
    title: 'Wait for a deploy to finish',
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  inputSchema: {
    type: 'object',
    properties: {
      serviceId: { type: 'string', description: 'Service id (srv-…) or service name.' },
      deployId: {
        type: 'string',
        description: 'Deploy to watch. Omit to watch the most recent deploy of the service.',
      },
      timeoutSeconds: {
        type: 'integer',
        minimum: 5,
        maximum: 900,
        default: 300,
        description: 'How long to wait before returning the deploy in its current state.',
      },
      pollIntervalSeconds: {
        type: 'integer',
        minimum: 2,
        maximum: 60,
        default: 5,
        description: 'Delay between status checks.',
      },
    },
    required: ['serviceId'],
    additionalProperties: false,
    $schema: 'http://json-schema.org/draft-07/schema#',
  },
  handler: async (args, context) => {
    const { service } = await resolveService(String(args['serviceId']), context);
    const timeoutMs = Number(args['timeoutSeconds'] ?? 300) * 1000;
    const intervalMs = Number(args['pollIntervalSeconds'] ?? 5) * 1000;
    const deadline = Date.now() + timeoutMs;

    let deployId = args['deployId'] as string | undefined;
    if (deployId === undefined) {
      const latest = await context.client.paginate<Deploy>({
        path: `/services/${encodeURIComponent(service.id)}/deploys`,
        limit: 1,
        ...(context.signal !== undefined ? { signal: context.signal } : {}),
      });
      const newest = latest.items[0];
      if (newest === undefined) {
        throw new Error(`Service ${service.name} (${service.id}) has no deploys yet.`);
      }
      deployId = newest.id;
    }

    let polls = 0;
    for (;;) {
      const response = await context.client.request<Deploy>({
        method: 'GET',
        path: `/services/${encodeURIComponent(service.id)}/deploys/${encodeURIComponent(deployId)}`,
        ...(context.signal !== undefined ? { signal: context.signal } : {}),
      });
      polls += 1;
      const deploy = response.data;

      if (TERMINAL_DEPLOY_STATUSES.has(deploy.status)) {
        return {
          finished: true,
          succeeded: deploy.status === 'live',
          status: deploy.status,
          polls,
          service: pick(service, ['id', 'name']),
          deploy: pick(deploy, ['id', 'status', 'commit', 'image', 'createdAt', 'updatedAt', 'finishedAt']),
          ...(FAILED_DEPLOY_STATUSES.has(deploy.status)
            ? { nextStep: 'Call render_service_status or render_recent_logs to see why the deploy failed.' }
            : {}),
        };
      }

      // Returning the in-flight state beats silently exceeding the caller's budget.
      if (Date.now() + intervalMs >= deadline) {
        return {
          finished: false,
          status: deploy.status,
          polls,
          timedOut: true,
          service: pick(service, ['id', 'name']),
          deploy: pick(deploy, ['id', 'status', 'commit', 'createdAt', 'updatedAt']),
          nextStep: `Still ${deploy.status} after ${Math.round(timeoutMs / 1000)}s. Call this tool again to keep waiting.`,
        };
      }

      await sleep(intervalMs, context.signal);
    }
  },
};

// ---------------------------------------------------------------------------
// render_service_status
// ---------------------------------------------------------------------------

const serviceStatusTool: ToolDefinition = {
  name: 'render_service_status',
  title: 'Diagnose a service',
  description:
    'One-call triage for a service: its configuration, latest deploys, running instances and most ' +
    'recent error-level logs. Use this to answer "is X healthy?" or "why is X broken?" instead of ' +
    'chaining retrieve/list/logs calls.',
  toolset: 'core',
  mutating: false,
  annotations: {
    title: 'Diagnose a service',
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  inputSchema: {
    type: 'object',
    properties: {
      serviceId: { type: 'string', description: 'Service id (srv-…) or service name.' },
      deployCount: {
        type: 'integer',
        minimum: 1,
        maximum: 20,
        default: 5,
        description: 'How many recent deploys to include.',
      },
      includeLogs: {
        type: 'boolean',
        default: true,
        description: 'Include recent error/warning logs. Requires the API key to have log access.',
      },
    },
    required: ['serviceId'],
    additionalProperties: false,
    $schema: 'http://json-schema.org/draft-07/schema#',
  },
  handler: async (args, context) => {
    const { service } = await resolveService(String(args['serviceId']), context);
    const deployCount = Number(args['deployCount'] ?? 5);
    const includeLogs = args['includeLogs'] !== false;
    const signal = context.signal !== undefined ? { signal: context.signal } : {};

    // These are independent reads; running them concurrently keeps the tool responsive.
    const [deploys, instances, logs] = await Promise.all([
      context.client
        .paginate<Deploy>({
          path: `/services/${encodeURIComponent(service.id)}/deploys`,
          limit: deployCount,
          ...signal,
        })
        // A mutable array type is deliberate: `Array.isArray` widens a `readonly T[]` to
        // `any[]` when narrowing, which would erase `Deploy` from everything downstream.
        .then((page): Deploy[] | Unavailable => [...page.items])
        .catch(unavailable),
      context.client
        .request<unknown>({ method: 'GET', path: `/services/${encodeURIComponent(service.id)}/instances`, ...signal })
        .then((response) => response.data)
        .catch(unavailable),
      includeLogs
        ? fetchRecentLogs(service, context, { level: ['error', 'warning'], limit: 20 }).catch(unavailable)
        : undefined,
    ]);

    const latest = Array.isArray(deploys) ? deploys[0] : undefined;

    return {
      service: { ...summariseService(service), serviceDetails: service.serviceDetails },
      health: {
        suspended: service.suspended ?? 'unknown',
        latestDeployStatus: latest?.status ?? 'unknown',
        latestDeployFailed: latest !== undefined && FAILED_DEPLOY_STATUSES.has(latest.status),
      },
      recentDeploys: Array.isArray(deploys)
        ? deploys.map((deploy) => pick(deploy, ['id', 'status', 'commit', 'createdAt', 'finishedAt']))
        : deploys,
      instances,
      ...(includeLogs ? { recentProblemLogs: logs } : {}),
    };
  },
};

// ---------------------------------------------------------------------------
// render_recent_logs
// ---------------------------------------------------------------------------

const recentLogsTool: ToolDefinition = {
  name: 'render_recent_logs',
  title: 'Read recent logs for a service',
  description:
    'Fetches recent log lines for a service, resolving the service name and workspace id for you. ' +
    'Prefer this over render_list_logs, which needs an ownerId and a resource array. Filter with ' +
    'text/level to find errors quickly.',
  toolset: 'core',
  mutating: false,
  annotations: {
    title: 'Read recent logs for a service',
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  inputSchema: {
    type: 'object',
    properties: {
      serviceId: { type: 'string', description: 'Service id (srv-…) or service name.' },
      limit: { type: 'integer', minimum: 1, maximum: 200, default: 50, description: 'Maximum log lines to return.' },
      level: {
        type: 'array',
        items: { type: 'string' },
        description: 'Filter by log level, e.g. ["error"] or ["error","warning"].',
      },
      text: {
        type: 'array',
        items: { type: 'string' },
        description: 'Only return lines containing these substrings.',
      },
      startTime: { type: 'string', description: 'RFC3339 start of the window. Defaults to one hour ago.' },
      endTime: { type: 'string', description: 'RFC3339 end of the window. Defaults to now.' },
      ownerId: { type: 'string', description: 'Workspace id. Inferred from the service when omitted.' },
    },
    required: ['serviceId'],
    additionalProperties: false,
    $schema: 'http://json-schema.org/draft-07/schema#',
  },
  handler: async (args, context) => {
    const { service } = await resolveService(String(args['serviceId']), context);
    return fetchRecentLogs(service, context, {
      limit: Number(args['limit'] ?? 50),
      level: args['level'] as string[] | undefined,
      text: args['text'] as string[] | undefined,
      startTime: args['startTime'] as string | undefined,
      endTime: args['endTime'] as string | undefined,
      ownerId: args['ownerId'] as string | undefined,
    });
  },
};

interface LogQuery {
  readonly limit?: number;
  readonly level?: readonly string[] | undefined;
  readonly text?: readonly string[] | undefined;
  readonly startTime?: string | undefined;
  readonly endTime?: string | undefined;
  readonly ownerId?: string | undefined;
}

async function fetchRecentLogs(
  service: RenderService,
  context: Parameters<ToolDefinition['handler']>[1],
  query: LogQuery,
): Promise<unknown> {
  const ownerId = requireOwnerId(query.ownerId, service, context);
  const response = await context.client.request<{ logs?: unknown[]; hasMore?: boolean }>({
    method: 'GET',
    path: '/logs',
    query: {
      ownerId,
      resource: [service.id],
      direction: 'backward',
      limit: query.limit ?? 50,
      ...(query.level !== undefined && query.level.length > 0 ? { level: [...query.level] } : {}),
      ...(query.text !== undefined && query.text.length > 0 ? { text: [...query.text] } : {}),
      ...(query.startTime !== undefined ? { startTime: query.startTime } : {}),
      ...(query.endTime !== undefined ? { endTime: query.endTime } : {}),
    },
    ...(context.signal !== undefined ? { signal: context.signal } : {}),
  });
  return response.data;
}

/**
 * Turns an optional sub-request failure into an inline note instead of failing the whole tool.
 *
 * Uses the rich message where available so the note keeps the HTTP status and hint — a bare
 * "no access" leaves the model with nothing to act on.
 */
function unavailable(error: unknown): Unavailable {
  if (error instanceof RenderMcpError) return { unavailable: error.toToolMessage() };
  return { unavailable: error instanceof Error ? error.message : String(error) };
}

interface Unavailable {
  readonly unavailable: string;
}
