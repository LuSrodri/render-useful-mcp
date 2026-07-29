# Privacy Policy

**Last updated: 29 July 2026**

`render-useful-mcp` is an open-source MCP server that runs entirely on your own machine. It
collects nothing, transmits nothing to its author, and has no backend.

This document describes exactly where your data goes, so you can verify it against the
source rather than take it on trust.

## What this software collects

Nothing. There is no telemetry, no analytics, no crash reporting, no usage counter, and no
"phone home" of any kind. The author receives no data from your use of this software, and
has no way to.

## Where your data goes

The server runs as a local process started by your MCP client. It makes network requests to
exactly one destination:

- **`https://api.render.com/v1`** — Render's official Public API, or whatever you set
  `RENDER_API_BASE_URL` to.

That is the only host contacted. You can confirm this yourself:

```bash
grep -rn "fetch(" src/ | grep -v generated
```

Every request goes through a single client (`src/render/client.ts`) built against the base
URL from your configuration. There is no second code path.

## Your Render API key

Your key is read from the `RENDER_API_KEY` environment variable at startup and held in
memory for the lifetime of the process. It is:

- **Sent only to Render**, as the `Authorization` header on requests to the API base URL.
- **Never written to disk** by this software — not to a config file, cache, or log.
- **Never included in log output.** Log context is passed through a redactor
  (`src/logging.ts`) that replaces the values of `apikey`, `api_key`, `authorization`,
  `password`, `secret`, `token`, and every connection-string field with `***`.

Diagnostics are written to `stderr` only, because `stdout` carries the protocol. Nothing is
written to a log file.

## Data from Render

Responses from the Render API — service configuration, deploy history, logs, metrics,
database connection details — are returned to your MCP client so the model can use them.
They are not stored, cached to disk, or forwarded anywhere else by this software.

Be aware that this means Render data enters your AI client's context, and is therefore
subject to your client provider's own terms and privacy policy. That is inherent to what an
MCP server does. Two controls are worth knowing:

- `RENDER_MCP_READ_ONLY=true` exposes only non-mutating tools, so the server can read but
  never change anything.
- `RENDER_MCP_TOOLSETS` narrows which parts of the API are reachable at all.

Some Render endpoints return secrets by design — environment group variables, secret files,
and Postgres connection strings. Tools that reach them are subject to the same controls
above, and their values are redacted from this server's own logs, but the response content
does reach your client. Consider `RENDER_MCP_TOOLSETS` if that matters for your use.

## Third parties

None. Runtime dependencies are `@modelcontextprotocol/server`, `ajv`, `ajv-formats` and
`zod` — all libraries that execute locally and open no connections of their own.

The package is published to npm with build provenance attestation, so you can verify that
the published artifact was built from this repository.

## Children

This software is a developer tool and is not directed at children.

## Changes

Material changes to this policy will be recorded in this file, with the date above updated.
Its history is public in this repository.

## Contact

Questions or concerns: open an issue at
<https://github.com/LuSrodri/render-useful-mcp/issues>.
