/**
 * Readable tool names for operations whose upstream `operationId` does not convert cleanly.
 *
 * The generator derives `render_<snake_case(operationId)>` by default, which handles both
 * kebab-case (`list-services`) and camelCase (`listTaskRuns`) ids. Only a few Render
 * operationIds resist that: some carry artefacts of the docs tooling (`resume-service-1`)
 * and some are grammatically odd (`post-job`, `list-job`).
 *
 * The generator throws when a derived name is not a valid identifier, so an unmapped
 * problematic operationId fails the build rather than shipping a broken tool name.
 */
export const TOOL_NAME_OVERRIDES: Readonly<Record<string, string>> = {
  // `-1` suffixes are docs-tooling artefacts of duplicated operation ids upstream.
  'resume-service-1': 'resume_service',
  'suspend-service-1': 'suspend_service',

  // Named after the HTTP verb rather than the resource action.
  'post-job': 'create_job',
  'list-job': 'list_jobs',
};
