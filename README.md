# render-useful-mcp

A Model Context Protocol server for [Render](https://render.com) that exposes **all 207 endpoints of the official Render Public API**, plus a handful of higher-level tools for the workflows the raw API makes tedious.

Written in TypeScript. Every API tool is generated from Render's own OpenAPI document, so coverage is complete by construction and stays that way.

---

## Why this one

Most API wrappers stop at a curated subset of endpoints, which drifts out of date and leaves you stuck the moment you need something the author skipped.

- **Complete, by construction.** All 207 operations, generated from Render's own OpenAPI document. Everything the API allows your key to do is reachable out of the box — no opt-in required.
- **Usable by a model.** Names resolve to ids fuzzily, your workspace id is filled in automatically, deploys can be waited on in one call, and failures come back with a hint instead of a bare status code.
- **Narrowable when you want it.** The 17 toolsets are all on by default; `RENDER_MCP_TOOLSETS` and `RENDER_MCP_READ_ONLY` exist to restrict the surface deliberately, not to gate it.
- **Honest about risk.** MCP destructive/read-only/idempotent annotations are derived from real HTTP semantics, so clients can make sensible auto-approval decisions. Secrets are redacted from logs.

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
| `RENDER_MCP_TOOLSETS`           | `all`                       | Narrow the surface to a comma-separated list of toolsets.                 |
| `RENDER_MCP_READ_ONLY`          | `false`                     | When true, only non-mutating (GET) tools are exposed at all.              |
| `RENDER_MCP_DYNAMIC_TOOLSETS`   | `true`                      | Registers `render_toolsets` so the model can enable toolsets mid-session. |
| `RENDER_MCP_TIMEOUT_MS`         | `60000`                     | Per-request timeout.                                                      |
| `RENDER_MCP_MAX_RETRIES`        | `3`                         | Retries for rate limits and transient server errors.                      |
| `RENDER_MCP_MAX_RESPONSE_BYTES` | `400000`                    | Tool results larger than this are truncated with a note.                  |
| `RENDER_MCP_LOG_LEVEL`          | `info`                      | `debug`, `info`, `warn`, `error`, `silent`. Logs go to stderr.            |
| `RENDER_API_BASE_URL`           | `https://api.render.com/v1` | Override for proxies or testing.                                          |

## Toolsets

**All 17 toolsets are enabled by default** — the server exposes everything your API key is allowed to reach. Toolsets are a way to _narrow_ the surface on purpose, not a gate you have to unlock.

| Toolset        | Tools | Covers                                                             |
| -------------- | ----- | ------------------------------------------------------------------ |
| `services`     | 42    | Services, deploys, custom domains, one-off jobs, cron runs, events |
| `metrics`      | 23    | CPU, memory, bandwidth, HTTP, disk, connections, metrics streams   |
| `postgres`     | 21    | Postgres instances, users, exports, PITR, query insights           |
| `workflows`    | 15    | Render Workflows and workflow tasks (public beta)                  |
| `env-groups`   | 13    | Environment groups, their variables and secret files               |
| `projects`     | 12    | Projects and environments                                          |
| `webhooks`     | 11    | Webhooks and notification settings                                 |
| `logs`         | 10    | Log queries, label discovery, log streams                          |
| `static-sites` | 9     | Header rules, redirects and rewrites                               |
| `key-value`    | 8     | Key Value (Redis-compatible) instances                             |
| `workspaces`   | 8     | Workspaces, members, current user, audit logs                      |
| `deprecated`   | 8     | Legacy Redis endpoints, superseded by Key Value                    |
| `disks`        | 7     | Persistent disks and snapshots                                     |
| `blueprints`   | 6     | Blueprints and Blueprint syncs                                     |
| `network`      | 5     | Dedicated outbound IP sets                                         |
| `registry`     | 5     | Container registry credentials                                     |
| `maintenance`  | 4     | Scheduled maintenance runs                                         |

Reasons you might narrow it anyway:

```jsonc
// A client that struggles with 212 tools, or a session scoped to one job.
"env": { "RENDER_MCP_TOOLSETS": "services,logs,metrics" }

// An agent that should be able to look but not touch.
"env": { "RENDER_MCP_READ_ONLY": "true" }
```

If you do narrow it, the model can still call `render_toolsets` to see what exists and re-enable a group. The server emits `notifications/tools/list_changed` and the new tools appear immediately — no restart.

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

### Updating to a new Render API version

Replace `spec/render-openapi.json`, then:

```bash
npm run generate   # rebuild the catalogue
git diff src/generated/operations.json
npm test
```

The generator refuses to emit a catalogue it cannot fully understand — an unmapped tag, a
name collision, a cyclic `$ref`, a path parameter missing from its template, or a body
property that would shadow a query parameter all fail the build. CI additionally asserts
that the committed catalogue matches what the spec produces, so a spec update without a
regenerate cannot merge.

### Releasing

Releases publish from CI via npm [Trusted Publishing](https://docs.npmjs.com/trusted-publishers),
using GitHub OIDC rather than a stored npm token, and carry a provenance attestation.

```bash
npm version patch    # or minor / major
git push --follow-tags
```

Pushing a `v*` tag runs `.github/workflows/publish.yml`, which verifies the tag matches
`package.json`, that the version is not already on npm, and that the generated catalogue is
current — then lints, type-checks, tests, builds and publishes.

If a release fails for a reason outside the code, re-run it from the Actions tab via
**Run workflow**, selecting the tag under _Use workflow from_. The workflow rejects
dispatches from a branch, so a published version always corresponds to a tag.

## License

MIT — see [LICENSE](LICENSE).

Not affiliated with Render. `spec/render-openapi.json` is Render's published API description, vendored so builds are reproducible.
