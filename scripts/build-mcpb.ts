#!/usr/bin/env tsx
/**
 * Packs the built server into a `.mcpb` bundle — the format Claude for macOS and Windows
 * installs, and the artefact the MCPB directory submission form asks for.
 *
 * An MCPB is self-contained: the host runs `node server/index.js` inside the unpacked
 * directory with no install step, so every runtime dependency has to travel with it. That
 * makes the staging layout the whole job:
 *
 *   build/mcpb/
 *     manifest.json      <- the repository's, verbatim
 *     package.json       <- minimal, and the file `dist/index.js` reads its version from
 *     server/            <- dist/
 *     node_modules/      <- production dependencies only
 *     README.md, LICENSE, PRIVACY.md
 *
 * The dependency tree is copied out of this repository's own `node_modules` rather than
 * re-resolved with `npm install`. A fresh install would silently ship versions no test here
 * ever ran against; copying guarantees the bundle contains exactly the tree `npm test`
 * passed on.
 *
 * Nothing here shells out to `npm`. Since Node 20.12 `execFile` refuses to spawn a `.cmd`
 * without a shell, so `npm ls` and `npm exec` both fail outright on Windows — and routing
 * them through a shell to work around it would put paths through cmd.exe quoting. Walking
 * `node_modules` directly and invoking the packer with `process.execPath` avoids both.
 *
 * Usage: tsx scripts/build-mcpb.ts   (run `npm run build` first)
 */
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const STAGE = join(ROOT, 'build', 'mcpb');

/**
 * The union of every JSON manifest this script reads: this package's, the MCPB one, and the
 * `package.json` of each dependency it walks.
 */
interface Manifest {
  name?: string;
  version?: string;
  description?: string;
  license?: string;
  dependencies?: Record<string, string>;
  bin?: string | Record<string, string>;
}

function readJson(path: string): Manifest {
  return JSON.parse(readFileSync(path, 'utf8')) as Manifest;
}

/**
 * Resolves the production dependency closure to paths relative to the repository root.
 *
 * npm's layout is mostly flat but not guaranteed to be: a package whose version conflicts
 * with a hoisted one gets its own nested `node_modules`. So resolution walks up from the
 * dependent, exactly as node does at runtime, rather than assuming `<root>/node_modules`.
 */
function productionDependencyPaths(): string[] {
  const found = new Set<string>();
  const queue: { dir: string; manifest: Manifest }[] = [{ dir: ROOT, manifest: readJson(join(ROOT, 'package.json')) }];

  for (let entry = queue.shift(); entry !== undefined; entry = queue.shift()) {
    // `optionalDependencies` appear under `dependencies` once installed, so this covers them
    // without risking a missing-directory throw on ones that were skipped.
    for (const name of Object.keys(entry.manifest.dependencies ?? {})) {
      let resolved: string | undefined;

      for (let from = entry.dir; from.startsWith(ROOT); from = dirname(from)) {
        const candidate = join(from, 'node_modules', name);
        if (existsSync(candidate)) {
          resolved = candidate;
          break;
        }
        if (dirname(from) === from) break;
      }

      if (resolved === undefined) {
        throw new Error(`Production dependency "${name}" is not installed. Run \`npm install\`.`);
      }

      const key = relative(ROOT, resolved);
      if (found.has(key)) continue;
      found.add(key);
      queue.push({ dir: resolved, manifest: readJson(join(resolved, 'package.json')) });
    }
  }

  return [...found];
}

/**
 * Absolute path to the locally installed `mcpb` CLI entry point.
 *
 * Read off disk rather than via `require.resolve`, because the package's `exports` map does
 * not expose `./package.json` and resolving it therefore throws.
 */
function packerEntryPoint(): string {
  const packageDir = join(ROOT, 'node_modules', '@anthropic-ai', 'mcpb');
  if (!existsSync(packageDir)) {
    throw new Error('@anthropic-ai/mcpb is not installed. Run `npm install`.');
  }

  const { bin } = readJson(join(packageDir, 'package.json'));
  const entry = typeof bin === 'string' ? bin : bin?.['mcpb'];
  if (entry === undefined) {
    throw new Error('@anthropic-ai/mcpb declares no "mcpb" binary.');
  }

  return join(packageDir, entry);
}

const pkg = readJson(join(ROOT, 'package.json'));
const manifest = readJson(join(ROOT, 'manifest.json'));

if (manifest.version !== pkg.version) {
  throw new Error(
    `manifest.json is at ${manifest.version} but package.json is at ${pkg.version}. ` +
      'Run `tsx scripts/sync-server-version.ts`.',
  );
}
if (!existsSync(join(ROOT, 'dist', 'index.js'))) {
  throw new Error('dist/ is missing or incomplete. Run `npm run build` first.');
}

rmSync(STAGE, { recursive: true, force: true });
mkdirSync(STAGE, { recursive: true });

cpSync(join(ROOT, 'dist'), join(STAGE, 'server'), { recursive: true });
writeFileSync(join(STAGE, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

// `dist/index.js` resolves `../package.json` for the version it reports to the client, so the
// bundle needs one at its root. `type: module` is what makes node read the .js files as ESM;
// without it every import in the bundle fails at startup.
writeFileSync(
  join(STAGE, 'package.json'),
  `${JSON.stringify(
    {
      name: pkg.name,
      version: pkg.version,
      description: pkg.description,
      license: pkg.license,
      type: 'module',
      main: 'server/index.js',
      private: true,
    },
    null,
    2,
  )}\n`,
);

const dependencies = productionDependencyPaths();
for (const dependency of dependencies) {
  cpSync(join(ROOT, dependency), join(STAGE, dependency), { recursive: true });
}
console.log(`staged ${dependencies.length} production dependencies`);

for (const file of ['README.md', 'LICENSE', 'PRIVACY.md']) {
  cpSync(join(ROOT, file), join(STAGE, file));
}

const output = join(ROOT, 'build', `${pkg.name}-${pkg.version}.mcpb`);
execFileSync(process.execPath, [packerEntryPoint(), 'pack', STAGE, output], {
  cwd: ROOT,
  stdio: 'inherit',
});
