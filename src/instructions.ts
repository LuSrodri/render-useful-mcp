/**
 * The server's `instructions` string, sent once in the `initialize` result.
 *
 * Per-tool descriptions can only ever describe one tool. What they cannot say is which of
 * 212 tools to reach for first, or that a name has to become an id before anything else
 * works — advice that would otherwise have to be repeated on every tool that needs it.
 * Saying it once here costs one short block per session instead.
 *
 * Kept to orientation and cross-tool rules. Anything true of exactly one operation belongs
 * in `OPERATION_HINTS`, where it is only paid for when that tool is visible.
 */
export const SERVER_INSTRUCTIONS = `
This server exposes the Render Public API (https://render.com) — services, deploys,
Postgres, Key Value, disks, environment groups, logs, metrics and blueprints.

Getting started
- Ids are typed prefixes: services \`srv-\`, deploys \`dep-\`, workspaces/owners \`tea-\` or
  \`usr-\`, Postgres \`dpg-\`, Key Value \`red-\`, environment groups \`evg-\`.
- Users say names, tools need ids. Call \`render_find_service\` first whenever a service is
  named rather than identified; it matches partial and approximate names.
- Workspace-scoped endpoints need an \`ownerId\`. It is filled in automatically when
  RENDER_WORKSPACE_ID is configured; otherwise get one from \`render_list_owners\`.

Preferred tools
- "Is X healthy?" / "why is X broken?" → \`render_service_status\` (config, deploys,
  instances and error logs in one call) rather than chaining retrieve/list/logs.
- Logs for one service → \`render_recent_logs\`, not \`render_list_logs\`.
- After any deploy-triggering call → \`render_wait_for_deploy\`, not a polling loop on
  \`render_retrieve_deploy\`.
- Cron jobs are services: create one with \`render_create_service\` and \`type\`:\`cron_job\`
  (its \`serviceDetails\` needs \`schedule\`, a five-field UTC cron expression), change its
  schedule with \`render_update_service\`, and trigger an off-schedule run with
  \`render_run_cron_job\`. \`render_create_job\` is a different thing — a one-off command on
  an existing service.

Working with the schemas
- Where an argument is a \`oneOf\`, each branch is titled with its name in Render's spec.
  Match the title to the sibling field that selects it: \`serviceDetails\` follows \`type\`
  (\`cron_job\` → cronJobDetailsPOST), and \`envSpecificDetails\` follows \`runtime\`
  (\`docker\` → dockerDetails, everything else → nativeEnvironmentDetails).
- PUT tools that take a collection replace it wholesale — read the current value first, or
  omitted members are deleted.

Failure and safety
- Errors come back with Render's own message plus a hint; read it before retrying, since a
  404 usually means an unresolved name and a 401 means the API key.
- Tools carry accurate destructive/read-only annotations. Deleting a service, database or
  disk is irreversible — confirm with the user before calling one.
- Large results are truncated with a note. Narrow the request rather than raising the cap.
`.trim();
