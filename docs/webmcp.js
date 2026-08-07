/**
 * Exposes this documentation site's own content to browser agents via WebMCP.
 *
 * An agent that lands here to answer "how do I install this" or "which tool creates a cron
 * job" would otherwise have to read and re-read the rendered page. These tools answer from
 * `tool-index.json`, which `scripts/generate-docs.ts` emits from the same catalogue the
 * server ships — so the page can never describe a tool set different from the one you
 * install.
 *
 * WebMCP is a draft with two shapes in the wild: `document.modelContext` (the current W3C
 * draft, async) and `navigator.modelContext` (the earlier Chrome origin trial, sync). Both
 * are supported, and everything is behind feature detection — a docs page must render
 * identically in a browser that has never heard of any of this.
 *
 * Every tool here is read-only: it reads a static JSON file that this same page already
 * fetched, and touches nothing else.
 */
(() => {
  'use strict';

  const context = globalThis.document?.modelContext ?? globalThis.navigator?.modelContext;
  if (!context || typeof context.registerTool !== 'function') return;

  const INDEX_URL = new URL('./tool-index.json', import.meta.url ?? location.href);

  let indexPromise;
  const loadIndex = () => {
    // Loaded once, lazily: an agent may never call a tool, and the index is not small.
    indexPromise ??= fetch(INDEX_URL).then((response) => {
      if (!response.ok) throw new Error(`Could not load the tool index (HTTP ${response.status})`);
      return response.json();
    });
    return indexPromise;
  };

  /** Both API generations accept the MCP-style content result, so only one shape is built. */
  const reply = (payload) => ({
    content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
  });

  const scoreMatch = (tool, terms) => {
    // `usage` is included because it holds the task vocabulary: render_create_service
    // summarises as "Create service" and would otherwise be invisible to a search for
    // "cron job", despite being the only tool that creates one.
    const haystack = `${tool.name} ${tool.toolset} ${tool.summary} ${tool.usage ?? ''}`.toLowerCase();
    let score = 0;
    for (const term of terms) {
      if (!haystack.includes(term)) return 0;
      // A hit in the name is worth more than one buried in prose.
      score += tool.name.toLowerCase().includes(term) ? 3 : 1;
    }
    return score;
  };

  const tools = [
    {
      name: 'search_render_mcp_tools',
      title: 'Search the render-useful-mcp tool catalogue',
      description:
        'Searches the tools that render-useful-mcp exposes for the Render Public API, by name, ' +
        'toolset or description. Use it to answer which tool performs a given Render operation — ' +
        'creating a service or cron job, reading logs, scaling, managing Postgres. Returns tool ' +
        'names with their descriptions and whether they are read-only or destructive.',
      inputSchema: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Words to look for, e.g. "cron job", "postgres backup", "logs".',
          },
          toolset: {
            type: 'string',
            description: 'Optional toolset to restrict the search to, e.g. "services" or "postgres".',
          },
          limit: { type: 'integer', minimum: 1, maximum: 50, default: 10 },
        },
        required: ['query'],
      },
      annotations: { readOnlyHint: true },
      execute: async ({ query, toolset, limit }) => {
        const index = await loadIndex();
        const terms = String(query ?? '')
          .toLowerCase()
          .split(/\s+/)
          .filter(Boolean);

        const matches = index.tools
          .filter((tool) => toolset === undefined || toolset === null || tool.toolset === toolset)
          .map((tool) => ({ tool, score: scoreMatch(tool, terms) }))
          .filter((entry) => entry.score > 0)
          .sort((a, b) => b.score - a.score || a.tool.name.localeCompare(b.tool.name))
          .slice(0, Math.min(Number(limit ?? 10), 50))
          .map((entry) => entry.tool);

        return reply({
          query,
          matchCount: matches.length,
          totalTools: index.totalTools,
          tools: matches,
          catalogue: 'https://lusrodri.github.io/render-useful-mcp/tools.html',
        });
      },
    },

    {
      name: 'get_render_mcp_install_command',
      title: 'Get the render-useful-mcp install command',
      description:
        'Returns the command or configuration that installs the render-useful-mcp MCP server for a ' +
        'given client (Claude Code, Claude Desktop, VS Code, Cursor, or any client using an ' +
        'mcpServers object). Claude Code commands install globally, into user scope.',
      inputSchema: {
        type: 'object',
        properties: {
          client: {
            type: 'string',
            enum: ['claude-code', 'claude-code-plugin', 'claude-desktop', 'mcp-servers-json', 'desktop-extension'],
            description: 'Which client to produce install instructions for.',
          },
        },
        required: ['client'],
      },
      annotations: { readOnlyHint: true },
      execute: ({ client }) => {
        const recipes = {
          'claude-code': {
            command: 'claude mcp add render --scope user -e RENDER_API_KEY=rnd_your_key -- npx -y render-useful-mcp',
            note: '--scope user installs globally. Without it, Claude Code registers the server for the current directory only.',
            verify: 'claude mcp list',
          },
          'claude-code-plugin': {
            command:
              '/plugin marketplace add LuSrodri/render-useful-mcp\n/plugin install render-useful-mcp@lusrodri-render',
            note: 'Export RENDER_API_KEY in the shell that launches Claude Code. Plugins are installed for your user, so this applies to every project.',
          },
          'claude-desktop': {
            note: 'Add to claude_desktop_config.json, then restart Claude.',
            config: {
              mcpServers: {
                render: {
                  command: 'npx',
                  args: ['-y', 'render-useful-mcp'],
                  env: { RENDER_API_KEY: 'rnd_your_key_here', RENDER_WORKSPACE_ID: 'tea_your_workspace_id' },
                },
              },
            },
          },
          'mcp-servers-json': {
            note: 'Any client that reads an mcpServers object accepts this entry.',
            config: {
              mcpServers: {
                render: {
                  command: 'npx',
                  args: ['-y', 'render-useful-mcp'],
                  env: { RENDER_API_KEY: 'rnd_your_key_here' },
                },
              },
            },
          },
          'desktop-extension': {
            note: 'Download the .mcpb bundle from the latest release and open it. Claude prompts for the API key; no Node install is needed.',
            url: 'https://github.com/LuSrodri/render-useful-mcp/releases/latest',
          },
        };

        return reply({
          client,
          ...(recipes[client] ?? { error: `Unknown client "${client}".`, known: Object.keys(recipes) }),
          requires: 'Node.js >= 20.11 (except the desktop extension), and a Render API key.',
          apiKey: 'Render Dashboard -> Account Settings -> API Keys',
        });
      },
    },

    {
      name: 'get_render_mcp_recipe',
      title: 'Get a worked render-useful-mcp example',
      description:
        'Returns a complete, copyable example of a common Render task performed through ' +
        'render-useful-mcp tools — creating a Docker cron job, deploying and waiting, diagnosing a ' +
        'broken service, or reading logs — including the exact tool name and argument shape.',
      inputSchema: {
        type: 'object',
        properties: {
          task: {
            type: 'string',
            enum: ['docker-cron-job', 'deploy-and-wait', 'diagnose-service', 'read-logs'],
            description: 'Which task to produce a worked example for.',
          },
        },
        required: ['task'],
      },
      annotations: { readOnlyHint: true },
      execute: ({ task }) => {
        const recipes = {
          'docker-cron-job': {
            summary: 'A cron job is a service. Create it with render_create_service and type "cron_job".',
            tool: 'render_create_service',
            arguments: {
              type: 'cron_job',
              name: 'nightly-report',
              ownerId: 'tea-...',
              repo: 'https://github.com/acme/reports',
              branch: 'main',
              serviceDetails: {
                runtime: 'docker',
                schedule: '0 3 * * *',
                plan: 'starter',
                region: 'oregon',
                envSpecificDetails: {
                  dockerfilePath: './Dockerfile',
                  dockerContext: '.',
                  dockerCommand: 'python report.py',
                },
              },
            },
            notes: [
              'serviceDetails must use the branch titled cronJobDetailsPOST, which is the one matching type: cron_job.',
              'envSpecificDetails must use the branch titled dockerDetails, because runtime is docker.',
              'schedule is a five-field cron expression in UTC and is required for cron jobs.',
              'For a prebuilt image: drop repo/branch, set image to {ownerId, imagePath}, use runtime "image", and give envSpecificDetails only dockerCommand.',
              'render_update_service changes the schedule later; render_run_cron_job triggers an off-schedule run.',
              'render_create_job is a different thing — a one-off command on an existing service.',
            ],
          },
          'deploy-and-wait': {
            summary: 'Trigger a deploy, then block on its outcome instead of polling.',
            steps: [
              { tool: 'render_find_service', arguments: { query: 'api' } },
              { tool: 'render_create_deploy', arguments: { serviceId: 'srv-...', clearCache: 'do_not_clear' } },
              { tool: 'render_wait_for_deploy', arguments: { serviceId: 'srv-...', timeoutSeconds: 600 } },
            ],
          },
          'diagnose-service': {
            summary: 'One call returns configuration, recent deploys, instances and error logs.',
            tool: 'render_service_status',
            arguments: { serviceId: 'api', includeLogs: true },
          },
          'read-logs': {
            summary: 'render_recent_logs takes a service name and fills in the workspace id.',
            tool: 'render_recent_logs',
            arguments: { serviceId: 'api', level: ['error'], limit: 50 },
          },
        };

        return reply(recipes[task] ?? { error: `Unknown task "${task}".`, known: Object.keys(recipes) });
      },
    },
  ];

  for (const tool of tools) {
    try {
      // The draft API returns a promise and rejects when permissions policy forbids tools;
      // the origin-trial API is synchronous. Handling both keeps one code path.
      const result = context.registerTool(tool);
      if (result && typeof result.catch === 'function') result.catch(() => {});
    } catch {
      // A page that throws while advertising itself to agents is worse than one that does
      // not advertise at all.
    }
  }
})();
