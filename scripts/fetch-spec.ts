#!/usr/bin/env tsx
/**
 * Fetches the current Render OpenAPI document and writes it to `spec/render-openapi.json`.
 *
 * Render does not serve its spec from a stable URL — the documented `.json`/`.yaml`
 * endpoints return 404. The spec is however embedded verbatim in the HTML of every
 * reference page, which is what this script extracts.
 *
 * That makes the extraction inherently fragile, so every failure mode here is loud.
 * The dangerous outcome is not "the fetch broke"; it is silently deciding nothing
 * changed because the page structure moved, and going blind to real API changes.
 *
 * Usage: tsx scripts/fetch-spec.ts [output-path]
 */
import { writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_OUT = resolve(ROOT, 'spec/render-openapi.json');

/**
 * Reference pages to try, in order.
 *
 * More than one because any single slug can be renamed. All of them embed the same
 * complete document, so the first that works is as good as any other.
 */
const CANDIDATE_PAGES = [
  'https://api-docs.render.com/reference/list-services',
  'https://api-docs.render.com/reference/retrieve-service',
  'https://api-docs.render.com/reference/list-postgres',
  'https://api-docs.render.com/reference/introduction',
];

/** The spec must look like Render's, not like some other JSON that happens to be on the page. */
const MIN_EXPECTED_OPERATIONS = 150;

export interface RenderSpec {
  openapi: string;
  info: { title: string; version: string };
  servers: Array<{ url: string }>;
  paths: Record<string, Record<string, unknown>>;
  components: Record<string, unknown>;
}

/**
 * Extracts the first complete JSON object starting at `start` by tracking brace depth.
 *
 * `JSON.parse` needs exact bounds and the spec is embedded in a much larger document, so
 * the closing brace has to be located by scanning. String and escape state are tracked so
 * that braces inside string literals — common in descriptions and examples — do not
 * throw the depth count off.
 */
export function extractJsonObject(source: string, start: number): string {
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = start; index < source.length; index += 1) {
    const char = source[index]!;

    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === '\\' && inString) {
      escaped = true;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;

    if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }

  throw new Error('Unterminated JSON object: reached end of input while still nested.');
}

/** Pulls the embedded OpenAPI document out of a reference page's HTML. */
export function extractSpecFromHtml(html: string): RenderSpec {
  const marker = /\{"openapi":"3\.\d/.exec(html);
  if (marker === null) {
    throw new Error(
      'No embedded OpenAPI document found in the page. Render likely changed their docs ' +
        'platform or its rendering. Re-derive the extraction against a fresh page before trusting this script again.',
    );
  }

  const parsed = JSON.parse(extractJsonObject(html, marker.index)) as RenderSpec;
  assertLooksLikeRenderSpec(parsed);
  return parsed;
}

/**
 * Rejects anything that parses but is not the document we expect.
 *
 * Without this a truncated or unrelated object could be written over a good spec, and the
 * generator would faithfully produce a catalogue missing most of the API.
 */
export function assertLooksLikeRenderSpec(spec: unknown): asserts spec is RenderSpec {
  // Explicitly typed as returning `never` on the binding, not just the arrow, so that
  // TypeScript's control-flow analysis treats each call as terminating and narrows after it.
  const fail: (reason: string) => never = (reason) => {
    throw new Error(`Extracted document does not look like the Render API spec: ${reason}`);
  };

  if (spec === null || typeof spec !== 'object') fail('not an object');
  const candidate = spec as Partial<RenderSpec>;

  if (typeof candidate.openapi !== 'string' || !candidate.openapi.startsWith('3.')) {
    fail(`unexpected openapi version ${String(candidate.openapi)}`);
  }
  if (candidate.info?.title !== 'Render Public API') {
    fail(`unexpected title ${JSON.stringify(candidate.info?.title)}`);
  }
  if (candidate.servers?.[0]?.url !== 'https://api.render.com/v1') {
    fail(`unexpected server ${JSON.stringify(candidate.servers?.[0]?.url)}`);
  }
  if (candidate.paths === undefined || typeof candidate.paths !== 'object') fail('no paths');
  if (candidate.components === undefined) fail('no components');

  const operations = countOperations(candidate.paths);
  if (operations < MIN_EXPECTED_OPERATIONS) {
    fail(`only ${operations} operations, expected at least ${MIN_EXPECTED_OPERATIONS} — the document looks truncated`);
  }
}

export function countOperations(paths: Record<string, Record<string, unknown>>): number {
  const methods = new Set(['get', 'post', 'put', 'patch', 'delete']);
  let total = 0;
  for (const item of Object.values(paths)) {
    for (const key of Object.keys(item)) {
      if (methods.has(key)) total += 1;
    }
  }
  return total;
}

async function fetchSpec(): Promise<{ spec: RenderSpec; source: string }> {
  const failures: string[] = [];

  for (const url of CANDIDATE_PAGES) {
    try {
      const response = await fetch(url, {
        headers: { 'User-Agent': 'render-useful-mcp spec sync (+https://github.com/LuSrodri/render-useful-mcp)' },
        signal: AbortSignal.timeout(60_000),
      });
      if (!response.ok) {
        failures.push(`${url} -> HTTP ${response.status}`);
        continue;
      }
      return { spec: extractSpecFromHtml(await response.text()), source: url };
    } catch (error) {
      failures.push(`${url} -> ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  throw new Error(
    `Could not obtain the Render spec from any known page.\n${failures.map((f) => `  - ${f}`).join('\n')}`,
  );
}

// Only run when executed directly, so the helpers stay importable from tests.
if (process.argv[1] !== undefined && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const outPath = process.argv[2] !== undefined ? resolve(process.argv[2]) : DEFAULT_OUT;

  const { spec, source } = await fetchSpec();

  // Two-space JSON keeps the committed spec diffable; a single-line 500 KB file would
  // make every upstream change an unreviewable blob.
  writeFileSync(outPath, `${JSON.stringify(spec, null, 2)}\n`, 'utf8');

  console.log(`Fetched ${spec.info.title} v${spec.info.version} from ${source}`);
  console.log(`  ${Object.keys(spec.paths).length} paths, ${countOperations(spec.paths)} operations`);
  console.log(`  wrote ${outPath}`);
}
