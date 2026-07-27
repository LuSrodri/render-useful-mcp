# render-useful-mcp

A Model Context Protocol server for [Render](https://render.com) that exposes **all 207 endpoints of the official Render Public API**, plus a handful of higher-level tools for the workflows the raw API makes tedious.

Written in TypeScript. Every API tool is generated from Render's own OpenAPI document, so coverage is complete by construction and stays that way.

---

## Why this one

Most API wrappers stop at "one tool per endpoint". That is necessary but not sufficient — 207 tools is more than most clients handle well, and the raw endpoints assume you already know ids you don't have.

This server addresses both:

- **Complete.** All 207 operations, generated from the spec. No hand-maintained subset that drifts.
- **Manageable.** Tools are grouped into 17 toolsets. A sensible default is enabled; the model can turn on the rest mid-session without a restart.
- **Usable by a model.** Names resolve to ids fuzzily, your workspace id is filled in automatically, deploys can be waited on in one call, and failures come back with a hint instead of a bare status code.
- **Safe by default.** Read-only mode, MCP destructive/read-only annotations derived from the actual HTTP semantics, and secret redaction in logs.

## Install

Requires Node.js ≥ 20.11.

```bash
npm install -g render-useful-mcp
```

Or run it without installing, which is what most MCP client configs do:

```bash
npx -y render-useful-mcp
```

## Configure your MCP client

Get an API key from **Render Dashboard → Account Settings → API Keys**.

**Claude Code**

```bash
claude mcp add render -e RENDER_API_KEY=rnd_your_key -- npx -y render-useful-mcp
```

**Claude Desktop / any client using `mcpServers`** — add to the config file:

```json
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
```

`RENDER_WORKSPACE_ID` is optional but recommended: many Render endpoints require an `ownerId` that the model has no way to guess, and setting it removes a lookup from nearly every session. Find it with the `render_list_owners` tool, or read it from your dashboard URL.

## Configuration

| Variable                        | Default                     | Description                                                               |
| ------------------------------- | --------------------------- | ------------------------------------------------------------------------- |
| `RENDER_API_KEY`                | —                           | **Required.** Your Render API key.                                        |
| `RENDER_WORKSPACE_ID`           | —                           | Workspace id applied wherever an `ownerId` is needed and none was given.  |
| `RENDER_MCP_TOOLSETS`           | see below                   | `all`, or a comma-separated list of toolsets.                             |
| `RENDER_MCP_READ_ONLY`          | `false`                     | When true, only non-mutating (GET) tools are exposed at all.              |
| `RENDER_MCP_DYNAMIC_TOOLSETS`   | `true`                      | Registers `render_toolsets` so the model can enable toolsets mid-session. |
| `RENDER_MCP_TIMEOUT_MS`         | `60000`                     | Per-request timeout.                                                      |
| `RENDER_MCP_MAX_RETRIES`        | `3`                         | Retries for rate limits and transient server errors.                      |
| `RENDER_MCP_MAX_RESPONSE_BYTES` | `400000`                    | Tool results larger than this are truncated with a note.                  |
| `RENDER_MCP_LOG_LEVEL`          | `info`                      | `debug`, `info`, `warn`, `error`, `silent`. Logs go to stderr.            |
| `RENDER_API_BASE_URL`           | `https://api.render.com/v1` | Override for proxies or testing.                                          |

## Toolsets

All 207 generated tools belong to exactly one toolset. Exposing every tool at once costs a lot of context and measurably degrades tool selection, so the server enables the common ones and leaves the rest one call away.

| Toolset        | Tools | On by default | Covers                                                             |
| -------------- | ----- | ------------- | ------------------------------------------------------------------ |
| `services`     | 42    | ✅            | Services, deploys, custom domains, one-off jobs, cron runs, events |
| `postgres`     | 21    | ✅            | Postgres instances, users, exports, PITR, query insights           |
| `env-groups`   | 13    | ✅            | Environment groups, their variables and secret files               |
| `projects`     | 12    | ✅            | Projects and environments                                          |
| `logs`         | 10    | ✅            | Log queries, label discovery, log streams                          |
| `static-sites` | 9     | ✅            | Header rules, redirects and rewrites                               |
| `key-value`    | 8     | ✅            | Key Value (Redis-compatible) instances                             |
| `workspaces`   | 8     | ✅            | Workspaces, members, current user, audit logs                      |
| `disks`        | 7     | ✅            | Persistent disks and snapshots                                     |
| `blueprints`   | 6     | ✅            | Blueprints and Blueprint syncs                                     |
| `metrics`      | 23    | —             | CPU, memory, bandwidth, HTTP, disk, connections, metrics streams   |
| `workflows`    | 15    | —             | Render Workflows and workflow tasks (public beta)                  |
| `webhooks`     | 11    | —             | Webhooks and notification settings                                 |
| `deprecated`   | 8     | —             | Legacy Redis endpoints, superseded by Key Value                    |
| `network`      | 5     | —             | Dedicated outbound IP sets                                         |
| `registry`     | 5     | —             | Container registry credentials                                     |
| `maintenance`  | 4     | —             | Scheduled maintenance runs                                         |

To change the selection up front:

```jsonc
"env": { "RENDER_MCP_TOOLSETS": "all" }                    // everything
"env": { "RENDER_MCP_TOOLSETS": "services,logs,metrics" }  // just these
```

At runtime, the model can call `render_toolsets` to list the current state or enable a group. The server then emits `notifications/tools/list_changed` and the new tools become available immediately — no restart.

## Tools

### Workflow tools

These are always available, in any toolset configuration. They exist because the equivalent raw sequence is several calls the model usually gets wrong on the first try.

| Tool                     | What it does                                                                                                                                                            |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `render_find_service`    | Resolves a service name — partial or approximate — to a single service and its id, with close alternatives. Handles "the api service" correctly.                        |
| `render_wait_for_deploy` | Polls a deploy to a terminal state (`live`, `build_failed`, …) with a timeout, instead of the model looping on `render_retrieve_deploy`. Defaults to the latest deploy. |
| `render_service_status`  | One-call triage: configuration, recent deploys, running instances and recent error logs, fetched concurrently. Answers "why is X broken?".                              |
| `render_recent_logs`     | Recent logs for a service, resolving the name and workspace id for you, with level/text filters.                                                                        |
| `render_toolsets`        | Lists toolsets and enables them at runtime.                                                                                                                             |

### API tools

One per Render endpoint, named `render_<operation_id>` — `render_list_services`, `render_create_deploy`, `render_update_postgres`, and so on. Each carries the summary, description, parameter docs, enums and constraints straight from Render's spec.

## Design notes

**Generated, not hand-written.** `scripts/generate-operations.ts` reads `spec/render-openapi.json` and emits the tool catalogue. It is strict: an unmapped tag, a name collision, a cyclic `$ref`, a path parameter missing from its template, or a body property that would shadow a query parameter all fail the build rather than producing a subtly wrong tool. Updating to a new Render API version is: drop in the new spec, run `npm run generate`, review the diff.

**Schemas reach the client intact.** Render's spec uses the full range of JSON Schema. Tool schemas are fully dereferenced and passed through unmodified, and Ajv validates arguments against them — so enums, patterns, formats and `oneOf` are all actually enforced. This is why the server uses the SDK's low-level `Server` rather than `McpServer`, which accepts only Zod schemas.

**Bodies are flattened.** Request-body properties become top-level tool arguments, which keeps call sites shallow and improves tool-call accuracy. The generator proves at build time that body properties never collide with path or query parameters. The six array- and `oneOf`-valued bodies keep their structure under a single `body` argument.

**Errors are made actionable.** A failure returns the HTTP status, Render's own message and a hint aimed at the actual cause — a 404 suggests confirming the id with a list call, a 401 points at the API key page. A tool that is registered but hidden says which toolset to enable rather than "unknown tool".

**Retries are conservative.** Rate limits and transient 5xx are retried with decorrelated-jitter backoff, honouring `Retry-After`. Non-idempotent methods are never replayed on a server error: a retried `POST /deploys` would deploy twice.

**Secrets stay out of logs.** Logging is structured JSON on stderr — stdout is the transport — with connection strings, API keys and tokens redacted.

## Development

```bash
npm install
npm run generate    # rebuild the tool catalogue from the OpenAPI spec
npm run build
npm test
npm run check       # generate + lint + typecheck + test
```

The test suite covers catalogue invariants (all 207 operations, no dangling `$ref`, path params required, annotations match HTTP semantics), request mapping, retry and pagination behaviour, the composite tools, and a full in-memory MCP client/server round trip.

## License

MIT — see [LICENSE](LICENSE).

Not affiliated with Render. `spec/render-openapi.json` is Render's published API description, vendored so builds are reproducible.
