/**
 * Invariants of the generated catalogue.
 *
 * These guard the codegen: if a future Render spec breaks one of them, `npm test` fails
 * before the broken tool catalogue can ship.
 */
import { describe, expect, it } from 'vitest';

import { loadCatalogue, loadOperations } from '../src/generated/catalogue.js';
import { TOOLSET_IDS } from '../src/tools/toolsets.js';

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
});
