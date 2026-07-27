/**
 * Helpers shared by the composite tools: resource lookup and payload slimming.
 */
import type { ToolContext } from '../types.js';
import { matchScore } from './similarity.js';

/** The subset of a Render service the composite tools rely on. */
export interface RenderService {
  readonly id: string;
  readonly name: string;
  readonly type?: string;
  readonly ownerId?: string;
  readonly repo?: string;
  readonly branch?: string;
  readonly suspended?: string;
  readonly dashboardUrl?: string;
  readonly serviceDetails?: Record<string, unknown>;
  readonly [key: string]: unknown;
}

/** Render ids are prefixed by resource type (`srv-…`, `dpg-…`, `red-…`). */
export function looksLikeServiceId(value: string): boolean {
  return /^(srv|crn|sta)-[a-z0-9]+$/i.test(value);
}

/**
 * Resolves a service id or a human name onto a single service.
 *
 * Ids short-circuit to a direct fetch. Names go through the API's own `name` filter first
 * and fall back to ranked local matching, which is what makes approximate names work.
 */
export async function resolveService(
  reference: string,
  context: ToolContext,
  options: { readonly ownerId?: string | undefined } = {},
): Promise<{ readonly service: RenderService; readonly alternatives: readonly RenderService[] }> {
  if (looksLikeServiceId(reference)) {
    const response = await context.client.request<RenderService>({
      method: 'GET',
      path: `/services/${encodeURIComponent(reference)}`,
      ...(context.signal !== undefined ? { signal: context.signal } : {}),
    });
    return { service: response.data, alternatives: [] };
  }

  const ownerId = options.ownerId ?? context.config.defaultOwnerId;
  const ownerQuery = ownerId !== undefined ? { ownerId: [ownerId] } : {};

  const narrowed = await context.client.paginate<RenderService>({
    path: '/services',
    query: { ...ownerQuery, name: [reference] },
    limit: 50,
    ...(context.signal !== undefined ? { signal: context.signal } : {}),
  });

  // Render's `name` filter is exact-ish; a miss is common for partial names, so widen.
  const candidates =
    narrowed.items.length > 0
      ? narrowed.items
      : (
          await context.client.paginate<RenderService>({
            path: '/services',
            query: ownerQuery,
            limit: 300,
            ...(context.signal !== undefined ? { signal: context.signal } : {}),
          })
        ).items;

  const ranked = candidates
    .map((service) => ({ service, score: matchScore(reference, service.name ?? '') }))
    .filter((entry) => entry.score >= 0.5)
    .sort((a, b) => b.score - a.score);

  const best = ranked[0];
  if (best === undefined) {
    throw new Error(
      `No Render service matches "${reference}". ` +
        `Call render_list_services to see what exists${ownerId === undefined ? ', and pass ownerId to scope the search' : ''}.`,
    );
  }

  return { service: best.service, alternatives: ranked.slice(1, 5).map((entry) => entry.service) };
}

/** Trims a service to the fields worth spending context on. */
export function summariseService(service: RenderService): Record<string, unknown> {
  return pick(service, [
    'id',
    'name',
    'type',
    'ownerId',
    'repo',
    'branch',
    'rootDir',
    'suspended',
    'suspenders',
    'createdAt',
    'updatedAt',
    'dashboardUrl',
    'environmentId',
  ]);
}

export function pick(source: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const key of keys) {
    if (source[key] !== undefined && source[key] !== null) result[key] = source[key];
  }
  return result;
}

/** Reads `RENDER_WORKSPACE_ID`-style defaults, preferring an explicit argument. */
export function requireOwnerId(explicit: unknown, service: RenderService | undefined, context: ToolContext): string {
  const ownerId =
    (typeof explicit === 'string' && explicit !== '' ? explicit : undefined) ??
    service?.ownerId ??
    context.config.defaultOwnerId;
  if (ownerId === undefined) {
    throw new Error(
      'A workspace id is required. Pass ownerId, or set RENDER_WORKSPACE_ID so it is applied automatically. ' +
        'Use render_list_owners to find your workspace id.',
    );
  }
  return ownerId;
}
