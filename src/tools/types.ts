/**
 * The contract every tool implements, regardless of whether it was generated from the
 * OpenAPI spec or hand-written as a higher-level workflow.
 *
 * A single shared shape lets the server treat both kinds identically for listing,
 * validation, policy enforcement and result formatting.
 */
import type { JsonSchema } from '../generated/types.js';
import type { Config } from '../config.js';
import type { Logger } from '../logging.js';
import type { RenderClient } from '../render/client.js';
import type { ToolsetId } from './toolsets.js';

export interface ToolContext {
  readonly client: RenderClient;
  readonly config: Config;
  readonly logger: Logger;
  readonly signal: AbortSignal | undefined;
  /**
   * Invokes another registered tool. Lets composite tools reuse generated ones instead of
   * duplicating request-shaping logic.
   */
  readonly callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
}

/**
 * MCP tool annotations. Purely advisory, but clients use them to decide what to
 * auto-approve, so they must reflect real behaviour.
 */
export interface ToolAnnotations {
  readonly title?: string;
  readonly readOnlyHint?: boolean;
  readonly destructiveHint?: boolean;
  readonly idempotentHint?: boolean;
  readonly openWorldHint?: boolean;
}

export interface ToolDefinition {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly inputSchema: JsonSchema;
  readonly annotations: ToolAnnotations;
  readonly toolset: ToolsetId | 'core';
  /** Excluded when the server runs in read-only mode. */
  readonly mutating: boolean;
  /** Handlers receive arguments already validated against `inputSchema`. */
  readonly handler: (args: Record<string, unknown>, context: ToolContext) => Promise<unknown>;
}
