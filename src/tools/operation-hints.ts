/**
 * Hand-written usage notes appended to the descriptions of operations that models get wrong.
 *
 * Render's spec describes shapes, not usage. That is enough for an endpoint a caller has
 * already read the guide for, and not enough for a model choosing between five structurally
 * similar `oneOf` branches on its first attempt. Every hint here exists because the
 * spec-derived description alone leaves a decision unmade — which branch, which sibling
 * field, which tool to reach for instead.
 *
 * Deliberately small. A hint costs context in every conversation that lists tools, so the
 * bar is "a capable model gets this wrong without it", not "this is worth knowing".
 *
 * Keys are upstream `operationId`s, not tool names, so they survive a rename in
 * `TOOL_NAME_OVERRIDES`. The generator throws on a key matching no operation, which is what
 * keeps this file from rotting silently as Render's API moves.
 */
export const OPERATION_HINTS: Readonly<Record<string, string>> = {
  'create-service': [
    'Pick the `serviceDetails` branch whose title matches `type`:',
    '`static_site`→staticSiteDetailsPOST, `web_service`→webServiceDetailsPOST,',
    '`private_service`→privateServiceDetailsPOST, `background_worker`→backgroundWorkerDetailsPOST,',
    '`cron_job`→cronJobDetailsPOST. Source comes from either `repo` (+`branch`) for a build,',
    'or `image` for a prebuilt container — never both. Inside `serviceDetails`,',
    '`envSpecificDetails` follows `runtime`: use the dockerDetails branch',
    '(`dockerfilePath`, `dockerContext`, `dockerCommand`) when `runtime` is `docker`, and the',
    'nativeEnvironmentDetails branch (`buildCommand`, `startCommand`) for every language runtime.',
    'Example — a cron job that builds from a Dockerfile and runs every day at 03:00 UTC:',
    '{"type":"cron_job","name":"nightly-report","ownerId":"tea-…",',
    '"repo":"https://github.com/acme/reports","branch":"main",',
    '"serviceDetails":{"runtime":"docker","schedule":"0 3 * * *","plan":"starter","region":"oregon",',
    '"envSpecificDetails":{"dockerfilePath":"./Dockerfile","dockerContext":".","dockerCommand":"python report.py"}}}.',
    'For a cron job running a prebuilt image, drop `repo`/`branch`, set',
    '`image` to {"ownerId":"tea-…","imagePath":"docker.io/acme/reports:latest"}, keep',
    '`runtime`:`image`, and give `envSpecificDetails` only the `dockerCommand` to run.',
    '`schedule` is a standard five-field cron expression in UTC and is required for cron jobs.',
    'Creating a service starts a first deploy; follow with render_wait_for_deploy.',
  ].join(' '),

  'update-service': [
    '`serviceDetails` branches are the PATCH variants of the same five service types, and the',
    "branch must still match the service's existing `type` — a service cannot change type.",
    'Send only the fields you are changing; omitted fields keep their current values.',
    "Changing a cron job's `schedule` or a service's build settings does not itself deploy —",
    'call render_create_deploy afterwards when the change needs a rebuild.',
  ].join(' '),

  'run-cron-job': [
    "Triggers an immediate, out-of-schedule run. `cronJobId` is the cron job service's own id",
    '(`srv-…`, or `crn-…` on older workspaces) — resolve it with render_find_service. This',
    'does not change the schedule; use render_update_service for that.',
  ].join(' '),

  'post-job': [
    'Starts a one-off job on an existing service, reusing its image and environment. This is',
    'not how you create a cron job — a cron job is a service (render_create_service with',
    '`type`:`cron_job`), and render_run_cron_job triggers one off-schedule.',
  ].join(' '),

  'create-deploy': [
    'Omit `commitId`/`imageUrl` to deploy the branch tip or the current image. `clearCache`:',
    '`clear` forces a rebuild from scratch and is the first thing to try when a build fails',
    'for no visible reason. Returns as soon as the deploy is queued, so follow with',
    'render_wait_for_deploy rather than polling render_retrieve_deploy.',
  ].join(' '),

  'rollback-deploy': [
    '`deployId` must be a previously successful deploy of this same service — list candidates',
    'with render_list_deploys and pick one whose status is `live`.',
  ].join(' '),

  'update-env-vars-for-service': [
    "This replaces the service's entire environment variable set: anything absent from `body`",
    'is deleted. To change one variable, read the current set with',
    'render_get_env_vars_for_service and send it back with your edit applied, or use',
    'render_update_env_var for a single key. Applying changes restarts the service.',
  ].join(' '),

  'update-secret-files-for-service': [
    'Replaces the full set of secret files; omitted files are deleted. Read the current set',
    'with render_list_secret_files_for_service first.',
  ].join(' '),

  'list-services': [
    'Filters are ANDed, and `name` matches as a substring rather than exactly. When the user',
    'named one service, render_find_service resolves it in a single call and handles',
    'approximate names; reach for this tool to enumerate or filter in bulk.',
  ].join(' '),

  'list-logs': [
    'Requires an `ownerId` and a `resource` array of ids. For the common case — recent logs',
    'for one service — render_recent_logs takes a service name and fills both in.',
  ].join(' '),

  'create-postgres': [
    '`version` is a major version as a string (e.g. "16"). Plans and their disk sizes come',
    'from render_list_postgres_sizes. The generated password appears only in the creation',
    'response; afterwards, read credentials with render_retrieve_postgres_connection_info.',
  ].join(' '),

  'create-key-value': [
    "Key Value is Render's Redis-compatible store and supersedes the `deprecated` toolset's",
    'Redis endpoints. Read credentials with render_retrieve_key_value_connection_info; the',
    'connection string is not returned by list or retrieve.',
  ].join(' '),

  'validate-blueprint': [
    'Pass the `render.yaml` contents as text in `file` — a path is not read for you. Validate',
    'before render_update_blueprint, which syncs whatever is in the repository.',
  ].join(' '),

  'scale-service': [
    'Sets a fixed instance count and turns off autoscaling. To scale on load instead, use',
    'render_autoscale_service.',
  ].join(' '),

  'list-owners': [
    'Returns the workspaces (`tea-…` ids) your API key can reach. Set RENDER_WORKSPACE_ID to',
    'the one you use so every tool needing an `ownerId` stops asking.',
  ].join(' '),
};
