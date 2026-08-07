/**
 * Invariants of the generated catalogue.
 *
 * These guard the codegen: if a future Render spec breaks one of them, `npm test` fails
 * before the broken tool catalogue can ship.
 */
import { describe, expect, it } from 'vitest';

import { loadCatalogue, loadOperations } from '../src/generated/catalogue.js';
import { TOOLSET_IDS } from '../src/tools/toolsets.js';
import { OPERATION_HINTS } from '../src/tools/operation-hints.js';

const catalogue = loadCatalogue();
const operations = loadOperations();

describe('generated catalogue', () => {
  it('covers every operation in the Render spec', () => {
    expect(operations).toHaveLength(207);
    expect(catalogue.baseUrl).toBe('https://api.render.com/v1');
  });

  it('gives every tool a unique, client-safe name', () => {
    const names = operations.map((operation) => operation.name);
    expect(new Set(names).size).toBe(names.length);
    for (const name of names) {
      expect(name).toMatch(/^render_[a-z][a-z0-9_]*$/);
      // Several MCP clients reject tool names longer than 64 characters.
      expect(name.length).toBeLessThanOrEqual(64);
    }
  });

  it('assigns every operation to a known toolset', () => {
    for (const operation of operations) {
      expect(TOOLSET_IDS).toContain(operation.toolset);
    }
  });

  it('emits a valid object schema for every tool', () => {
    for (const operation of operations) {
      expect(operation.inputSchema['type'], operation.name).toBe('object');
      expect(operation.inputSchema['properties'], operation.name).toBeTypeOf('object');
      expect(operation.inputSchema['additionalProperties'], operation.name).toBe(false);
    }
  });

  it('declares every path template variable as a required property', () => {
    for (const operation of operations) {
      const templated = [...operation.path.matchAll(/\{([^}]+)\}/g)].map((match) => match[1]!);
      const required = (operation.inputSchema['required'] ?? []) as string[];
      const properties = operation.inputSchema['properties'] as Record<string, unknown>;
      for (const name of templated) {
        expect(operation.pathParams, `${operation.name} pathParams`).toContain(name);
        expect(required, `${operation.name} required`).toContain(name);
        expect(properties, `${operation.name} properties`).toHaveProperty(name);
      }
    }
  });

  it('fully dereferences schemas so clients never see a dangling $ref', () => {
    const serialised = JSON.stringify(operations.map((operation) => operation.inputSchema));
    expect(serialised).not.toContain('$ref');
  });

  it('keeps parameter and body names disjoint when flattening bodies', () => {
    for (const operation of operations) {
      if (operation.bodyMode !== 'flattened' && operation.bodyMode !== 'multipart') continue;
      const params = new Set([...operation.pathParams, ...operation.queryParams]);
      for (const property of operation.bodyProps) {
        expect(params.has(property), `${operation.name}.${property} collides`).toBe(false);
      }
    }
  });

  it('declares body properties that exist in the schema', () => {
    for (const operation of operations) {
      const properties = operation.inputSchema['properties'] as Record<string, unknown>;
      for (const name of [...operation.pathParams, ...operation.queryParams, ...operation.bodyProps]) {
        expect(properties, `${operation.name} missing ${name}`).toHaveProperty(name);
      }
      if (operation.bodyMode === 'wrapped') expect(properties).toHaveProperty('body');
    }
  });

  it('marks GET operations read-only and never destructive', () => {
    for (const operation of operations) {
      expect(operation.readOnly).toBe(operation.method === 'GET');
      if (operation.method === 'GET') expect(operation.destructive).toBe(false);
    }
  });

  it('flags every DELETE operation as destructive', () => {
    for (const operation of operations.filter((entry) => entry.method === 'DELETE')) {
      expect(operation.destructive, operation.name).toBe(true);
    }
  });

  it('recognises the known destructive non-DELETE operations', () => {
    const destructive = new Set(
      operations.filter((operation) => operation.destructive).map((operation) => operation.name),
    );
    for (const name of [
      'render_suspend_service',
      'render_restart_service',
      'render_cancel_deploy',
      'render_rollback_deploy',
      'render_failover_postgres',
      'render_purge_cache',
    ]) {
      expect(destructive, name).toContain(name);
    }
    expect(destructive).not.toContain('render_list_services');
    expect(destructive).not.toContain('render_create_service');
  });

  it('marks the one SSE endpoint as streaming', () => {
    const streaming = operations.filter((operation) => operation.streaming).map((operation) => operation.name);
    expect(streaming).toEqual(['render_stream_task_runs_events']);
  });

  it('isolates deprecated Render endpoints in their own toolset and labels them', () => {
    const deprecated = operations.filter((operation) => operation.deprecated);
    expect(deprecated.length).toBe(8);
    for (const operation of deprecated) {
      expect(operation.toolset).toBe('deprecated');
      expect(operation.description).toContain('[DEPRECATED by Render]');
    }
  });

  it('leaves no oneOf branch a caller cannot tell apart from its siblings', () => {
    // Inlining a `$ref` discards the only thing distinguishing structurally similar
    // branches, which is how picking the cron-job shape out of five service shapes became
    // guesswork. Titling restores it for named schemas; the handful of branches the spec
    // writes inline carry no name, so they must at least differ in what they require.
    const ambiguous: string[] = [];

    const walk = (schema: unknown, path: string): void => {
      if (Array.isArray(schema)) {
        schema.forEach((item, index) => walk(item, `${path}[${index}]`));
        return;
      }
      if (schema === null || typeof schema !== 'object') return;

      for (const [keyword, value] of Object.entries(schema as Record<string, unknown>)) {
        if ((keyword === 'oneOf' || keyword === 'anyOf') && Array.isArray(value)) {
          const fingerprints = new Set<string>();
          value.forEach((branch, index) => {
            const record = (branch ?? {}) as Record<string, unknown>;
            // Whatever a caller could read to choose this branch over its siblings: the
            // schema name we carried across, else prose, else its bare shape.
            const fingerprint =
              (record['title'] as string | undefined) ??
              (record['description'] as string | undefined) ??
              `${String(record['type'])}:${JSON.stringify(record['required'] ?? null)}`;
            if (fingerprints.has(fingerprint)) ambiguous.push(`${path}.${keyword}[${index}]`);
            fingerprints.add(fingerprint);
          });
        }
        walk(value, `${path}.${keyword}`);
      }
    };

    for (const operation of operations) {
      walk(operation.inputSchema, operation.name);
    }
    expect(ambiguous).toEqual([]);
  });

  it('makes the Docker cron job path decidable from render_create_service alone', () => {
    // Pins a failure seen in practice: nothing linked `type: cron_job` to its branch, or
    // `runtime: docker` to its own, so models assembled an invalid request or gave up.
    const create = operations.find((operation) => operation.name === 'render_create_service')!;
    const properties = create.inputSchema['properties'] as Record<string, Record<string, unknown>>;

    const serviceDetails = properties['serviceDetails']!['oneOf'] as Array<Record<string, unknown>>;
    expect(serviceDetails.map((branch) => branch['title'])).toEqual([
      'staticSiteDetailsPOST',
      'webServiceDetailsPOST',
      'privateServiceDetailsPOST',
      'backgroundWorkerDetailsPOST',
      'cronJobDetailsPOST',
    ]);

    const cronJob = serviceDetails.find((branch) => branch['title'] === 'cronJobDetailsPOST')!;
    expect(cronJob['required']).toContain('schedule');

    const runtimes = (cronJob['properties'] as Record<string, Record<string, unknown>>)['envSpecificDetails']![
      'oneOf'
    ] as Array<Record<string, unknown>>;
    expect(runtimes.map((branch) => branch['title'])).toEqual(['dockerDetails', 'nativeEnvironmentDetails']);

    // The description has to carry the type→branch mapping; the schema cannot express it.
    expect(create.description).toContain('cronJobDetailsPOST');
    expect(create.description).toContain('dockerDetails');
  });

  it('appends a usage hint to exactly the operations that have one', () => {
    const hinted = operations
      .filter((operation) => operation.description.includes('Usage:'))
      .map((operation) => operation.operationId)
      .sort();
    expect(hinted).toEqual(Object.keys(OPERATION_HINTS).sort());
  });
});
