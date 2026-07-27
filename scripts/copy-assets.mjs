#!/usr/bin/env node
/**
 * `tsc` only emits `.js`/`.d.ts`. The generated operation catalogue is plain data,
 * so it has to be copied into `dist/` by hand for the published package to work.
 */
import { copyFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const assets = [['src/generated/operations.json', 'dist/generated/operations.json']];

for (const [from, to] of assets) {
  const target = resolve(root, to);
  await mkdir(dirname(target), { recursive: true });
  await copyFile(resolve(root, from), target);
  console.log(`copied ${from} -> ${to}`);
}
