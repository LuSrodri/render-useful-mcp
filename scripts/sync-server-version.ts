#!/usr/bin/env tsx
/**
 * Copies the version from `package.json` into `server.json`.
 *
 * The MCP Registry manifest repeats the released version in two places, and
 * `test/server-json.test.ts` requires both to equal `package.json`. `npm version` only
 * knows about `package.json`, so without this the bump commit would leave the tree failing
 * its own test suite — discovered at release time, which is the worst moment for it.
 *
 * Wired to the `version` npm lifecycle script, which runs after the bump and before the
 * commit, so the rewritten manifest lands in the version commit itself.
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

const manifest = load('server.json');
manifest.version = version;
for (const pkg of manifest.packages ?? []) {
  pkg.version = version;
}

writeFileSync(resolve(ROOT, 'server.json'), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`server.json set to ${version}`);
