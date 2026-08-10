# render-useful-mcp

A Model Context Protocol server for [Render](https://render.com) that exposes **every endpoint of the official Render Public API**, plus a handful of higher-level tools for the workflows the raw API makes tedious.

Written in TypeScript. Every API tool is generated from Render's own OpenAPI document, so coverage is complete by construction and stays that way.

<!-- generated:tool-counts -->

**212 tools**: all 207 operations of the Render Public API (spec version 1.0.0), plus 5 workflow tools for the sequences the raw API makes tedious.
<!-- /generated:tool-counts -->

📖 **[Documentation site](https://lusrodri.github.io/render-useful-mcp/)** · [tool catalogue](https://lusrodri.github.io/render-useful-mcp/tools.html) · [llms.txt](https://lusrodri.github.io/render-useful-mcp/llms.txt)

---

## Why this one

Most API wrappers stop at a curated subset of endpoints, which drifts out of date and leaves you stuck the moment you need something the author skipped.

- **Complete, by construction.** Every operation in Render's own OpenAPI document becomes a tool. Everything the API allows your key to do is reachable out of the box — no opt-in required.
- **Usable by a model.** Names resolve to ids fuzzily, your workspace id is filled in automatically, deploys can be waited on in one call, and failures come back with a hint instead of a bare status code.
- **Narrowable when you want it.** Every toolset is on by default; `RENDER_MCP_TOOLSETS` and `RENDER_MCP_READ_ONLY` exist to restrict the surface deliberately, not to gate it.
- **Honest about risk.** MCP destructive/read-only/idempotent annotations are derived from real HTTP semantics, so clients can make sensible auto-approval decisions — including the `PUT`s that replace a whole collection, where everything the caller omits is deleted. Secrets are redacted from logs.

## Install

[![Install in VS Code](https://img.shields.io/badge/VS_Code-Install_server-0078d4?logo=visualstudiocode&logoColor=white)](https://insiders.vscode.dev/redirect/mcp/install?name=render&config=%7B%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22render-useful-mcp%22%5D%2C%22env%22%3A%7B%22RENDER_API_KEY%22%3A%22rnd_your_key_here%22%7D%7D)
[![Install in Cursor](https://img.shields.io/badge/Cursor-Install_server-000000?logo=cursor&logoColor=white)](https://cursor.com/link/mcp/install?name=render&config=%7B%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22render-useful-mcp%22%5D%2C%22env%22%3A%7B%22RENDER_API_KEY%22%3A%22rnd_your_key_here%22%7D%7D)

Both buttons prefill the config with a placeholder API key — replace it after install.

**Claude Code** — install it globally, so it is there in every project:

```shell
claude mcp add render --scope user -e RENDER_API_KEY=rnd_your_key -- npx -y render-useful-mcp
```

`--scope user` is the part that matters. Claude Code defaults to `local` scope, which
registers the server for the current directory only — so it works where you installed it and
is missing everywhere else, which is the usual reason a freshly added server seems to
disappear. The three scopes are:

| Scope         | Flag              | Where it lives           | Available in                    |
| ------------- | ----------------- | ------------------------ | ------------------------------- |
| User (global) | `--scope user`    | your user configuration  | every project, every directory  |
| Project       | `--scope project` | `.mcp.json`, committed   | anyone who checks the repo out  |
| Local         | none (default)    | per-directory user state | the directory it was added from |

Confirm with `claude mcp list`, and re-run the command with `--scope user` if `render` is
not listed from an unrelated directory.

**Claude Code**, as a plugin — this wires up the server and its docs in one step, and
plugins are installed globally by nature:

```shell
/plugin marketplace add LuSrodri/render-useful-mcp
/plugin install render-useful-mcp@lusrodri-render
```

Export `RENDER_API_KEY` in the shell that launches Claude Code; the plugin reads it from
the environment rather than storing it. See [`plugin/README.md`](plugin/README.md).

**Claude for macOS and Windows**, as a desktop extension — download the `.mcpb` bundle from
the [latest release](https://github.com/LuSrodri/render-useful-mcp/releases/latest) and open
it. Claude installs it and asks for the API key in a form, so nothing is configured by hand.
The bundle ships its own dependencies; it does not need npm or a global Node install.

Desktop installs default to the `services`, `logs` and `env-groups` toolsets rather than the
whole catalogue, because every tool definition costs context in every conversation. Set the
**Toolsets** field to `all`, or to any comma-separated list, to change that.

Requires Node.js ≥ 20.11 for every install route except the desktop extension.

```bash
npm install -g render-useful-mcp
```

Or run it without installing, which is what most MCP client configs do:

```bash
npx -y render-useful-mcp
```

It is also listed in the [MCP Registry](https://registry.modelcontextprotocol.io) as
`io.github.LuSrodri/render-useful-mcp`, so clients that browse the registry can find and
configure it without being pointed at the npm package by hand.

## Configure your MCP client

Get an API key from **Render Dashboard → Account Settings → API Keys**.

**Claude Code** — globally, as above:

```bash
claude mcp add render --scope user -e RENDER_API_KEY=rnd_your_key -- npx -y render-useful-mcp
```

Add `RENDER_WORKSPACE_ID` the same way if you know it:

```bash
claude mcp add render --scope user \
  -e RENDER_API_KEY=rnd_your_key \
  -e RENDER_WORKSPACE_ID=tea_your_workspace_id \
  -- npx -y render-useful-mcp
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

| Variable                        | Default                     | Description                                                              |
| ------------------------------- | --------------------------- | ------------------------------------------------------------------------ |
| `RENDER_API_KEY`                | —                           | **Required.** Your Render API key.                                       |
| `RENDER_WORKSPACE_ID`           | —                           | Workspace id applied wherever an `ownerId` is needed and none was given. |
| `RENDER_MCP_TOOLSETS`           | `all`                       | Narrow the surface to a comma-separated list of toolsets.                |
| `RENDER_MCP_READ_ONLY`          | `false`                     | When true, only non-mutating (GET) tools are exposed at all.             |
| `RENDER_MCP_DYNAMIC_TOOLSETS`   | `true`                      | Registers `render_toolsets`, which reports the toolsets and their state. |
| `RENDER_MCP_TIMEOUT_MS`         | `60000`                     | Per-request timeout.                                                     |
| `RENDER_MCP_MAX_RETRIES`        | `3`                         | Retries for rate limits and transient server errors.                     |
| `RENDER_MCP_MAX_RESPONSE_BYTES` | `400000`                    | Tool results larger than this are truncated with a note.                 |
| `RENDER_MCP_LOG_LEVEL`          | `info`                      | `debug`, `info`, `warn`, `error`, `silent`. Logs go to stderr.           |
| `RENDER_API_BASE_URL`           | `https://api.render.com/v1` | Override for proxies or testing.                                         |

## Toolsets

<!-- generated:toolset-count -->

**All 17 toolsets are enabled by default**
<!-- /generated:toolset-count --> — the server exposes everything your API key is allowed to reach. Toolsets are a way to _narrow_ the surface on purpose, not a gate you have to unlock.

<!-- generated:toolset-table -->

| Toolset        | Tools | Covers                                                                          |
| -------------- | ----- | ------------------------------------------------------------------------------- |
| `services`     | 42    | Services, deploys, custom domains, one-off jobs, cron job runs and events       |
| `metrics`      | 23    | CPU, memory, bandwidth, HTTP, disk and connection metrics, plus metrics streams |
| `postgres`     | 21    | Postgres instances, users, exports, recovery and query insights                 |
| `workflows`    | 15    | Render Workflows and workflow tasks (public beta)                               |
| `env-groups`   | 13    | Environment groups, their variables and secret files                            |
| `projects`     | 12    | Projects and environments                                                       |
| `webhooks`     | 11    | Webhooks and notification settings/overrides                                    |
| `logs`         | 10    | Log queries, label discovery and log stream configuration                       |
| `static-sites` | 9     | Header rules and redirect/rewrite routes for static sites                       |
| `deprecated`   | 8     | Legacy Redis endpoints that Render has superseded by the Key Value API          |
| `key-value`    | 8     | Key Value (Redis-compatible) instances and connection info                      |
| `workspaces`   | 8     | Workspaces, members, the authenticated user and audit logs                      |
| `disks`        | 7     | Persistent disks and their snapshots                                            |
| `blueprints`   | 6     | Blueprints and Blueprint syncs                                                  |
| `network`      | 5     | Dedicated outbound IP sets                                                      |
| `registry`     | 5     | Container registry credentials                                                  |
| `maintenance`  | 4     | Scheduled maintenance runs                                                      |

<!-- /generated:toolset-table -->

Reasons you might narrow it anyway:

```jsonc
// A client that struggles with the full catalogue, or a session scoped to one job.
"env": { "RENDER_MCP_TOOLSETS": "services,logs,metrics" }

// An agent that should be able to look but not touch.
"env": { "RENDER_MCP_READ_ONLY": "true" }
```

If you do narrow it, the model can still call `render_toolsets` to see everything that exists and which groups are switched off, so it can tell you exactly what to change. Widening the surface means editing `RENDER_MCP_TOOLSETS` and restarting the server: protocol revision `2026-07-28` requires the result of `tools/list` not to vary per connection or as a side effect of another call, so the enabled set is fixed at startup.

## Tools

### Workflow tools

These are always available, in any toolset configuration. They exist because the equivalent raw sequence is several calls the model usually gets wrong on the first try.

<!-- generated:workflow-tools -->

| Tool                     | What it does                                                                                                                             |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `render_find_service`    | Resolves a service name — including a partial or approximate one — to a single Render service, returning its id plus close alternatives. |
| `render_recent_logs`     | Fetches recent log lines for a service, resolving the service name and workspace id for you.                                             |
| `render_service_status`  | One-call triage for a service: its configuration, latest deploys, running instances and most recent error-level logs.                    |
| `render_toolsets`        | Lists every Render toolset with its tool count and whether it is currently enabled.                                                      |
| `render_wait_for_deploy` | Polls a deploy until it reaches a terminal state (live, build_failed, update_failed, canceled, deactivated) or the timeout expires.      |

<!-- /generated:workflow-tools -->

### API tools

One per Render endpoint, named `render_<operation_id>` — `render_list_services`, `render_create_deploy`, `render_update_postgres`, and so on. Each carries the summary, description, parameter docs, enums and constraints straight from Render's spec. The full list is on the [tool catalogue page](https://lusrodri.github.io/render-useful-mcp/tools.html).

### Making the tools usable by a model

A generated tool is only as good as what the spec says about it, and Render's spec describes shapes rather than usage. Three things close that gap:

**`oneOf` branches keep their names, and say which one applies.** Dereferencing a `$ref` normally throws away the schema's name, which leaves `serviceDetails` on `render_create_service` as five structurally similar anonymous objects with nothing to say which one goes with which `type`. Each branch now carries its name from Render's spec as a `title`, so `cron_job` → `cronJobDetailsPOST` and `runtime: docker` → `dockerDetails` are decisions a model can actually make.

Naming the branches makes the choice readable but not checkable, and Render's spec carries no `discriminator`: under `oneOf`'s exactly-one rule, a branch that requires nothing — `staticSiteDetailsPOST` — accepts every payload, which leaves the other four unreachable. [`src/tools/schema-unions.ts`](src/tools/schema-unions.ts) rewrites those unions into `if`/`then` rules keyed on the property that selects them, so the mapping is part of the schema rather than advice in a description, and a wrong-branch field is rejected by name instead of as `must match exactly one schema in oneOf`. A build invariant fails the generator if any `oneOf` branch is left unreachable, and `test/payloads.test.ts` checks the property against real payloads for all 207 tools.

**Fields no caller can fill are removed.** Render's spec reuses response schemas inside request bodies in a couple of places, which drags in values the server generates: a cron job's Docker branch asks for a whole `registryCredential` object requiring the credential's `id` and the timestamp of its last change, where a web service takes a plain `registryCredentialId`. A field that can only be filled with invented values is worse than no field, so [`src/tools/schema-repairs.ts`](src/tools/schema-repairs.ts) drops it and the usage note points at `image.registryCredentialId`, which is where Render actually takes the reference. The generator throws if an entry stops matching, so a fix upstream shows up as a build failure.

**A few tools carry hand-written usage notes.** [`src/tools/operation-hints.ts`](src/tools/operation-hints.ts) appends a `Usage:` paragraph to the operations models demonstrably get wrong — `create-service` gets complete worked examples, `update-env-vars-for-service` warns that it replaces the whole set, `post-job` says it is _not_ how you create a cron job. Examples are data, not prose: every one is validated against its own tool schema by the test suite and rendered into the description from the same object, so a published example is one the server provably accepts. The generator throws if a hint names an operation Render has withdrawn, so the file cannot rot silently.

**The server sends `instructions`.** [`src/instructions.ts`](src/instructions.ts) is delivered once at `initialize`: id prefixes, resolve-the-name-first, which workflow tool replaces which raw sequence, and the `oneOf` convention. Cross-tool advice belongs there rather than duplicated into every tool description that needs it.

#### Creating a cron job that runs a Docker image

The case that motivated all three. A cron job is a service, so:

```jsonc
// render_create_service
{
  "type": "cron_job",
  "name": "nightly-report",
  "ownerId": "tea-…",
  "repo": "https://github.com/acme/reports",
  "branch": "main",
  "serviceDetails": {
    // the cronJobDetailsPOST branch
    "runtime": "docker",
    "schedule": "0 3 * * *", // five-field cron, UTC, required for cron jobs
    "plan": "starter",
    "region": "oregon",
    "envSpecificDetails": {
      // the dockerDetails branch, because runtime is docker
      "dockerfilePath": "./Dockerfile",
      "dockerContext": ".",
      "dockerCommand": "python report.py",
    },
  },
}
```

For a prebuilt image instead of a build, drop `repo`/`branch`, set `image` to `{"ownerId": "tea-…", "imagePath": "docker.io/acme/reports:latest"}`, use `"runtime": "image"`, and give `envSpecificDetails` only the `dockerCommand`. Change the schedule later with `render_update_service`; trigger an off-schedule run with `render_run_cron_job`. `render_create_job` is a different thing — a one-off command on an existing service.

## Design notes

**Generated, not hand-written.** `scripts/generate-operations.ts` reads `spec/render-openapi.json` and emits the tool catalogue. It is strict: an unmapped tag, a name collision, a cyclic `$ref`, a path parameter missing from its template, or a body property that would shadow a query parameter all fail the build rather than producing a subtly wrong tool. Updating to a new Render API version is: drop in the new spec, run `npm run generate`, review the diff.

**Schemas reach the client intact.** Render's spec uses the full range of JSON Schema. Tool schemas are fully dereferenced and passed through, and Ajv validates arguments against them — so enums, patterns, formats and `oneOf` are all actually enforced. This is why the server uses the SDK's low-level `Server` rather than `McpServer`, which accepts only Zod schemas. The one deliberate rewrite is the undiscriminated unions described above: left as the spec writes them, they cannot be satisfied at all.

**Bodies are flattened.** Request-body properties become top-level tool arguments, which keeps call sites shallow and improves tool-call accuracy. The generator proves at build time that body properties never collide with path or query parameters. The six array- and `oneOf`-valued bodies keep their structure under a single `body` argument.

**Errors are made actionable.** A failure returns the HTTP status, Render's own message and a hint aimed at the actual cause — a 404 suggests confirming the id with a list call, a 401 points at the API key page. A tool that is registered but hidden says which toolset to enable rather than "unknown tool".

**Retries are conservative.** Rate limits and transient 5xx are retried with decorrelated-jitter backoff, honouring `Retry-After`. Non-idempotent methods are never replayed on a server error: a retried `POST /deploys` would deploy twice.

**Secrets stay out of logs.** Logging is structured JSON on stderr — stdout is the transport — with connection strings, API keys and tokens redacted.

## Development

```bash
npm install
npm run generate    # rebuild the tool catalogue from the OpenAPI spec
npm run docs        # re-render every doc that quotes the catalogue
npm run build
npm test
npm run check       # generate + docs + lint + typecheck + test
```

### Documentation is generated too

Tool counts, the toolset table, the workflow-tool list, the whole
[docs site](https://lusrodri.github.io/render-useful-mcp/), `llms.txt` and `llms-full.txt`
are all rendered from `src/generated/operations.json` by `scripts/generate-docs.ts`. Regions
between `<!-- generated:key -->` markers in this file and `plugin/README.md` are rewritten in
place; the site's files are written whole.

`npm run docs:check` re-renders everything and fails if it differs from what is committed.
CI runs it on every pull request, the Pages workflow runs it before deploying, and the spec
sync runs `npm run docs` so an API change and the prose describing it arrive in one
reviewable pull request. Numbers in the docs cannot silently drift from the catalogue —
which they had, before this existed.

The test suite covers catalogue invariants (all 207 operations, no dangling `$ref`, path params required, annotations match HTTP semantics), request mapping, retry and pagination behaviour, the composite tools, and a full in-memory MCP client/server round trip.

### Building the desktop extension

```bash
npm run build:mcpb   # -> build/render-useful-mcp-<version>.mcpb
```

This stages `dist/` plus the production dependency tree into `build/mcpb/` and packs it.
The bundle is self-contained by design — Claude runs it with no install step — so the
dependencies are copied out of this repository's `node_modules` rather than reinstalled,
which is what guarantees the artefact contains the tree the test suite actually ran on.

`manifest.json` at the repository root is the extension's manifest; `npm version` keeps its
version in step with the package. To inspect a built bundle:

```bash
npx mcpb info build/render-useful-mcp-<version>.mcpb
npx mcpb unpack build/render-useful-mcp-<version>.mcpb /tmp/check
```

### Updating to a new Render API version

This is automated. `.github/workflows/spec-sync.yml` runs daily, fetches Render's current
API description, regenerates the catalogue **and the documentation**, and opens a pull
request when the set of tools actually changes — with a summary of which tools were added,
removed or changed shape, and a warning when the change is breaking. Nothing merges
automatically.

Every run writes to its job summary, including the runs that find nothing, so "did it check
today?" is answerable from the Actions tab rather than inferred from the absence of a pull
request.

Two details of the schedule are deliberate, and both come from the job appearing dead while
it was in fact working:

- **`47 5 * * *`, not `0 6 * * 1`.** GitHub queues scheduled workflows best-effort and drops
  them under load; the top of the hour is the most contended slot there is. The one
  observed scheduled run started nearly four hours late. Daily, at an unremarkable minute,
  makes a dropped run cost a day rather than a fortnight — and a run that finds no catalogue
  change exits early, so the cost of daily is a few seconds of CI.
- **`.github/spec-sync-heartbeat.json`.** GitHub disables scheduled workflows in
  repositories that go 60 days without activity, and a disabled workflow cannot re-enable
  itself. The workflow commits a timestamp to that file whenever the recorded one is more
  than 20 days old — roughly 18 commits a year, which keeps the clock well clear of the
  limit and leaves a visible record in the git log that the routine is alive.

To do it by hand, or to check right now:

```bash
npm run sync-spec   # fetch the current spec into spec/render-openapi.json
npm run generate    # rebuild the catalogue from it
git diff src/generated/operations.json
npm test
```

Render does not serve its OpenAPI document from a stable URL — the documented `.json` and
`.yaml` endpoints 404 — so `scripts/fetch-spec.ts` extracts it from the docs HTML. That is
fragile by nature, so it validates what it extracts (title, server, minimum operation
count) and fails loudly rather than overwriting a good spec with a truncated one. If Render
changes their docs platform, the sync workflow goes red instead of quietly reporting "no
changes" forever.

The generator refuses to emit a catalogue it cannot fully understand — an unmapped tag, a
name collision, a cyclic `$ref`, a path parameter missing from its template, or a body
property that would shadow a query parameter all fail the build. CI additionally asserts
that the committed catalogue matches what the spec produces, so a spec update without a
regenerate cannot merge.

### Releasing

A release publishes to two places: the package to npm, and metadata describing it to the
[MCP Registry](https://registry.modelcontextprotocol.io). Both authenticate with the
workflow's GitHub OIDC token — npm via
[Trusted Publishing](https://docs.npmjs.com/trusted-publishers), the registry via
`mcp-publisher login github-oidc` — so no npm token or registry secret is stored anywhere.
The npm publish carries a provenance attestation.

```bash
npm version patch    # or minor / major
git push --follow-tags
```

Pushing a `v*` tag runs `.github/workflows/publish.yml`, which verifies the tag matches
`package.json` and that the generated catalogue **and documentation** are current, works out
which of the two targets still need this version, then lints, type-checks, tests, builds and
publishes. It also builds the `.mcpb` bundle and attaches it to the GitHub Release, which is
the only place the desktop extension is distributed from.

The documentation check is repeated here rather than left to CI because `README.md` ships
inside the npm tarball and a tag can be cut from any commit. npm versions are immutable, so
a package whose README contradicts the catalogue beside it cannot be taken back.

The order is fixed: npm first, then the registry. The registry proves you own the package
by fetching the published tarball and looking for `mcpName` in its `package.json`, so it
cannot accept a version npm has not served yet.

If a release fails for a reason outside the code, re-run it from the Actions tab via
**Run workflow**, selecting the tag under _Use workflow from_. Each target is checked
independently, so a retry after a half-finished release skips whatever already succeeded
instead of failing on npm's immutable versions. The workflow rejects dispatches from a
branch, so a published version always corresponds to a tag.

#### The registry manifest

`server.json` is the registry's copy of this server's metadata. Two of its fields are load
bearing and both are asserted by `test/server-json.test.ts`:

- `name` must be `io.github.LuSrodri/...`. The registry derives the namespace you may
  publish to from the OIDC token's `repository_owner` claim and compares it case
  sensitively, so the lowercased spelling is rejected with a 403.
- `mcpName` in `package.json` must equal that same name. It is the ownership proof
  described above; without it the registry refuses the package.

The version fields track `package.json` — `npm version` keeps them in step via the `version`
lifecycle script, so `mcp-publisher publish` also works from a clean local checkout. CI
stamps them from the tag again before publishing, so the tag is what decides what ships.

## Privacy

No telemetry, no analytics, no backend. The server runs on your machine and contacts exactly
one host — Render's API. Your key is read from the environment, sent only to Render, never
written to disk, and redacted from log output. Full detail, including how to verify each
claim yourself: [PRIVACY.md](PRIVACY.md).

## License

MIT — see [LICENSE](LICENSE).

Not affiliated with Render. `spec/render-openapi.json` is Render's published API description, vendored so builds are reproducible.
