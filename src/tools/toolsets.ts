/**
 * Toolsets group the 207 generated tools into coherent, independently switchable bundles.
 *
 * Exposing all of them at once costs a lot of context and measurably degrades tool
 * selection, so the server ships a sensible default and lets callers opt in to the rest
 * either up front (`RENDER_MCP_TOOLSETS`) or at runtime (`render_toolsets`).
 */

export const TOOLSET_IDS = [
  'services',
  'static-sites',
  'postgres',
  'key-value',
  'disks',
  'env-groups',
  'projects',
  'blueprints',
  'logs',
  'metrics',
  'webhooks',
  'workspaces',
  'registry',
  'network',
  'maintenance',
  'workflows',
  'deprecated',
] as const;

export type ToolsetId = (typeof TOOLSET_IDS)[number];

export const TOOLSET_DESCRIPTIONS: Readonly<Record<ToolsetId, string>> = {
  services: 'Services, deploys, custom domains, one-off jobs, cron job runs and events.',
  'static-sites': 'Header rules and redirect/rewrite routes for static sites.',
  postgres: 'Postgres instances, users, exports, recovery and query insights.',
  'key-value': 'Key Value (Redis-compatible) instances and connection info.',
  disks: 'Persistent disks and their snapshots.',
  'env-groups': 'Environment groups, their variables and secret files.',
  projects: 'Projects and environments.',
  blueprints: 'Blueprints and Blueprint syncs.',
  logs: 'Log queries, label discovery and log stream configuration.',
  metrics: 'CPU, memory, bandwidth, HTTP, disk and connection metrics, plus metrics streams.',
  webhooks: 'Webhooks and notification settings/overrides.',
  workspaces: 'Workspaces, members, the authenticated user and audit logs.',
  registry: 'Container registry credentials.',
  network: 'Dedicated outbound IP sets.',
  maintenance: 'Scheduled maintenance runs.',
  workflows: 'Render Workflows and workflow tasks (public beta).',
  deprecated: 'Legacy Redis endpoints that Render has superseded by the Key Value API.',
};

/**
 * Enabled when the caller does not choose explicitly: everything.
 *
 * The server's purpose is to expose as much of the Render API as the key is allowed to
 * reach, so withholding endpoints by default would be the wrong trade. Toolsets exist to
 * let a caller *narrow* the surface — via `RENDER_MCP_TOOLSETS` — not to gate it.
 */
export const DEFAULT_TOOLSETS: readonly ToolsetId[] = TOOLSET_IDS;

/**
 * Maps every OpenAPI tag in the Render spec onto a toolset.
 *
 * The generator fails loudly on an unmapped tag, so a new Render API section can never
 * silently disappear from the catalogue.
 */
export const TOOLSET_BY_TAG: Readonly<Record<string, ToolsetId>> = {
  Services: 'services',
  Deploys: 'services',
  'Custom Domains': 'services',
  'One-Off Jobs': 'services',
  'Services - Cron Jobs': 'services',
  Events: 'services',
  'Services - Headers': 'static-sites',
  'Services - Routes': 'static-sites',
  Postgres: 'postgres',
  'Key Value': 'key-value',
  Disks: 'disks',
  'Environment Groups': 'env-groups',
  'Projects & Environments': 'projects',
  Blueprints: 'blueprints',
  Logs: 'logs',
  Metrics: 'metrics',
  Webhooks: 'webhooks',
  'Notification Settings': 'webhooks',
  Workspaces: 'workspaces',
  Users: 'workspaces',
  'Audit Logs': 'workspaces',
  'Registry Credentials': 'registry',
  'Dedicated IPs': 'network',
  Maintenance: 'maintenance',
  'Workflows (Beta)': 'workflows',
  'Workflow Tasks (Beta)': 'workflows',
  'Redis (Deprecated)': 'deprecated',
};

export function isToolsetId(value: string): value is ToolsetId {
  return (TOOLSET_IDS as readonly string[]).includes(value);
}
