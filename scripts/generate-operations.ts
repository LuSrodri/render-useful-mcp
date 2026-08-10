#!/usr/bin/env tsx
/**
 * Generates `src/generated/operations.json` from the vendored Render OpenAPI document.
 *
 * Every operation in the spec becomes exactly one MCP tool. Running this script is the
 * only supported way to change the tool catalogue: when Render ships new endpoints, drop
 * the new spec into `spec/render-openapi.json`, re-run `npm run generate`, and review the
 * diff. Nothing about the catalogue is maintained by hand.
 *
 * The script is deliberately strict — it throws on anything it does not understand rather
 * than silently emitting a subtly wrong tool.
 */
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { TOOLSET_BY_TAG, type ToolsetId } from '../src/tools/toolsets.js';
import { TOOL_NAME_OVERRIDES } from '../src/tools/name-overrides.js';
import { OPERATION_HINTS } from '../src/tools/operation-hints.js';
import { auditUnions, discriminateUnions } from '../src/tools/schema-unions.js';
import { removeUnusableProperties, UNUSABLE_PROPERTIES } from '../src/tools/schema-repairs.js';
import type {
  BodyMode,
  JsonSchema,
  ObjectJsonSchema,
  OperationCatalogue,
  OperationDefinition,
} from '../src/generated/types.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SPEC_PATH = resolve(ROOT, 'spec/render-openapi.json');
const OUT_PATH = resolve(ROOT, 'src/generated/operations.json');

const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete'] as const;
type HttpMethod = (typeof HTTP_METHODS)[number];

/**
 * Operations that discard state the caller did not mention, and that no rule below catches.
 *
 * `destructiveHint: false` is what a client reads to decide it need not confirm, so the cost
 * of a wrong `false` is a destructive call made silently. `scale-service` sets a fixed
 * instance count *and* turns off autoscaling — a configuration the caller never referred to,
 * gone in one call — which is the same hazard as a collection replacement without the shape
 * that identifies one.
 */
const DESTRUCTIVE_OPERATIONS = new Set(['scale-service']);

/** Verbs whose side effects a caller cannot undo by repeating the call with different input. */
const DESTRUCTIVE_HINTS = [
  'delete',
  'remove',
  'cancel',
  'suspend',
  'restart',
  'failover',
  'rollback',
  'purge',
  'disconnect',
  'unlink',
  'restore',
  'recover',
];

interface OpenApiDocument {
  openapi: string;
  info: { title: string; version: string };
  servers: Array<{ url: string }>;
  paths: Record<string, PathItem>;
  components: Record<string, unknown>;
}

interface PathItem {
  parameters?: unknown[];
  [method: string]: unknown;
}

interface OpenApiOperation {
  operationId: string;
  summary?: string;
  description?: string;
  tags?: string[];
  deprecated?: boolean;
  parameters?: unknown[];
  requestBody?: {
    required?: boolean;
    content?: Record<string, { schema?: JsonSchema }>;
  };
  responses?: Record<string, unknown>;
}

interface OpenApiParameter {
  name: string;
  in: 'path' | 'query' | 'header' | 'cookie';
  description?: string;
  required?: boolean;
  schema?: JsonSchema;
  deprecated?: boolean;
}

const spec = JSON.parse(readFileSync(SPEC_PATH, 'utf8')) as OpenApiDocument;

// ---------------------------------------------------------------------------
// $ref resolution
// ---------------------------------------------------------------------------

/**
 * Resolves a local JSON Pointer against the spec.
 *
 * Render's spec does not restrict itself to `#/components/*` — it also points straight
 * into `#/paths/...` fragments, so a generic pointer walker is required rather than a
 * lookup table of component names.
 */
function resolvePointer(ref: string): unknown {
  if (!ref.startsWith('#/')) {
    throw new Error(`Only local JSON pointers are supported, got: ${ref}`);
  }
  let current: unknown = spec;
  for (const rawToken of ref.slice(2).split('/')) {
    const token = decodeURIComponent(rawToken).replace(/~1/g, '/').replace(/~0/g, '~');
    if (Array.isArray(current)) {
      current = current[Number(token)];
    } else if (current !== null && typeof current === 'object') {
      current = (current as Record<string, unknown>)[token];
    } else {
      current = undefined;
    }
    if (current === undefined) {
      throw new Error(`Unresolvable JSON pointer: ${ref} (stopped at "${token}")`);
    }
  }
  return current;
}

/**
 * Recursively inlines every `$ref` so each tool ends up with a self-contained schema.
 *
 * MCP ships one `inputSchema` per tool with no shared definition pool, so sharing is not
 * an option. The spec was verified to be acyclic (see `test/generated.test.ts`); `seen`
 * turns a future cycle into a loud error instead of a stack overflow.
 */
function dereference(node: unknown, seen: readonly string[] = []): unknown {
  if (Array.isArray(node)) {
    return node.map((item) => dereference(item, seen));
  }
  if (node === null || typeof node !== 'object') {
    return node;
  }

  const record = node as Record<string, unknown>;
  const ref = record['$ref'];
  if (typeof ref === 'string') {
    if (seen.includes(ref)) {
      throw new Error(`Cyclic $ref detected: ${[...seen, ref].join(' -> ')}`);
    }
    const resolved = dereference(resolvePointer(ref), [...seen, ref]);
    const siblings = Object.entries(record).filter(([key]) => key !== '$ref');
    if (siblings.length === 0) {
      return resolved;
    }
    // OpenAPI 3.1 allows `$ref` alongside annotations such as `description`; the sibling
    // keys are the more specific ones, so they win.
    return { ...(resolved as Record<string, unknown>), ...(dereference(Object.fromEntries(siblings), seen) as object) };
  }

  return Object.fromEntries(
    Object.entries(record).map(([key, value]) => [
      key,
      // Branch keywords get the naming treatment below; everything else inlines plainly.
      (key === 'oneOf' || key === 'anyOf') && Array.isArray(value)
        ? value.map((member) => dereferenceBranch(member, seen))
        : dereference(value, seen),
    ]),
  );
}

/**
 * Inlines one member of a `oneOf`/`anyOf`, keeping the name of the schema it came from.
 *
 * Inlining otherwise destroys the only thing that tells the branches apart. `serviceDetails`
 * on `POST /services` is the worst case: five structurally similar objects where the caller
 * must pick the one matching `type`, with nothing left in the schema to say which is which —
 * which is precisely why models fail to create a cron job. Carrying the spec's own schema
 * name across as `title` restores that link (`cronJobDetailsPOST` ⇄ `type: "cron_job"`,
 * `dockerDetails` ⇄ `runtime: "docker"`) at the cost of one string per branch.
 *
 * Scoped to branch members on purpose: titling every inlined `$ref` would bloat all 207
 * schemas to solve ambiguity that only exists here.
 */
function dereferenceBranch(member: unknown, seen: readonly string[]): unknown {
  const resolved = dereference(member, seen);
  if (resolved === null || typeof resolved !== 'object' || Array.isArray(resolved)) return resolved;

  const record = resolved as Record<string, unknown>;
  // A title the spec set itself is more considered than one derived from a pointer.
  if (typeof record['title'] === 'string') return record;

  const name = referencedSchemaName(member);
  return name === undefined ? record : { title: name, ...record };
}

/** The trailing segment of a member's `$ref`, i.e. the schema's name in `components`. */
function referencedSchemaName(member: unknown): string | undefined {
  if (member === null || typeof member !== 'object' || Array.isArray(member)) return undefined;
  const ref = (member as Record<string, unknown>)['$ref'];
  if (typeof ref !== 'string') return undefined;
  const name = ref.split('/').pop();
  return name === undefined || name === '' ? undefined : decodeURIComponent(name);
}

// ---------------------------------------------------------------------------
// Naming
// ---------------------------------------------------------------------------

/** `list-services` and `listTaskRuns` both become `list_task_runs`-style snake_case. */
function toSnakeCase(operationId: string): string {
  return operationId
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/-/g, '_')
    .toLowerCase();
}

function toolNameFor(operationId: string): string {
  const override = TOOL_NAME_OVERRIDES[operationId];
  const base = override ?? toSnakeCase(operationId);
  if (!/^[a-z][a-z0-9_]*$/.test(base)) {
    throw new Error(
      `Operation "${operationId}" produces the invalid tool name "${base}". ` +
        `Add an entry to TOOL_NAME_OVERRIDES in src/tools/name-overrides.ts.`,
    );
  }
  return `render_${base}`;
}

// ---------------------------------------------------------------------------
// Schema assembly
// ---------------------------------------------------------------------------

function isPlainObjectSchema(schema: JsonSchema): boolean {
  return (
    schema.type === 'object' &&
    typeof schema['properties'] === 'object' &&
    schema['properties'] !== null &&
    !('oneOf' in schema) &&
    !('anyOf' in schema) &&
    !('allOf' in schema)
  );
}

/** Strips OpenAPI-only keywords that are meaningless (and occasionally confusing) to a tool caller. */
function cleanSchema(schema: JsonSchema): JsonSchema {
  const {
    xml: _xml,
    externalDocs: _externalDocs,
    discriminator: _discriminator,
    ...rest
  } = schema as Record<string, unknown>;
  return rest;
}

function describeParameter(parameter: OpenApiParameter): JsonSchema {
  const schema = cleanSchema(parameter.schema ?? { type: 'string' });
  const description = [parameter.description, parameter.deprecated ? '(deprecated)' : undefined]
    .filter(Boolean)
    .join(' ')
    .trim();
  return description ? { ...schema, description } : schema;
}

interface BuiltInput {
  schema: ObjectJsonSchema;
  pathParams: string[];
  queryParams: string[];
  bodyMode: BodyMode;
  bodyProps: string[];
  rewrittenUnions: string[];
  removedProperties: string[];
}

function buildInput(path: string, operation: OpenApiOperation, pathItem: PathItem): BuiltInput {
  const rawParameters = [...(pathItem.parameters ?? []), ...(operation.parameters ?? [])];
  const parameters = (dereference(rawParameters) as OpenApiParameter[]).filter(
    // `Accept` is negotiated by the HTTP client, never by the model.
    (parameter) => parameter.in === 'path' || parameter.in === 'query',
  );

  const properties: Record<string, JsonSchema> = {};
  const required: string[] = [];
  const pathParams: string[] = [];
  const queryParams: string[] = [];

  for (const parameter of parameters) {
    if (properties[parameter.name] !== undefined) {
      throw new Error(`Duplicate parameter "${parameter.name}" on ${operation.operationId}`);
    }
    properties[parameter.name] = describeParameter(parameter);
    if (parameter.in === 'path') {
      pathParams.push(parameter.name);
      // Path parameters are structurally required regardless of what the spec claims.
      required.push(parameter.name);
    } else {
      queryParams.push(parameter.name);
      if (parameter.required === true) required.push(parameter.name);
    }
  }

  for (const name of pathParams) {
    if (!path.includes(`{${name}}`)) {
      throw new Error(`Path parameter "${name}" is not present in the template "${path}"`);
    }
  }
  const templated = [...path.matchAll(/\{([^}]+)\}/g)].map((match) => match[1]!);
  for (const name of templated) {
    if (!pathParams.includes(name)) {
      throw new Error(`Template "${path}" references "${name}" but the spec declares no such path parameter`);
    }
  }

  let bodyMode: BodyMode = 'none';
  const bodyProps: string[] = [];
  const content = operation.requestBody?.content ?? {};
  const jsonSchema = content['application/json']?.schema;
  const multipartSchema = content['multipart/form-data']?.schema;
  const rawBody = jsonSchema ?? multipartSchema;

  if (rawBody) {
    const body = cleanSchema(dereference(rawBody) as JsonSchema);
    const bodyRequired = operation.requestBody?.required === true;

    if (multipartSchema && !jsonSchema) {
      // A single endpoint (`validate-blueprint`) uploads a file. Tools exchange text, so the
      // model supplies the file contents and the client assembles the multipart body.
      bodyMode = 'multipart';
      const props = (body['properties'] ?? {}) as Record<string, JsonSchema>;
      for (const [name, schema] of Object.entries(props)) {
        properties[name] =
          schema['format'] === 'binary'
            ? { type: 'string', description: `${schema.description ?? ''} Provide the file contents as text.`.trim() }
            : schema;
        bodyProps.push(name);
      }
      required.push(...((body['required'] ?? []) as string[]));
    } else if (isPlainObjectSchema(body)) {
      // Flattening keeps call sites shallow, which measurably improves tool-call accuracy.
      // Safe only because the generator asserts params and body properties never collide.
      bodyMode = 'flattened';
      const props = (body['properties'] ?? {}) as Record<string, JsonSchema>;
      for (const [name, schema] of Object.entries(props)) {
        if (properties[name] !== undefined) {
          throw new Error(
            `Body property "${name}" of ${operation.operationId} collides with a path/query parameter; ` +
              `this operation needs bodyMode "wrapped".`,
          );
        }
        properties[name] = cleanSchema(schema);
        bodyProps.push(name);
      }
      if (bodyRequired) required.push(...((body['required'] ?? []) as string[]));
    } else {
      // Arrays and `oneOf` bodies have no properties to flatten, so they stay intact
      // under a single `body` key.
      bodyMode = 'wrapped';
      properties['body'] = { ...body, description: body.description ?? 'Request body.' };
      if (bodyRequired) required.push('body');
    }
  }

  const schema: ObjectJsonSchema = {
    type: 'object',
    properties,
    ...(required.length > 0 ? { required: [...new Set(required)].sort() } : {}),
    additionalProperties: false,
    $schema: 'http://json-schema.org/draft-07/schema#',
  };

  // Both repairs run on the assembled schema, so they apply whether the body was flattened
  // or wrapped. Order matters: removal addresses branches by title, which discrimination
  // then moves into `if`/`then` rules where that title no longer describes a property.
  const removedProperties = removeUnusableProperties(schema, operation.operationId);
  const rewrittenUnions = discriminateUnions(schema, operation.operationId);

  return { schema, pathParams, queryParams, bodyMode, bodyProps, rewrittenUnions, removedProperties };
}

// ---------------------------------------------------------------------------
// Catalogue
// ---------------------------------------------------------------------------

function toolsetFor(tag: string, operationId: string): ToolsetId {
  const toolset = TOOLSET_BY_TAG[tag];
  if (!toolset) {
    throw new Error(`Tag "${tag}" (from ${operationId}) has no toolset. Add it to TOOLSET_BY_TAG.`);
  }
  return toolset;
}

function isDestructive(method: HttpMethod, operationId: string, path: string): boolean {
  if (method === 'delete') return true;
  if (method === 'get') return false;
  if (DESTRUCTIVE_OPERATIONS.has(operationId)) return true;

  // A `PUT` to a path ending in a literal segment addresses the collection or the whole
  // configuration, not one member of it, so it replaces everything there: anything the
  // caller omits is deleted. `PUT /services/{id}/env-vars` wipes every variable missing from
  // the payload, and the values of the ones it removes are not recoverable from the API
  // afterwards. A `PUT` ending in a parameter — `/env-vars/{envVarKey}` — is an upsert of a
  // single member and carries no such risk.
  if (method === 'put' && !path.endsWith('}')) return true;

  const haystack = `${operationId} ${path}`.toLowerCase();
  return DESTRUCTIVE_HINTS.some((hint) => haystack.includes(hint));
}

function buildDescription(operation: OpenApiOperation, method: HttpMethod, path: string, streaming: boolean): string {
  const parts: string[] = [];
  if (operation.summary) parts.push(operation.summary.trim().replace(/\.$/, '') + '.');
  if (operation.description) parts.push(operation.description.trim());
  if (operation.deprecated) parts.unshift('[DEPRECATED by Render]');
  if (streaming) {
    parts.push('This endpoint streams server-sent events; the tool returns the events received before its timeout.');
  }
  parts.push(`Calls \`${method.toUpperCase()} ${path}\` on the Render Public API.`);

  // Last, and marked: the model should be able to tell Render's own words from ours.
  const hint = OPERATION_HINTS[operation.operationId];
  if (hint !== undefined) {
    parts.push(`Usage: ${hint.usage.trim()}`);
    // Rendered from the same objects the test suite validates, so a description can never
    // again show a payload the server would reject.
    for (const example of hint.examples ?? []) {
      parts.push(`Example — ${example.summary}: ${JSON.stringify(example.args)}`);
    }
  }

  return parts.join(' ').replace(/\s+/g, ' ').trim();
}

const operations: OperationDefinition[] = [];
const seenNames = new Set<string>();
const unionRewrites: string[] = [];
const propertyRemovals: string[] = [];

for (const [path, pathItem] of Object.entries(spec.paths)) {
  for (const method of HTTP_METHODS) {
    const operation = pathItem[method] as OpenApiOperation | undefined;
    if (!operation) continue;

    if (!operation.operationId) {
      throw new Error(`Missing operationId for ${method.toUpperCase()} ${path}`);
    }

    const tag = operation.tags?.[0];
    if (!tag) throw new Error(`Operation ${operation.operationId} has no tag`);

    const name = toolNameFor(operation.operationId);
    if (seenNames.has(name)) {
      throw new Error(`Duplicate tool name "${name}" produced by ${operation.operationId}`);
    }
    seenNames.add(name);

    const responses = (operation.responses ?? {}) as Record<string, { content?: Record<string, unknown> }>;
    const streaming = Object.values(responses).some(
      (response) => response.content !== undefined && 'text/event-stream' in response.content,
    );

    const { schema, pathParams, queryParams, bodyMode, bodyProps, rewrittenUnions, removedProperties } = buildInput(
      path,
      operation,
      pathItem,
    );
    for (const rewrite of rewrittenUnions) unionRewrites.push(`${name}: ${rewrite}`);
    propertyRemovals.push(...removedProperties);

    operations.push({
      name,
      operationId: operation.operationId,
      method: method.toUpperCase() as OperationDefinition['method'],
      path,
      title: operation.summary?.trim() ?? operation.operationId,
      description: buildDescription(operation, method, path, streaming),
      tag,
      toolset: toolsetFor(tag, operation.operationId),
      deprecated: operation.deprecated === true,
      readOnly: method === 'get',
      destructive: isDestructive(method, operation.operationId, path),
      idempotent: method === 'put' || method === 'delete' || method === 'get',
      streaming,
      pathParams,
      queryParams,
      bodyMode,
      bodyProps,
      inputSchema: schema,
    });
  }
}

// A hint keyed to an operation Render has renamed or withdrawn would silently stop being
// applied, and the tool it was written for would quietly get worse. Fail instead.
const seenOperationIds = new Set(operations.map((operation) => operation.operationId));
const staleHints = Object.keys(OPERATION_HINTS).filter((id) => !seenOperationIds.has(id));
if (staleHints.length > 0) {
  throw new Error(
    `OPERATION_HINTS has entries for operations that no longer exist: ${staleHints.join(', ')}. ` +
      `Update or remove them in src/tools/operation-hints.ts.`,
  );
}

// Both hand-written lists below describe things Render's spec does today. If Render fixes
// one of them, the entry stops applying and the reason for it is gone — which should be
// visible as a build failure, not as a line nobody revisits.
const unusedRemovals = Object.entries(UNUSABLE_PROPERTIES).flatMap(([title, names]) =>
  names
    .filter((name) => !propertyRemovals.some((entry) => entry.endsWith(`${title}.${name}`)))
    .map((name) => `${title}.${name}`),
);
if (unusedRemovals.length > 0) {
  throw new Error(
    `UNUSABLE_PROPERTIES lists properties that no longer appear in any request schema: ` +
      `${unusedRemovals.join(', ')}. Remove them from src/tools/schema-repairs.ts.`,
  );
}

const staleDestructive = [...DESTRUCTIVE_OPERATIONS].filter(
  (id) => !operations.some((operation) => operation.operationId === id),
);
if (staleDestructive.length > 0) {
  throw new Error(`DESTRUCTIVE_OPERATIONS names operations that no longer exist: ${staleDestructive.join(', ')}.`);
}

// A `oneOf` branch that a sibling also accepts can never be selected, so every payload a
// caller writes for it is rejected — which is how creating a cron job became impossible
// while every test passed. Catch it here, at the only point where the catalogue is built.
const unreachable = operations.flatMap((operation) => auditUnions(operation.inputSchema, operation.name));
if (unreachable.length > 0) {
  throw new Error(
    `The catalogue contains \`oneOf\` branches no caller can select:\n  ${unreachable.join('\n  ')}\n` +
      `Discriminate them in src/tools/schema-unions.ts.`,
  );
}

operations.sort((a, b) => a.name.localeCompare(b.name));

const catalogue: OperationCatalogue = {
  $comment: 'GENERATED FILE — do not edit. Run `npm run generate` to rebuild from spec/render-openapi.json.',
  specTitle: spec.info.title,
  specVersion: spec.info.version,
  baseUrl: spec.servers[0]?.url ?? 'https://api.render.com/v1',
  operations,
};

mkdirSync(dirname(OUT_PATH), { recursive: true });
writeFileSync(OUT_PATH, `${JSON.stringify(catalogue, null, 2)}\n`, 'utf8');

const byToolset = new Map<ToolsetId, number>();
for (const operation of operations) {
  byToolset.set(operation.toolset, (byToolset.get(operation.toolset) ?? 0) + 1);
}

console.log(`Generated ${operations.length} operations from ${spec.info.title} v${spec.info.version}`);
for (const rewrite of unionRewrites) console.log(`  discriminated ${rewrite}`);
for (const removal of propertyRemovals) console.log(`  removed unfillable ${removal}`);
for (const [toolset, count] of [...byToolset].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${toolset.padEnd(16)} ${count}`);
}
