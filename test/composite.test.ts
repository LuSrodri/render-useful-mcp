import { describe, expect, it } from 'vitest';

import { buildCompositeTools } from '../src/tools/composite/index.js';
import { levenshtein, matchScore, similarity } from '../src/tools/composite/similarity.js';
import type { ToolDefinition } from '../src/tools/types.js';
import { parseUrl, stubFetch, testContext, type StubResponse } from './helpers.js';

const tools = new Map(buildCompositeTools().map((tool) => [tool.name, tool]));

function tool(name: string): ToolDefinition {
  const found = tools.get(name);
  if (found === undefined) throw new Error(`no such tool: ${name}`);
  return found;
}

const SERVICES: StubResponse = {
  body: [
    { service: { id: 'srv-1', name: 'api-gateway-prod', type: 'web_service', ownerId: 'tea-1' }, cursor: 'c1' },
    { service: { id: 'srv-2', name: 'worker-prod', type: 'background_worker', ownerId: 'tea-1' }, cursor: 'c2' },
  ],
};

describe('similarity', () => {
  it('computes edit distance symmetrically', () => {
    expect(levenshtein('kitten', 'sitting')).toBe(3);
    expect(levenshtein('sitting', 'kitten')).toBe(3);
    expect(levenshtein('', 'abc')).toBe(3);
    expect(levenshtein('same', 'same')).toBe(0);
    expect(similarity('same', 'same')).toBe(1);
  });

  it('ranks exact matches above prefixes above substrings above typos', () => {
    expect(matchScore('api', 'api')).toBe(1);
    expect(matchScore('api', 'api-gateway')).toBeGreaterThan(matchScore('api', 'my-api-gateway'));
    expect(matchScore('api', 'my-api-gateway')).toBeGreaterThan(matchScore('api', 'aip'));
    expect(matchScore('api', 'postgres-db')).toBeLessThan(0.5);
  });

  it('is case-insensitive', () => {
    expect(matchScore('API', 'api')).toBe(1);
  });
});

describe('render_find_service', () => {
  it('fetches directly when given a service id', async () => {
    const { fetch, requests } = stubFetch({ body: { id: 'srv-1', name: 'api-gateway-prod' } });
    const result = (await tool('render_find_service').handler({ query: 'srv-1' }, testContext(fetch))) as {
      service: { id: string };
    };

    expect(result.service.id).toBe('srv-1');
    expect(parseUrl(requests[0]!.url).path).toBe('/v1/services/srv-1');
    expect(requests).toHaveLength(1);
  });

  it('resolves an approximate name and reports alternatives', async () => {
    const { fetch } = stubFetch([{ body: [] }, SERVICES]);
    const result = (await tool('render_find_service').handler({ query: 'gateway' }, testContext(fetch))) as {
      service: { id: string; name: string };
      alternatives?: unknown[];
    };

    expect(result.service).toMatchObject({ id: 'srv-1', name: 'api-gateway-prod' });
    expect(result.alternatives).toBeUndefined(); // 'worker-prod' scores below the threshold
  });

  it('uses the API name filter before falling back to a full scan', async () => {
    const { fetch, requests } = stubFetch(SERVICES);
    await tool('render_find_service').handler({ query: 'api-gateway-prod' }, testContext(fetch));

    expect(parseUrl(requests[0]!.url).params).toContainEqual(['name', 'api-gateway-prod']);
    expect(requests).toHaveLength(1); // no fallback scan needed
  });

  it('scopes the search to the configured workspace', async () => {
    const { fetch, requests } = stubFetch(SERVICES);
    await tool('render_find_service').handler({ query: 'api' }, testContext(fetch, { defaultOwnerId: 'tea-9' }));

    expect(parseUrl(requests[0]!.url).params).toContainEqual(['ownerId', 'tea-9']);
  });

  it('fails with guidance when nothing matches', async () => {
    const { fetch } = stubFetch([{ body: [] }, { body: [] }]);
    await expect(tool('render_find_service').handler({ query: 'nonexistent' }, testContext(fetch))).rejects.toThrow(
      /No Render service matches "nonexistent"/,
    );
  });
});

describe('render_wait_for_deploy', () => {
  it('polls until the deploy goes live', async () => {
    const { fetch, requests } = stubFetch([
      { body: { id: 'srv-1', name: 'api' } }, // resolveService
      { body: [{ deploy: { id: 'dep-1', status: 'build_in_progress' }, cursor: 'c' }] }, // latest deploy
      { body: { id: 'dep-1', status: 'build_in_progress' } },
      { body: { id: 'dep-1', status: 'update_in_progress' } },
      { body: { id: 'dep-1', status: 'live', finishedAt: '2026-01-01T00:00:00Z' } },
    ]);

    const result = (await tool('render_wait_for_deploy').handler(
      { serviceId: 'srv-1', pollIntervalSeconds: 2, timeoutSeconds: 60 },
      testContext(fetch),
    )) as { finished: boolean; succeeded: boolean; status: string; polls: number };

    expect(result).toMatchObject({ finished: true, succeeded: true, status: 'live' });
    expect(result.polls).toBe(3);
    expect(parseUrl(requests.at(-1)!.url).path).toBe('/v1/services/srv-1/deploys/dep-1');
  });

  it('reports a failed deploy and points at the next diagnostic step', async () => {
    const { fetch } = stubFetch([
      { body: { id: 'srv-1', name: 'api' } },
      { body: { id: 'dep-9', status: 'build_failed' } },
    ]);

    const result = (await tool('render_wait_for_deploy').handler(
      { serviceId: 'srv-1', deployId: 'dep-9' },
      testContext(fetch),
    )) as { finished: boolean; succeeded: boolean; nextStep: string };

    expect(result).toMatchObject({ finished: true, succeeded: false });
    expect(result.nextStep).toContain('render_service_status');
  });

  it('returns the in-flight state rather than exceeding the timeout', async () => {
    const { fetch } = stubFetch([
      { body: { id: 'srv-1', name: 'api' } },
      { body: { id: 'dep-1', status: 'build_in_progress' } },
    ]);

    const result = (await tool('render_wait_for_deploy').handler(
      { serviceId: 'srv-1', deployId: 'dep-1', timeoutSeconds: 5, pollIntervalSeconds: 60 },
      testContext(fetch),
    )) as { finished: boolean; timedOut: boolean; status: string };

    expect(result).toMatchObject({ finished: false, timedOut: true, status: 'build_in_progress' });
  });

  it('fails clearly when the service has never deployed', async () => {
    const { fetch } = stubFetch([{ body: { id: 'srv-1', name: 'api' } }, { body: [] }]);
    await expect(tool('render_wait_for_deploy').handler({ serviceId: 'srv-1' }, testContext(fetch))).rejects.toThrow(
      /has no deploys yet/,
    );
  });
});

describe('render_service_status', () => {
  it('aggregates configuration, deploys, instances and problem logs', async () => {
    const { fetch, requests } = stubFetch([
      { body: { id: 'srv-1', name: 'api', ownerId: 'tea-1', suspended: 'not_suspended' } },
      { body: [{ deploy: { id: 'dep-1', status: 'build_failed' }, cursor: 'c' }] },
      { body: [{ id: 'ins-1' }] },
      { body: { logs: [{ message: 'boom' }] } },
    ]);

    const result = (await tool('render_service_status').handler({ serviceId: 'srv-1' }, testContext(fetch))) as {
      health: { latestDeployFailed: boolean; latestDeployStatus: string };
      recentProblemLogs: unknown;
    };

    expect(result.health).toMatchObject({ latestDeployStatus: 'build_failed', latestDeployFailed: true });
    expect(result.recentProblemLogs).toEqual({ logs: [{ message: 'boom' }] });

    const logRequest = requests.find((request) => parseUrl(request.url).path === '/v1/logs')!;
    expect(parseUrl(logRequest.url).params).toContainEqual(['level', 'error']);
    expect(parseUrl(logRequest.url).params).toContainEqual(['resource', 'srv-1']);
  });

  it('degrades gracefully when a sub-request fails', async () => {
    const { fetch } = stubFetch([
      { body: { id: 'srv-1', name: 'api', ownerId: 'tea-1' } },
      { body: [{ deploy: { id: 'dep-1', status: 'live' }, cursor: 'c' }] },
      { status: 403, body: { message: 'no access' } },
      { status: 403, body: { message: 'no log access' } },
    ]);

    const result = (await tool('render_service_status').handler({ serviceId: 'srv-1' }, testContext(fetch))) as {
      instances: { unavailable?: string };
      health: { latestDeployStatus: string };
    };

    // A missing sub-result must not lose the parts that did succeed.
    expect(result.instances.unavailable).toContain('403');
    expect(result.health.latestDeployStatus).toBe('live');
  });

  it('skips log retrieval when asked to', async () => {
    const { fetch, requests } = stubFetch([
      { body: { id: 'srv-1', name: 'api', ownerId: 'tea-1' } },
      { body: [] },
      { body: [] },
    ]);

    await tool('render_service_status').handler({ serviceId: 'srv-1', includeLogs: false }, testContext(fetch));
    expect(requests.some((request) => parseUrl(request.url).path === '/v1/logs')).toBe(false);
  });
});

describe('render_recent_logs', () => {
  it('infers ownerId from the resolved service', async () => {
    const { fetch, requests } = stubFetch([
      { body: { id: 'srv-1', name: 'api', ownerId: 'tea-from-service' } },
      { body: { logs: [] } },
    ]);

    await tool('render_recent_logs').handler({ serviceId: 'srv-1', limit: 10 }, testContext(fetch));

    const params = parseUrl(requests[1]!.url).params;
    expect(params).toContainEqual(['ownerId', 'tea-from-service']);
    expect(params).toContainEqual(['direction', 'backward']);
    expect(params).toContainEqual(['limit', '10']);
  });

  it('passes level and text filters through', async () => {
    const { fetch, requests } = stubFetch([{ body: { id: 'srv-1', ownerId: 'tea-1' } }, { body: { logs: [] } }]);

    await tool('render_recent_logs').handler(
      { serviceId: 'srv-1', level: ['error'], text: ['timeout'] },
      testContext(fetch),
    );

    const params = parseUrl(requests[1]!.url).params;
    expect(params).toContainEqual(['level', 'error']);
    expect(params).toContainEqual(['text', 'timeout']);
  });

  it('explains how to supply a workspace when none can be inferred', async () => {
    const { fetch } = stubFetch([{ body: { id: 'srv-1', name: 'api' } }, { body: { logs: [] } }]);
    await expect(tool('render_recent_logs').handler({ serviceId: 'srv-1' }, testContext(fetch))).rejects.toThrow(
      /RENDER_WORKSPACE_ID/,
    );
  });
});
