#!/usr/bin/env tsx
/**
 * Copies the version from `package.json` into every manifest that repeats it:
 * `server.json` (twice) and the Claude Code plugin manifest.
 *
 * Each of those is read by something outside this repository — the MCP Registry and the
 * plugin marketplace — and `npm version` only knows about `package.json`. Without this the
 * bump commit would leave the tree failing its own test suite, discovered at release time,
 * which is the worst moment for it.
 *
 * Wired to the `version` npm lifecycle script, which runs after the bump and before the
 * commit, so the rewritten manifests land in the version commit itself.
 *
 * Usage: tsx scripts/sync-server-version.ts
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

interface Versioned {
  version?: string;
  packages?: { version?: string }[];
}

function load(path: string): Versioned {
  return JSON.parse(readFileSync(resolve(ROOT, path), 'utf8')) as Versioned;
}

const { version } = load('package.json');
if (version === undefined) {
  throw new Error('package.json has no version to copy.');
}

function save(path: string, value: unknown): void {
  writeFileSync(resolve(ROOT, path), `${JSON.stringify(value, null, 2)}\n`);
  console.log(`${path} set to ${version}`);
}

const manifest = load('server.json');
manifest.version = version;
for (const pkg of manifest.packages ?? []) {
  pkg.version = version;
}
save('server.json', manifest);

const plugin = load('plugin/.claude-plugin/plugin.json');
plugin.version = version;
save('plugin/.claude-plugin/plugin.json', plugin);
