/**
 * Environment-driven configuration.
 *
 * All configuration is read once at startup and validated eagerly: an MCP server that
 * fails on its first tool call rather than at launch is much harder for a user to debug,
 * because stdio servers hide their output behind the client.
 */
import { z } from 'zod';

import { ConfigurationError } from './errors.js';
import { DEFAULT_TOOLSETS, TOOLSET_IDS, isToolsetId, type ToolsetId } from './tools/toolsets.js';

export const LOG_LEVELS = ['debug', 'info', 'warn', 'error', 'silent'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

export interface Config {
  readonly apiKey: string;
  readonly baseUrl: string;
  /** Injected as `ownerId` whenever a tool needs a workspace and the caller omitted one. */
  readonly defaultOwnerId: string | undefined;
  readonly toolsets: ReadonlySet<ToolsetId>;
  readonly readOnly: boolean;
  /** Registers the `render_toolsets` meta-tool. */
  readonly dynamicToolsets: boolean;
  readonly requestTimeoutMs: number;
  readonly maxRetries: number;
  /** Tool results larger than this are truncated with an explanatory note. */
  readonly maxResponseBytes: number;
  readonly logLevel: LogLevel;
  readonly userAgent: string;
}

const booleanFromEnv = z
  .string()
  .transform((value) => value.trim().toLowerCase())
  .refine((value) => ['1', 'true', 'yes', 'on', '0', 'false', 'no', 'off', ''].includes(value), {
    message: 'expected a boolean such as "true" or "false"',
  })
  .transform((value) => ['1', 'true', 'yes', 'on'].includes(value));

function positiveIntFromEnv(min: number, max: number): z.ZodType<number, string> {
  return z
    .string()
    .transform((value) => Number(value.trim()))
    .refine((value) => Number.isInteger(value) && value >= min && value <= max, {
      message: `expected an integer between ${min} and ${max}`,
    });
}

const envSchema = z.object({
  RENDER_API_KEY: z.string().trim().min(1, 'must not be empty').optional(),
  RENDER_API_BASE_URL: z.url({ message: 'must be a valid URL' }).optional(),
  RENDER_WORKSPACE_ID: z.string().trim().min(1).optional(),
  RENDER_MCP_TOOLSETS: z.string().optional(),
  RENDER_MCP_READ_ONLY: booleanFromEnv.optional(),
  RENDER_MCP_DYNAMIC_TOOLSETS: booleanFromEnv.optional(),
  RENDER_MCP_TIMEOUT_MS: positiveIntFromEnv(1_000, 600_000).optional(),
  RENDER_MCP_MAX_RETRIES: positiveIntFromEnv(0, 10).optional(),
  RENDER_MCP_MAX_RESPONSE_BYTES: positiveIntFromEnv(1_024, 10_000_000).optional(),
  RENDER_MCP_LOG_LEVEL: z.enum(LOG_LEVELS).optional(),
});

export interface LoadConfigOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly version: string;
}

export function loadConfig({ env = process.env, version }: LoadConfigOptions): Config {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ');
    throw new ConfigurationError(`Invalid environment configuration: ${issues}`);
  }
  const raw = parsed.data;

  if (!raw.RENDER_API_KEY) {
    throw new ConfigurationError(
      'RENDER_API_KEY is not set.',
      'Create an API key at https://dashboard.render.com/u/settings#api-keys and expose it to the MCP server ' +
        'via the "env" block of your client configuration.',
    );
  }

  return {
    apiKey: raw.RENDER_API_KEY,
    baseUrl: (raw.RENDER_API_BASE_URL ?? 'https://api.render.com/v1').replace(/\/+$/, ''),
    defaultOwnerId: raw.RENDER_WORKSPACE_ID,
    toolsets: parseToolsets(raw.RENDER_MCP_TOOLSETS),
    readOnly: raw.RENDER_MCP_READ_ONLY ?? false,
    dynamicToolsets: raw.RENDER_MCP_DYNAMIC_TOOLSETS ?? true,
    requestTimeoutMs: raw.RENDER_MCP_TIMEOUT_MS ?? 60_000,
    maxRetries: raw.RENDER_MCP_MAX_RETRIES ?? 3,
    maxResponseBytes: raw.RENDER_MCP_MAX_RESPONSE_BYTES ?? 400_000,
    logLevel: raw.RENDER_MCP_LOG_LEVEL ?? 'info',
    userAgent: `render-useful-mcp/${version} (+https://github.com/LuSrodri/render-useful-mcp)`,
  };
}

/**
 * Parses `RENDER_MCP_TOOLSETS`: a comma-separated list, or `all`, or unset for the default.
 */
export function parseToolsets(value: string | undefined): ReadonlySet<ToolsetId> {
  if (value === undefined || value.trim() === '') {
    return new Set(DEFAULT_TOOLSETS);
  }

  const requested = value
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry !== '');

  if (requested.includes('all')) {
    return new Set(TOOLSET_IDS);
  }

  const selected = new Set<ToolsetId>();
  const unknown: string[] = [];
  for (const entry of requested) {
    if (isToolsetId(entry)) selected.add(entry);
    else unknown.push(entry);
  }

  if (unknown.length > 0) {
    throw new ConfigurationError(
      `Unknown toolset(s) in RENDER_MCP_TOOLSETS: ${unknown.join(', ')}.`,
      `Valid values are "all" or any of: ${TOOLSET_IDS.join(', ')}.`,
    );
  }
  if (selected.size === 0) {
    throw new ConfigurationError(
      'RENDER_MCP_TOOLSETS was set but selected no toolsets.',
      `Use "all", or a comma-separated subset of: ${TOOLSET_IDS.join(', ')}.`,
    );
  }
  return selected;
}
