/**
 * Properties Render's spec puts in a request body that no caller can fill.
 *
 * The spec reuses response schemas inside request bodies in a few places, which drags along
 * fields the server generates. `cronJobDetailsPOST` is the one that bites: its Docker branch
 * references `dockerDetails` — the response shape — rather than the `dockerDetailsPOST` the
 * other four service types use. So where a web service names a registry by
 * `registryCredentialId`, a cron job is asked for a whole `registryCredential` object
 * requiring `id`, `name`, `username`, `registry` and `updatedAt`: a record identifier and
 * the timestamp of its last change, neither of which is a thing a caller creating a service
 * knows or should invent.
 *
 * Leaving it in place offers a model a field it can only fill with fabricated values. It is
 * removed instead, and the usage note points at `image.registryCredentialId` on the request
 * itself, which is where Render actually takes a private-registry reference.
 *
 * Removal is by schema title, not by path, so it applies wherever the spec reuses the shape
 * — `POST /services` and `PATCH /services/{id}` both carry this one. The generator throws if
 * an entry matches nothing, so a fix on Render's side surfaces as a build failure rather
 * than a silent no-op.
 *
 * See `schema-unions.ts` for the other deliberate deviation from the spec.
 */
import type { JsonSchema } from '../generated/types.js';

/** Keyed by the schema's name in Render's spec, carried across as `title` when inlined. */
export const UNUSABLE_PROPERTIES: Readonly<Record<string, readonly string[]>> = {
  dockerDetails: ['registryCredential'],
};

type Schema = Record<string, unknown>;

function isSchema(value: unknown): value is Schema {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Strips the unusable properties from `schema`, in place, and reports what it removed.
 *
 * Must run before the unions are discriminated: afterwards the branches have moved into
 * `if`/`then` rules and are no longer reachable by title from the property they described.
 */
export function removeUnusableProperties(schema: JsonSchema, operationId: string): string[] {
  const removed: string[] = [];

  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (!isSchema(node)) return;

    const title = typeof node['title'] === 'string' ? node['title'] : undefined;
    const unusable = title === undefined ? undefined : UNUSABLE_PROPERTIES[title];
    const properties = node['properties'];
    if (unusable !== undefined && isSchema(properties)) {
      for (const name of unusable) {
        if (properties[name] === undefined) continue;
        delete properties[name];
        const required = node['required'];
        if (Array.isArray(required)) node['required'] = required.filter((entry) => entry !== name);
        removed.push(`${operationId}: ${title}.${name}`);
      }
    }

    for (const value of Object.values(node)) walk(value);
  };

  walk(schema);
  return removed;
}
