/**
 * Invariants of `server.json`, the MCP Registry manifest.
 *
 * The registry rejects a mismatched manifest at publish time, which is the worst moment to
 * find out: npm has already been published by then and its versions are immutable, so a
 * broken manifest costs a whole version number to fix. These checks move that failure into
 * `npm test`, where it costs nothing.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

function readJson(relativePath: string): Record<string, unknown> {
  const path = fileURLToPath(new URL(`../${relativePath}`, import.meta.url));
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
}

const manifest = readJson('server.json');
const pkg = readJson('package.json');

const packages = manifest['packages'] as Array<Record<string, unknown>>;
const npmPackage = packages[0] as Record<string, unknown>;

describe('server.json', () => {
  it('claims the namespace that GitHub OIDC actually grants', () => {
    // The registry compares the server name against `io.github.<repository_owner>/*` with a
    // case-sensitive prefix match, and GitHub's OIDC claim carries the owner's login exactly
    // as GitHub cases it. `io.github.lusrodri/...` would be rejected with a 403.
    expect(manifest['name']).toBe('io.github.LuSrodri/render-useful-mcp');
  });

  it('matches the ownership marker published inside the npm package', () => {
    // This pair is how the registry proves the publisher owns the npm package: it fetches
    // the tarball's package.json and requires `mcpName` to equal the server name.
    expect(pkg['mcpName']).toBe(manifest['name']);
  });

  it('fits the registry description limit', () => {
    // Not a style preference: the schema caps it at 100 and rejects anything longer. The
    // npm description is far longer, so the two deliberately differ.
    const description = manifest['description'];
    expect(description).toBeTypeOf('string');
    expect((description as string).length).toBeGreaterThan(0);
    expect((description as string).length).toBeLessThanOrEqual(100);
  });

  it('points at the package this repository actually publishes', () => {
    expect(npmPackage['registryType']).toBe('npm');
    expect(npmPackage['identifier']).toBe(pkg['name']);
    expect((npmPackage['transport'] as Record<string, unknown>)['type']).toBe('stdio');
  });

  it('declares the version being released, in both places the registry reads', () => {
    // The release workflow rewrites both fields from the tag before publishing, so a stale
    // value here never reaches the registry — but keeping them in step means `mcp-publisher
    // publish` also works when run by hand from a clean checkout.
    expect(manifest['version']).toBe(pkg['version']);
    expect(npmPackage['version']).toBe(pkg['version']);
  });

  it('requires the API key and marks it secret', () => {
    const env = npmPackage['environmentVariables'] as Array<Record<string, unknown>>;
    const apiKey = env.find((entry) => entry['name'] === 'RENDER_API_KEY');
    expect(apiKey).toBeDefined();
    expect(apiKey?.['isRequired']).toBe(true);
    expect(apiKey?.['isSecret']).toBe(true);
  });

  it('only advertises environment variables the server reads', () => {
    const env = npmPackage['environmentVariables'] as Array<Record<string, unknown>>;
    const documented = readFileSync(fileURLToPath(new URL('../.env.example', import.meta.url)), 'utf8');
    for (const entry of env) {
      expect(documented, `${String(entry['name'])} is not in .env.example`).toContain(`${String(entry['name'])}=`);
    }
  });
});

/**
 * Invariants of the Claude Code plugin, which is the third place this repository is
 * published from. It is submitted once and then tracked by commit SHA, so a manifest that
 * drifts out of step with the package is not caught by anything downstream.
 */
describe('plugin manifest', () => {
  const plugin = readJson('plugin/.claude-plugin/plugin.json');
  const mcpConfig = readJson('plugin/.mcp.json');
  const servers = mcpConfig['mcpServers'] as Record<string, Record<string, unknown>>;
  const server = servers['render'] as Record<string, unknown>;

  it('is versioned in step with the package', () => {
    // `scripts/sync-server-version.ts` rewrites this on `npm version`; the check is here so
    // a hand-edited manifest cannot drift silently.
    expect(plugin['version']).toBe(pkg['version']);
  });

  it('launches the package this repository publishes', () => {
    expect(server['command']).toBe('npx');
    expect(server['args']).toEqual(['-y', pkg['name']]);
  });

  it('passes the API key through without baking one in', () => {
    const env = server['env'] as Record<string, string>;
    // The `:-` fallback matters: without it an unset variable reaches the server as the
    // literal "${RENDER_API_KEY}", which is non-empty and would fail as a 401 instead of a
    // configuration error. `src/config.ts` rejects both spellings, but the fallback means
    // the common case produces the better message.
    expect(env['RENDER_API_KEY']).toBe('${RENDER_API_KEY:-}');
    expect(JSON.stringify(mcpConfig)).not.toMatch(/rnd_[A-Za-z0-9]/);
  });

  it('is listed by the marketplace at the path it actually occupies', () => {
    const marketplace = readJson('.claude-plugin/marketplace.json');
    const entries = marketplace['plugins'] as Array<Record<string, unknown>>;
    const entry = entries.find((candidate) => candidate['name'] === plugin['name']);

    expect(entry, `marketplace.json has no entry named "${String(plugin['name'])}"`).toBeDefined();
    expect(entry?.['source']).toBe('./plugin');
  });
});

/**
 * The same settings are described in four places: `server.json` (which the MCP Registry
 * renders in client UIs), the README table, `.env.example` and the code. They drift, and
 * `server.json` drifts most quietly — nothing renders it during development, so a stale
 * description ships to every client that browses the registry.
 *
 * No test can prove four prose descriptions still mean the same thing. These check the two
 * things that *are* mechanical: that the surfaces describe the same set of variables, and
 * that a claim already known to be false cannot come back.
 */
describe('environment variable documentation', () => {
  const readFile = (relativePath: string): string =>
    readFileSync(fileURLToPath(new URL(`../${relativePath}`, import.meta.url)), 'utf8');

  const readme = readFile('README.md');
  const envExample = readFile('.env.example');
  const manifestEnv = (npmPackage['environmentVariables'] as Array<Record<string, unknown>>).map((entry) =>
    String(entry['name']),
  );

  const namesIn = (source: string, pattern: RegExp): string[] => [
    ...new Set([...source.matchAll(pattern)].map((match) => match[1] as string)),
  ];

  const readmeNames = namesIn(readme, /^\|\s*`(RENDER_[A-Z_]+)`\s*\|/gm);
  const envExampleNames = namesIn(envExample, /^#?\s*(RENDER_[A-Z_]+)=/gm);

  it('documents the same variables in the README table and .env.example', () => {
    expect([...readmeNames].sort()).toEqual([...envExampleNames].sort());
  });

  it('advertises a subset of the documented variables in the registry manifest', () => {
    // server.json deliberately lists only the settings worth surfacing in a client's setup
    // UI, so it is a subset rather than an equal set — but never a superset.
    for (const name of manifestEnv) {
      expect(readmeNames, `${name} is advertised to the registry but missing from the README`).toContain(name);
    }
  });

  it('never claims a toolset can be enabled at runtime', () => {
    // The exact regression this guards: `render_toolsets` stopped mutating the visible set
    // when the server moved to protocol revision 2026-07-28, which forbids `tools/list`
    // varying as a side effect of another call. The README was updated; server.json and
    // .env.example were not, and the stale text shipped to the registry in 1.1.0.
    const stale = /enabl\w*\s+(a\s+)?toolsets?\s+(at\s+runtime|mid-session)|toolsets?\s+mid-session/i;

    for (const [label, source] of [
      ['server.json', JSON.stringify(manifest)],
      ['README.md', readme],
      ['.env.example', envExample],
    ] as const) {
      expect(stale.test(source), `${label} still describes runtime toolset enabling`).toBe(false);
    }
  });
});
