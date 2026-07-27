/**
 * Loads the generated operation catalogue.
 *
 * The catalogue is data, not code, so it lives in `operations.json` and is read at
 * startup. Keeping ~200 KB of JSON Schema out of the TypeScript program keeps
 * type-checking and editor tooling fast, and makes regenerating it a reviewable diff.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import type { OperationCatalogue, OperationDefinition } from './types.js';

let cached: OperationCatalogue | undefined;

export function loadCatalogue(): OperationCatalogue {
  if (cached === undefined) {
    const path = fileURLToPath(new URL('./operations.json', import.meta.url));
    const catalogue = JSON.parse(readFileSync(path, 'utf8')) as OperationCatalogue;

    if (!Array.isArray(catalogue.operations) || catalogue.operations.length === 0) {
      throw new Error(`Operation catalogue at ${path} is empty or malformed. Run "npm run generate".`);
    }
    cached = catalogue;
  }
  return cached;
}

export function loadOperations(): readonly OperationDefinition[] {
  return loadCatalogue().operations;
}

export type { OperationCatalogue, OperationDefinition } from './types.js';
