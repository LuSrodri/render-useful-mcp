#!/usr/bin/env tsx
/**
 * Summarises what changed between two generated catalogues, as Markdown.
 *
 * The raw diff of `operations.json` runs to tens of thousands of lines and tells a
 * reviewer nothing. What actually matters when Render ships an API change is which tools
 * appeared, which disappeared, and which changed shape — so that is what this prints,
 * straight into the body of the sync pull request.
 *
 * Usage: tsx scripts/diff-catalogue.ts <before.json> <after.json>
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import type { OperationCatalogue, OperationDefinition } from '../src/generated/types.js';

export interface CatalogueDiff {
  readonly added: readonly OperationDefinition[];
  readonly removed: readonly OperationDefinition[];
  readonly changed: ReadonlyArray<{
    readonly operation: OperationDefinition;
    readonly reasons: readonly string[];
  }>;
  readonly specVersionChanged: { readonly before: string; readonly after: string } | undefined;
}

export function diffCatalogues(before: OperationCatalogue, after: OperationCatalogue): CatalogueDiff {
  const beforeByName = new Map(before.operations.map((operation) => [operation.name, operation]));
  const afterByName = new Map(after.operations.map((operation) => [operation.name, operation]));

  const added = after.operations.filter((operation) => !beforeByName.has(operation.name));
  const removed = before.operations.filter((operation) => !afterByName.has(operation.name));

  const changed: Array<{ operation: OperationDefinition; reasons: string[] }> = [];
  for (const operation of after.operations) {
    const previous = beforeByName.get(operation.name);
    if (previous === undefined) continue;
    const reasons = describeChanges(previous, operation);
    if (reasons.length > 0) changed.push({ operation, reasons });
  }

  return {
    added,
    removed,
    changed,
    specVersionChanged:
      before.specVersion === after.specVersion ? undefined : { before: before.specVersion, after: after.specVersion },
  };
}

function describeChanges(before: OperationDefinition, after: OperationDefinition): string[] {
  const reasons: string[] = [];

  if (before.method !== after.method || before.path !== after.path) {
    reasons.push(`endpoint moved: \`${before.method} ${before.path}\` → \`${after.method} ${after.path}\``);
  }
  if (before.deprecated !== after.deprecated) {
    reasons.push(after.deprecated ? 'marked deprecated by Render' : 'no longer deprecated');
  }
  if (before.toolset !== after.toolset) {
    reasons.push(`moved from toolset \`${before.toolset}\` to \`${after.toolset}\``);
  }

  const paramsBefore = new Set([...before.pathParams, ...before.queryParams, ...before.bodyProps]);
  const paramsAfter = new Set([...after.pathParams, ...after.queryParams, ...after.bodyProps]);
  const gained = [...paramsAfter].filter((name) => !paramsBefore.has(name));
  const lost = [...paramsBefore].filter((name) => !paramsAfter.has(name));
  if (gained.length > 0) reasons.push(`new arguments: ${gained.map((n) => `\`${n}\``).join(', ')}`);
  if (lost.length > 0) reasons.push(`removed arguments: ${lost.map((n) => `\`${n}\``).join(', ')}`);

  const requiredBefore = new Set((before.inputSchema['required'] ?? []) as string[]);
  const requiredAfter = new Set((after.inputSchema['required'] ?? []) as string[]);
  const nowRequired = [...requiredAfter].filter((name) => !requiredBefore.has(name));
  if (nowRequired.length > 0) {
    reasons.push(`newly required: ${nowRequired.map((n) => `\`${n}\``).join(', ')}`);
  }

  // Catch-all for constraint changes (enums, patterns, nested shapes) the checks above miss.
  if (reasons.length === 0 && JSON.stringify(before.inputSchema) !== JSON.stringify(after.inputSchema)) {
    reasons.push('input schema changed (enum values, constraints or nested shape)');
  }

  return reasons;
}

export function renderMarkdown(diff: CatalogueDiff, after: OperationCatalogue): string {
  const lines: string[] = [];

  if (diff.specVersionChanged) {
    lines.push(`Spec version: \`${diff.specVersionChanged.before}\` → \`${diff.specVersionChanged.after}\``, '');
  }

  lines.push(
    `**${after.operations.length} operations** after this change ` +
      `(+${diff.added.length} / −${diff.removed.length} / ~${diff.changed.length}).`,
    '',
  );

  if (diff.added.length > 0) {
    lines.push(`### Added (${diff.added.length})`, '');
    for (const operation of diff.added) {
      lines.push(`- \`${operation.name}\` — ${operation.method} \`${operation.path}\` (${operation.toolset})`);
    }
    lines.push('');
  }

  if (diff.removed.length > 0) {
    lines.push(`### Removed (${diff.removed.length})`, '');
    lines.push('> Removing a tool is a breaking change for anyone depending on it.', '');
    for (const operation of diff.removed) {
      lines.push(`- \`${operation.name}\` — was ${operation.method} \`${operation.path}\``);
    }
    lines.push('');
  }

  if (diff.changed.length > 0) {
    lines.push(`### Changed (${diff.changed.length})`, '');
    for (const { operation, reasons } of diff.changed) {
      lines.push(`- \`${operation.name}\``);
      for (const reason of reasons) lines.push(`  - ${reason}`);
    }
    lines.push('');
  }

  if (diff.added.length === 0 && diff.removed.length === 0 && diff.changed.length === 0) {
    lines.push('No operation-level changes — the spec changed only in ways that do not affect the tool catalogue.', '');
  }

  return lines.join('\n');
}

/** True when the change warrants a human look beyond the usual review. */
export function isBreaking(diff: CatalogueDiff): boolean {
  return (
    diff.removed.length > 0 || diff.changed.some(({ reasons }) => reasons.some((r) => r.startsWith('newly required')))
  );
}

function load(path: string): OperationCatalogue {
  return JSON.parse(readFileSync(resolve(path), 'utf8')) as OperationCatalogue;
}

if (process.argv[1] !== undefined && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const [beforePath, afterPath] = process.argv.slice(2);
  if (beforePath === undefined || afterPath === undefined) {
    console.error('Usage: tsx scripts/diff-catalogue.ts <before.json> <after.json>');
    process.exit(2);
  }

  const before = load(beforePath);
  const after = load(afterPath);
  const diff = diffCatalogues(before, after);

  process.stdout.write(renderMarkdown(diff, after));
  if (isBreaking(diff)) {
    process.stdout.write(
      '\n> [!WARNING]\n> This change removes tools or makes arguments required. Review before merging.\n',
    );
  }
}
