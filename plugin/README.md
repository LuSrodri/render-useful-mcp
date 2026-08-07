# render-useful-mcp plugin

Bundles the [`render-useful-mcp`](https://github.com/LuSrodri/render-useful-mcp) MCP server
so Claude Code can operate your Render account: services, deploys, Postgres, Key Value,
disks, environment groups, logs, metrics and the rest of the Render Public API.

Unofficial, and not affiliated with Render. Render publishes its own Claude Code plugin at
[`render-oss/render-plugin-claude-code`](https://github.com/render-oss/render-plugin-claude-code),
which takes a different approach: hand-written skills and agents for common workflows. This
one is generated from Render's OpenAPI document and exposes the complete API surface, so the
two are complementary rather than alternatives — installing both is reasonable.

## Setup

The plugin needs a Render API key. Create one at
**Render Dashboard → Account Settings → API Keys**, then export it before starting Claude
Code:

```bash
export RENDER_API_KEY=rnd_your_key_here    # macOS/Linux
```

```powershell
$env:RENDER_API_KEY = "rnd_your_key_here"  # Windows PowerShell
```

Put it in your shell profile to avoid repeating it. The server reads the key from the
environment only — it is never written to the plugin or to any config file.

If the variable is not set when the server starts, it exits with an explanatory message
rather than failing later on the first API call.

## What you get

<!-- generated:tool-counts -->

**212 tools**: all 207 operations of the Render Public API (spec version 1.0.0), plus 5 workflow tools for the sequences the raw API makes tedious.
<!-- /generated:tool-counts -->

<!-- generated:workflow-tools -->

| Tool                     | What it does                                                                                                                             |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `render_find_service`    | Resolves a service name — including a partial or approximate one — to a single Render service, returning its id plus close alternatives. |
| `render_recent_logs`     | Fetches recent log lines for a service, resolving the service name and workspace id for you.                                             |
| `render_service_status`  | One-call triage for a service: its configuration, latest deploys, running instances and most recent error-level logs.                    |
| `render_toolsets`        | Lists every Render toolset with its tool count and whether it is currently enabled.                                                      |
| `render_wait_for_deploy` | Polls a deploy until it reaches a terminal state (live, build_failed, update_failed, canceled, deactivated) or the timeout expires.      |

<!-- /generated:workflow-tools -->

Ask things like _"why is my api service down?"_, _"deploy the latest commit to staging and
tell me when it's live"_, _"show me the error logs for the worker in the last hour"_, or
_"create a cron job that runs my Dockerfile every night at 3am"_.

Plugins are installed for your user, so this is available in every project — unlike
`claude mcp add` without `--scope user`, which registers a server for one directory only.

## Optional configuration

All optional, set the same way as `RENDER_API_KEY`:

| Variable               | Default | Effect                                                        |
| ---------------------- | ------- | ------------------------------------------------------------- |
| `RENDER_WORKSPACE_ID`  | —       | Applied wherever a tool needs an `ownerId` and none was given |
| `RENDER_MCP_TOOLSETS`  | `all`   | Narrow the surface to a comma-separated list of toolsets      |
| `RENDER_MCP_READ_ONLY` | `false` | Expose only non-mutating tools — look but do not touch        |

Leave a variable unset rather than setting it to an empty string; the server validates its
configuration at startup and rejects blank values.

The full list is in the [server README](https://github.com/LuSrodri/render-useful-mcp#readme).

## Safety

Tools carry MCP annotations (`readOnlyHint`, `destructiveHint`, `idempotentHint`) derived
from the real HTTP semantics of each endpoint, so Claude Code can make sensible
auto-approval decisions. Deleting a service is marked destructive; listing services is not.

For an agent that should never mutate anything, set `RENDER_MCP_READ_ONLY=true` — mutating
tools are then not exposed at all, rather than merely discouraged.

## Privacy

No telemetry, no analytics, no backend. The server runs locally and contacts exactly one
host — Render's API. Your key is sent only to Render, never written to disk, and redacted
from log output. See
[PRIVACY.md](https://github.com/LuSrodri/render-useful-mcp/blob/main/PRIVACY.md).
