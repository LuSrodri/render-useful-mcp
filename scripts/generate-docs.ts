#!/usr/bin/env tsx
/**
 * Renders every part of the documentation that describes the tool catalogue.
 *
 * The catalogue moves whenever Render ships an endpoint, and until now the prose did not
 * move with it: tool counts, the toolset table and the workflow-tool list were all typed by
 * hand in three places. A spec-sync pull request would update `operations.json` and leave
 * the README claiming a number that was no longer true — the kind of rot nobody notices
 * because nothing fails.
 *
 * So the numbers live in exactly one place, `operations.json`, and everything downstream is
 * rendered from it: marker-delimited regions inside hand-written documents, and whole files
 * for the docs site, `llms.txt` and the sitemap.
 *
 * Usage:
 *   tsx scripts/generate-docs.ts            # write
 *   tsx scripts/generate-docs.ts --check    # fail if anything is stale (CI)
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { format, resolveConfig } from 'prettier';

import { loadCatalogue } from '../src/generated/catalogue.js';
import { ToolRegistry } from '../src/tools/registry.js';
import { TOOLSET_IDS, type ToolsetId } from '../src/tools/toolsets.js';
import type { ToolDefinition } from '../src/tools/types.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DOCS = resolve(ROOT, 'docs');

/** Canonical origin of the published docs. GitHub lower-cases the owner in Pages hostnames. */
export const SITE_URL = 'https://lusrodri.github.io/render-useful-mcp';
const REPO_URL = 'https://github.com/LuSrodri/render-useful-mcp';
const NPM_URL = 'https://www.npmjs.com/package/render-useful-mcp';

const check = process.argv.includes('--check');

// ---------------------------------------------------------------------------
// Facts
// ---------------------------------------------------------------------------

const catalogue = loadCatalogue();
const registry = new ToolRegistry({ enabledToolsets: TOOLSET_IDS, readOnly: false, dynamicToolsets: true });
const tools = [...registry.all()].sort((a, b) => a.name.localeCompare(b.name));
const coreTools = tools.filter((tool) => tool.toolset === 'core');
const apiToolCount = catalogue.operations.length;
const totalToolCount = tools.length;

interface ToolsetRow {
  readonly id: ToolsetId;
  readonly tools: number;
  readonly description: string;
}

const toolsetRows: readonly ToolsetRow[] = registry
  .stats()
  .filter((entry): entry is typeof entry & { toolset: ToolsetId } => entry.toolset !== 'core')
  .map((entry) => ({ id: entry.toolset, tools: entry.tools, description: entry.description }))
  .sort((a, b) => b.tools - a.tools || a.id.localeCompare(b.id));

/** The lead sentence of a description: enough to identify a tool, short enough to list 212 of. */
function summarise(tool: ToolDefinition): string {
  const firstSentence = /^.*?[.!?](?=\s|$)/.exec(withoutUsage(tool))?.[0] ?? withoutUsage(tool);
  return firstSentence.trim();
}

function withoutUsage(tool: ToolDefinition): string {
  return tool.description.split(' Usage: ')[0]!;
}

/**
 * The `Usage:` note appended by `OPERATION_HINTS`, if this tool has one.
 *
 * Carried into the index because it is the only place a tool's *task* vocabulary lives.
 * `render_create_service` summarises as "Create service" and says nothing about cron jobs,
 * so a search for "cron job" over summaries alone misses the one tool that creates one —
 * observed, not hypothetical.
 */
function usageHint(tool: ToolDefinition): string | undefined {
  const parts = tool.description.split(' Usage: ');
  return parts.length > 1 ? parts.slice(1).join(' Usage: ').trim() : undefined;
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ---------------------------------------------------------------------------
// Rendered fragments
// ---------------------------------------------------------------------------

const toolsetTable = [
  '| Toolset | Tools | Covers |',
  '| --- | --- | --- |',
  ...toolsetRows.map((row) => `| \`${row.id}\` | ${row.tools} | ${row.description.replace(/\.$/, '')} |`),
].join('\n');

const workflowToolTable = [
  '| Tool | What it does |',
  '| --- | --- |',
  ...coreTools.map((tool) => `| \`${tool.name}\` | ${summarise(tool)} |`),
].join('\n');

const toolCountSentence =
  `**${totalToolCount} tools**: all ${apiToolCount} operations of the Render Public API ` +
  `(spec version ${catalogue.specVersion}), plus ${coreTools.length} workflow tools for the ` +
  `sequences the raw API makes tedious.`;

const toolsetCountSentence = `**All ${toolsetRows.length} toolsets are enabled by default**`;

/** The same facts as `toolCountSentence`, laid out for the landing page's hero. */
const statsHtml = [
  '        <ul class="stats">',
  `          <li><strong>${totalToolCount}</strong> MCP tools</li>`,
  `          <li><strong>${apiToolCount}</strong> API endpoints</li>`,
  `          <li><strong>${coreTools.length}</strong> workflow tools</li>`,
  `          <li><strong>${toolsetRows.length}</strong> toolsets</li>`,
  '        </ul>',
].join('\n');

const toolsetTableHtml = [
  '        <div class="scroll">',
  '          <table>',
  '            <thead><tr><th>Toolset</th><th>Tools</th><th>Covers</th></tr></thead>',
  '            <tbody>',
  ...toolsetRows.map(
    (row) =>
      `              <tr><td><code>${row.id}</code></td><td>${row.tools}</td><td>${escapeHtml(
        row.description.replace(/\.$/, ''),
      )}</td></tr>`,
  ),
  '            </tbody>',
  '          </table>',
  '        </div>',
].join('\n');

const workflowToolsHtml = [
  '        <div class="scroll">',
  '          <table>',
  '            <thead><tr><th>Tool</th><th>What it does</th></tr></thead>',
  '            <tbody>',
  ...coreTools.map(
    (tool) =>
      `              <tr><td><code>${escapeHtml(tool.name)}</code></td><td>${escapeHtml(summarise(tool))}</td></tr>`,
  ),
  '            </tbody>',
  '          </table>',
  '        </div>',
].join('\n');

// ---------------------------------------------------------------------------
// Whole generated files
// ---------------------------------------------------------------------------

/**
 * `llms.txt` — the short, linked index an assistant reads first.
 *
 * Deliberately not a copy of the README: it answers "what is this and how do I install it"
 * in the fewest tokens that still produce a correct install command.
 */
function renderLlmsTxt(): string {
  return `# render-useful-mcp

> An unofficial, complete Model Context Protocol (MCP) server for the Render Public API. It exposes all ${apiToolCount} Render endpoints as MCP tools, generated from Render's own OpenAPI document, plus ${coreTools.length} higher-level workflow tools. Runs locally over stdio; MIT licensed; not affiliated with Render.

Use it to let an AI assistant manage Render services, deploys, cron jobs, Postgres, Key Value, disks, environment groups, logs and metrics.

## Install

Claude Code, globally (available in every project):

\`\`\`
claude mcp add render --scope user -e RENDER_API_KEY=rnd_your_key -- npx -y render-useful-mcp
\`\`\`

Without \`--scope user\` the server is registered for the current directory only. Any client that reads an \`mcpServers\` object works too — command \`npx\`, args \`["-y","render-useful-mcp"]\`, env \`RENDER_API_KEY\`.

Requires Node.js 20.11 or newer. Get an API key from Render Dashboard → Account Settings → API Keys. Setting \`RENDER_WORKSPACE_ID\` is optional but removes a lookup from most sessions.

## Docs

- [Overview and install](${SITE_URL}/): what it is, every install route, configuration variables
- [Tool catalogue](${SITE_URL}/tools.html): all ${totalToolCount} tools with descriptions, grouped by toolset
- [Full text for LLMs](${SITE_URL}/llms-full.txt): everything above in one file
- [README](${REPO_URL}#readme): design notes and development
- [Privacy](${REPO_URL}/blob/main/PRIVACY.md): no telemetry, no backend, key never written to disk

## Optional

- [npm package](${NPM_URL})
- [Source](${REPO_URL})
- [Render Public API](https://api-docs.render.com/reference/introduction)
`;
}

/** `llms-full.txt` — one self-contained file: an assistant should not need a second fetch. */
function renderLlmsFullTxt(): string {
  const byToolset = toolsetRows
    .map((row) => {
      const members = tools.filter((tool) => tool.toolset === row.id);
      return [
        `### ${row.id} (${row.tools} tools)`,
        '',
        row.description,
        '',
        ...members.map((tool) => `- \`${tool.name}\` — ${summarise(tool)}`),
      ].join('\n');
    })
    .join('\n\n');

  return `# render-useful-mcp — full reference

> Unofficial MCP server for the Render Public API. ${totalToolCount} tools: all ${apiToolCount} endpoints of Render's Public API (spec ${catalogue.specVersion}), generated from Render's OpenAPI document, plus ${coreTools.length} workflow tools. Local stdio server, MIT licensed, no telemetry. Not affiliated with Render.

Source: ${REPO_URL}
Package: ${NPM_URL}
Docs: ${SITE_URL}/

## Install

### Claude Code (global — recommended)

\`\`\`
claude mcp add render --scope user -e RENDER_API_KEY=rnd_your_key -- npx -y render-useful-mcp
\`\`\`

\`--scope user\` registers the server in your user configuration, so it is available in every
project. The default scope is \`local\`, which registers it for the current directory only —
the usual reason a server "disappears" after changing directory.

Verify with \`claude mcp list\`.

### Claude Code plugin

\`\`\`
/plugin marketplace add LuSrodri/render-useful-mcp
/plugin install render-useful-mcp@lusrodri-render
\`\`\`

Export \`RENDER_API_KEY\` in the shell that launches Claude Code.

### Claude Desktop and other mcpServers clients

\`\`\`json
{
  "mcpServers": {
    "render": {
      "command": "npx",
      "args": ["-y", "render-useful-mcp"],
      "env": {
        "RENDER_API_KEY": "rnd_your_key_here",
        "RENDER_WORKSPACE_ID": "tea_your_workspace_id"
      }
    }
  }
}
\`\`\`

### Desktop extension

Download the \`.mcpb\` bundle from ${REPO_URL}/releases/latest and open it. Claude installs it
and prompts for the API key; the bundle ships its own dependencies and needs no Node install.

## Configuration

| Variable | Default | Description |
| --- | --- | --- |
| \`RENDER_API_KEY\` | — | Required. Render API key. |
| \`RENDER_WORKSPACE_ID\` | — | Workspace id used wherever an \`ownerId\` is needed and none was given. |
| \`RENDER_MCP_TOOLSETS\` | \`all\` | Narrow the surface to a comma-separated list of toolsets. |
| \`RENDER_MCP_READ_ONLY\` | \`false\` | Expose only non-mutating tools. |
| \`RENDER_MCP_DYNAMIC_TOOLSETS\` | \`true\` | Register \`render_toolsets\`. |
| \`RENDER_MCP_TIMEOUT_MS\` | \`60000\` | Per-request timeout. |
| \`RENDER_MCP_MAX_RETRIES\` | \`3\` | Retries for rate limits and transient server errors. |
| \`RENDER_MCP_MAX_RESPONSE_BYTES\` | \`400000\` | Larger tool results are truncated with a note. |
| \`RENDER_MCP_LOG_LEVEL\` | \`info\` | \`debug\`, \`info\`, \`warn\`, \`error\`, \`silent\`. Logs go to stderr. |
| \`RENDER_API_BASE_URL\` | \`https://api.render.com/v1\` | Override for proxies or testing. |

## Common tasks

**Create a cron job that runs a Docker image on a schedule.** Cron jobs are services. Call
\`render_create_service\` with \`type: "cron_job"\`, and a \`serviceDetails\` matching the
\`cronJobDetailsPOST\` branch:

\`\`\`json
{
  "type": "cron_job",
  "name": "nightly-report",
  "ownerId": "tea-...",
  "repo": "https://github.com/acme/reports",
  "branch": "main",
  "serviceDetails": {
    "runtime": "docker",
    "schedule": "0 3 * * *",
    "plan": "starter",
    "region": "oregon",
    "envSpecificDetails": {
      "dockerfilePath": "./Dockerfile",
      "dockerContext": ".",
      "dockerCommand": "python report.py"
    }
  }
}
\`\`\`

For a prebuilt image, drop \`repo\`/\`branch\`, set \`image\` to
\`{"ownerId":"tea-...","imagePath":"docker.io/acme/reports:latest"}\`, use \`runtime: "image"\`,
and give \`envSpecificDetails\` only \`dockerCommand\`. \`schedule\` is a five-field cron
expression in UTC. Change it later with \`render_update_service\`; trigger an off-schedule run
with \`render_run_cron_job\`. \`render_create_job\` is a different thing — a one-off command on
an existing service.

**Diagnose a broken service.** \`render_service_status\` returns configuration, recent
deploys, instances and error logs in one call.

**Deploy and wait.** \`render_create_deploy\`, then \`render_wait_for_deploy\`.

**Read logs.** \`render_recent_logs\` takes a service name; \`render_list_logs\` needs an
\`ownerId\` and a resource array.

## Conventions

- Ids are prefixed: services \`srv-\`, deploys \`dep-\`, workspaces \`tea-\`/\`usr-\`, Postgres
  \`dpg-\`, Key Value \`red-\`, environment groups \`evg-\`.
- Users say names, tools need ids — \`render_find_service\` resolves partial and approximate
  names in one call.
- Where an argument is a \`oneOf\`, each branch is titled with its name in Render's spec.
  Match the title to the field that selects it: \`serviceDetails\` follows \`type\`,
  \`envSpecificDetails\` follows \`runtime\` (\`docker\` → \`dockerDetails\`).
- PUT tools that take a collection replace it wholesale; read the current value first.

## Workflow tools

Always available, in any toolset configuration.

${coreTools.map((tool) => `- \`${tool.name}\` — ${summarise(tool)}`).join('\n')}

## API tools by toolset

One tool per Render endpoint, named \`render_<operation_id>\`. All toolsets are on by default;
\`RENDER_MCP_TOOLSETS\` narrows the surface.

${byToolset}
`;
}

function renderToolsPage(): string {
  const sections = [
    { id: 'core', label: 'Workflow tools', description: 'Always available, in any toolset configuration.' },
    ...toolsetRows.map((row) => ({ id: row.id, label: row.id, description: row.description })),
  ];

  const nav = sections
    .map((section) => `<a href="#${section.id}">${escapeHtml(section.label)}</a>`)
    .join('\n          ');

  const body = sections
    .map((section) => {
      const members = tools.filter((tool) => tool.toolset === section.id);
      const rows = members
        .map((tool) => {
          const hint = usageHint(tool);
          // The hint carries the task vocabulary — "cron job", "replaces the whole set" —
          // which is both what a reader is searching for and what a summary omits.
          const usage = hint === undefined ? '' : `<p class="usage"><strong>Usage:</strong> ${escapeHtml(hint)}</p>`;
          return `<tr>
              <td><code id="${escapeHtml(tool.name)}">${escapeHtml(tool.name)}</code></td>
              <td>${escapeHtml(summarise(tool))}${usage}</td>
            </tr>`;
        })
        .join('\n            ');
      return `<section id="${section.id}">
          <h2>${escapeHtml(section.label)} <span class="count">${members.length}</span></h2>
          <p>${escapeHtml(section.description)}</p>
          <div class="scroll">
            <table>
              <thead><tr><th>Tool</th><th>Description</th></tr></thead>
              <tbody>
            ${rows}
              </tbody>
            </table>
          </div>
        </section>`;
    })
    .join('\n\n        ');

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Tool catalogue — render-useful-mcp</title>
    <meta name="description" content="All ${totalToolCount} MCP tools exposed by render-useful-mcp: every Render Public API endpoint plus ${coreTools.length} workflow tools, grouped by toolset." />
    <link rel="canonical" href="${SITE_URL}/tools.html" />
    <meta property="og:type" content="website" />
    <meta property="og:title" content="Tool catalogue — render-useful-mcp" />
    <meta property="og:description" content="All ${totalToolCount} MCP tools for the Render Public API, grouped by toolset." />
    <meta property="og:url" content="${SITE_URL}/tools.html" />
    <meta name="twitter:card" content="summary" />
    <link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'%3E%3Ctext y='.9em' font-size='90'%3E%F0%9F%9B%A0%EF%B8%8F%3C/text%3E%3C/svg%3E" />
    <link rel="stylesheet" href="./style.css" />
    <script type="application/ld+json">
${JSON.stringify(
  {
    '@context': 'https://schema.org',
    '@type': 'CollectionPage',
    name: 'render-useful-mcp tool catalogue',
    description: `All ${totalToolCount} MCP tools exposed by render-useful-mcp.`,
    url: `${SITE_URL}/tools.html`,
    isPartOf: { '@type': 'WebSite', name: 'render-useful-mcp', url: `${SITE_URL}/` },
  },
  null,
  2,
)}
    </script>
  </head>
  <body>
    <div class="wrap">
      <header class="page-head">
        <p class="crumb"><a href="./">render-useful-mcp</a> / tool catalogue</p>
        <h1>Tool catalogue</h1>
        <p class="lede">
          ${totalToolCount} tools — all ${apiToolCount} operations of the Render Public API (spec
          ${catalogue.specVersion}) plus ${coreTools.length} workflow tools. Generated from Render's
          OpenAPI document, so this page is never out of date with the server.
        </p>
        <nav class="toc">
          ${nav}
        </nav>
      </header>

      <main>
        ${body}
      </main>

      <footer>
        <p>
          <a href="./">Overview</a> · <a href="${REPO_URL}">Source</a> ·
          <a href="./llms.txt">llms.txt</a> · MIT licensed · Not affiliated with Render.
        </p>
      </footer>
    </div>
  </body>
</html>
`;
}

function renderSitemap(): string {
  const today = new Date().toISOString().slice(0, 10);
  const pages = [
    { loc: `${SITE_URL}/`, priority: '1.0' },
    { loc: `${SITE_URL}/tools.html`, priority: '0.8' },
  ];
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${pages
  .map(
    (page) =>
      `  <url>\n    <loc>${page.loc}</loc>\n    <lastmod>${today}</lastmod>\n    <priority>${page.priority}</priority>\n  </url>`,
  )
  .join('\n')}
</urlset>
`;
}

/**
 * The tool index the docs page registers with WebMCP, as JSON.
 *
 * Emitted as data rather than inlined into the page so the browser tools answer from the
 * same catalogue as the server — a page that described a different tool set than the one
 * you install would be worse than no page at all.
 */
function renderToolIndexJson(): string {
  return `${JSON.stringify(
    {
      $comment: 'GENERATED FILE — run `npm run docs` to rebuild from src/generated/operations.json.',
      specVersion: catalogue.specVersion,
      totalTools: totalToolCount,
      tools: tools.map((tool) => {
        const hint = usageHint(tool);
        return {
          name: tool.name,
          toolset: tool.toolset,
          summary: summarise(tool),
          readOnly: tool.annotations.readOnlyHint === true,
          destructive: tool.annotations.destructiveHint === true,
          ...(hint !== undefined ? { usage: hint } : {}),
        };
      }),
    },
    null,
    2,
  )}\n`;
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

const stale: string[] = [];

function emit(relativePath: string, contents: string): void {
  const target = resolve(ROOT, relativePath);
  let current: string | undefined;
  try {
    current = readFileSync(target, 'utf8');
  } catch {
    current = undefined;
  }
  if (current === contents) return;

  if (check) {
    stale.push(relativePath);
    return;
  }
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, contents, 'utf8');
  console.log(`wrote ${relativePath}`);
}

/**
 * Replaces the body of every `<!-- generated:key -->` region in a hand-written document.
 *
 * A missing region is an error rather than a no-op: silently writing nothing is how the
 * generated numbers would drift back out of the docs without anyone noticing.
 *
 * Markdown output goes through Prettier on the way out. Without that, this script and
 * `npm run format` disagree about table padding, and running the formatter would leave
 * `--check` failing on files nobody edited.
 */
async function emitRegions(relativePath: string, regions: Readonly<Record<string, string>>): Promise<void> {
  const target = resolve(ROOT, relativePath);
  const original = readFileSync(target, 'utf8');
  let updated = original;

  for (const [key, body] of Object.entries(regions)) {
    const pattern = new RegExp(`(<!-- generated:${key} -->)[\\s\\S]*?(<!-- /generated:${key} -->)`);
    if (!pattern.test(updated)) {
      throw new Error(`${relativePath} has no "<!-- generated:${key} -->" region. Add it, or drop the key here.`);
    }
    updated = updated.replace(pattern, `$1\n${body}\n$2`);
  }

  if (relativePath.endsWith('.md')) {
    updated = await format(updated, { ...(await resolveConfig(target)), filepath: target });
  }

  if (updated === original) return;
  if (check) {
    stale.push(relativePath);
    return;
  }
  writeFileSync(target, updated, 'utf8');
  console.log(`updated ${relativePath}`);
}

await emitRegions('README.md', {
  'tool-counts': toolCountSentence,
  'toolset-count': toolsetCountSentence,
  'toolset-table': toolsetTable,
  'workflow-tools': workflowToolTable,
});

await emitRegions('plugin/README.md', {
  'tool-counts': toolCountSentence,
  'workflow-tools': workflowToolTable,
});

// The landing page is hand-written; only the parts that quote the catalogue are generated.
await emitRegions('docs/index.html', {
  'stats-html': statsHtml,
  'toolset-table-html': toolsetTableHtml,
  'workflow-tools-html': workflowToolsHtml,
});

emit('docs/llms.txt', renderLlmsTxt());
emit('docs/llms-full.txt', renderLlmsFullTxt());
emit('docs/tools.html', renderToolsPage());
emit('docs/sitemap.xml', renderSitemap());
emit('docs/tool-index.json', renderToolIndexJson());

if (check && stale.length > 0) {
  console.error(
    `Documentation is out of date with the tool catalogue:\n${stale.map((path) => `  - ${path}`).join('\n')}\n\n` +
      `Run "npm run docs" and commit the result.`,
  );
  process.exit(1);
}

if (!check) {
  console.log(`Documented ${totalToolCount} tools (${apiToolCount} API + ${coreTools.length} workflow) in ${DOCS}`);
}
