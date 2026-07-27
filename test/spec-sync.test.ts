/**
 * Tests for the spec-sync tooling.
 *
 * The extraction reaches into third-party HTML, so its guard rails matter more than most
 * code here: the failure that must never happen is accepting a document that parses but
 * is not the real spec, silently replacing a good one.
 */
import { describe, expect, it } from 'vitest';

import {
  assertLooksLikeRenderSpec,
  countOperations,
  extractJsonObject,
  extractSpecFromHtml,
} from '../scripts/fetch-spec.js';
import { diffCatalogues, isBreaking, renderMarkdown } from '../scripts/diff-catalogue.js';
import type { OperationCatalogue, OperationDefinition } from '../src/generated/types.js';
import { loadCatalogue } from '../src/generated/catalogue.js';

function validSpec(operationCount = 200): Record<string, unknown> {
  const paths: Record<string, Record<string, unknown>> = {};
  for (let index = 0; index < operationCount; index += 1) {
    paths[`/thing-${index}`] = { get: { operationId: `op-${index}` } };
  }
  return {
    openapi: '3.0.2',
    info: { title: 'Render Public API', version: '1.0.0' },
    servers: [{ url: 'https://api.render.com/v1' }],
    paths,
    components: { schemas: {} },
  };
}

describe('extractJsonObject', () => {
  it('extracts a balanced object embedded in surrounding text', () => {
    const html = `<script>window.data = {"a":{"b":1}};</script>`;
    expect(extractJsonObject(html, html.indexOf('{'))).toBe('{"a":{"b":1}}');
  });

  it('ignores braces inside string literals', () => {
    const html = `prefix {"description":"use {curly} braces","n":1} suffix`;
    const extracted = extractJsonObject(html, html.indexOf('{'));
    expect(JSON.parse(extracted)).toEqual({ description: 'use {curly} braces', n: 1 });
  });

  it('ignores escaped quotes, which would otherwise flip string state', () => {
    const html = `{"quote":"a \\" brace } here","ok":true}`;
    expect(JSON.parse(extractJsonObject(html, 0))).toEqual({ quote: 'a " brace } here', ok: true });
  });

  it('throws rather than returning a truncated object', () => {
    expect(() => extractJsonObject('{"a":{"b":1}', 0)).toThrow(/Unterminated/);
  });
});

describe('extractSpecFromHtml', () => {
  it('finds the spec embedded in a page', () => {
    const html = `<html><body><script>window.x = ${JSON.stringify(validSpec())};</script></body></html>`;
    expect(extractSpecFromHtml(html).info.title).toBe('Render Public API');
  });

  it('names the likely cause when no spec is present', () => {
    expect(() => extractSpecFromHtml('<html><body>nothing here</body></html>')).toThrow(
      /No embedded OpenAPI document found/,
    );
  });
});

describe('assertLooksLikeRenderSpec', () => {
  it('accepts the real vendored spec', () => {
    expect(() => assertLooksLikeRenderSpec(validSpec())).not.toThrow();
  });

  it('rejects a truncated document, which is the dangerous case', () => {
    // Parses fine, looks structurally right, but would wipe out most of the catalogue.
    expect(() => assertLooksLikeRenderSpec(validSpec(12))).toThrow(/looks truncated/);
  });

  it('rejects a different API that happens to be valid OpenAPI', () => {
    const other = { ...validSpec(), info: { title: 'Some Other API', version: '1.0.0' } };
    expect(() => assertLooksLikeRenderSpec(other)).toThrow(/unexpected title/);
  });

  it('rejects a spec pointing at a different server', () => {
    const moved = { ...validSpec(), servers: [{ url: 'https://staging.example.com/v1' }] };
    expect(() => assertLooksLikeRenderSpec(moved)).toThrow(/unexpected server/);
  });

  it('rejects non-objects and wrong OpenAPI versions', () => {
    expect(() => assertLooksLikeRenderSpec(null)).toThrow(/not an object/);
    expect(() => assertLooksLikeRenderSpec('a string')).toThrow(/not an object/);
    expect(() => assertLooksLikeRenderSpec({ ...validSpec(), openapi: '2.0' })).toThrow(/unexpected openapi/);
  });
});

describe('countOperations', () => {
  it('counts only HTTP methods, not path-level parameters', () => {
    expect(
      countOperations({
        '/a': { get: {}, post: {}, parameters: [] },
        '/b': { delete: {} },
      }),
    ).toBe(3);
  });
});

describe('diffCatalogues', () => {
  const real = loadCatalogue();

  function catalogue(operations: OperationDefinition[], specVersion = '1.0.0'): OperationCatalogue {
    return { $comment: '', specTitle: 'Render Public API', specVersion, baseUrl: '', operations };
  }

  const base: OperationDefinition[] = [...real.operations.slice(0, 5)];

  it('reports no changes for an identical catalogue', () => {
    const diff = diffCatalogues(catalogue(base), catalogue(base));
    expect(diff.added).toHaveLength(0);
    expect(diff.removed).toHaveLength(0);
    expect(diff.changed).toHaveLength(0);
    expect(isBreaking(diff)).toBe(false);
    expect(renderMarkdown(diff, catalogue(base))).toContain('No operation-level changes');
  });

  it('detects an added operation without flagging it as breaking', () => {
    const added = { ...base[0]!, name: 'render_brand_new', path: '/brand-new' };
    const diff = diffCatalogues(catalogue(base), catalogue([...base, added]));

    expect(diff.added.map((o) => o.name)).toEqual(['render_brand_new']);
    expect(isBreaking(diff)).toBe(false);
  });

  it('treats a removed operation as breaking', () => {
    const diff = diffCatalogues(catalogue(base), catalogue(base.slice(1)));

    expect(diff.removed).toHaveLength(1);
    expect(isBreaking(diff)).toBe(true);
    expect(renderMarkdown(diff, catalogue(base.slice(1)))).toContain('breaking change');
  });

  it('treats a newly required argument as breaking', () => {
    const before = base[0]!;
    const after: OperationDefinition = {
      ...before,
      inputSchema: {
        ...before.inputSchema,
        required: [...((before.inputSchema['required'] ?? []) as string[]), 'newFlag'],
      },
    };
    const diff = diffCatalogues(catalogue([before]), catalogue([after]));

    expect(diff.changed[0]!.reasons.some((r) => r.startsWith('newly required'))).toBe(true);
    expect(isBreaking(diff)).toBe(true);
  });

  it('reports moved endpoints, deprecation and new arguments', () => {
    const before = base[0]!;
    const after: OperationDefinition = {
      ...before,
      path: '/moved',
      deprecated: !before.deprecated,
      queryParams: [...before.queryParams, 'extra'],
    };
    const reasons = diffCatalogues(catalogue([before]), catalogue([after])).changed[0]!.reasons;

    expect(reasons.some((r) => r.includes('endpoint moved'))).toBe(true);
    expect(reasons.some((r) => r.includes('deprecated'))).toBe(true);
    expect(reasons.some((r) => r.includes('new arguments'))).toBe(true);
  });

  it('falls back to a generic note for constraint-only schema changes', () => {
    const before = base[0]!;
    const after: OperationDefinition = {
      ...before,
      inputSchema: { ...before.inputSchema, description: 'a different description' },
    };
    expect(diffCatalogues(catalogue([before]), catalogue([after])).changed[0]!.reasons).toEqual([
      'input schema changed (enum values, constraints or nested shape)',
    ]);
  });

  it('surfaces a spec version bump', () => {
    const diff = diffCatalogues(catalogue(base, '1.0.0'), catalogue(base, '2.0.0'));
    expect(diff.specVersionChanged).toEqual({ before: '1.0.0', after: '2.0.0' });
    expect(renderMarkdown(diff, catalogue(base, '2.0.0'))).toContain('1.0.0');
  });
});
