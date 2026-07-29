/**
 * The set of tools the server exposes, and the policy that decides which are visible.
 *
 * Visibility is fixed at construction. Protocol revision 2026-07-28 requires the result of
 * `tools/list` not to vary per-connection "or as a side effect of other requests on the
 * connection", so the enabled set is decided once, from configuration, and never moves.
 * `render_toolsets` reports that set; changing it means changing `RENDER_MCP_TOOLSETS` and
 * restarting.
 */
import { PolicyError } from '../errors.js';
import type { ToolDefinition } from './types.js';
import { buildApiTools } from './api-tools.js';
import { buildCompositeTools } from './composite/index.js';
import { TOOLSET_DESCRIPTIONS, TOOLSET_IDS, type ToolsetId } from './toolsets.js';

export interface RegistryOptions {
  readonly enabledToolsets: Iterable<ToolsetId>;
  readonly readOnly: boolean;
  readonly dynamicToolsets: boolean;
}

export class ToolRegistry {
  readonly #tools = new Map<string, ToolDefinition>();
  readonly #enabled: ReadonlySet<ToolsetId>;
  readonly #readOnly: boolean;

  constructor(
    options: RegistryOptions,
    tools: readonly ToolDefinition[] = [...buildCompositeTools(), ...buildApiTools()],
  ) {
    this.#enabled = new Set(options.enabledToolsets);
    this.#readOnly = options.readOnly;

    for (const tool of tools) {
      if (this.#tools.has(tool.name)) {
        throw new Error(`Duplicate tool name: ${tool.name}`);
      }
      this.#tools.set(tool.name, tool);
    }

    if (options.dynamicToolsets) {
      const meta = this.#buildToolsetMetaTool();
      this.#tools.set(meta.name, meta);
    }
  }

  get readOnly(): boolean {
    return this.#readOnly;
  }

  get enabledToolsets(): ReadonlySet<ToolsetId> {
    return this.#enabled;
  }

  /** Every registered tool, including ones currently hidden by policy. */
  all(): readonly ToolDefinition[] {
    return [...this.#tools.values()];
  }

  /** Tools currently visible to the client, sorted for a stable `tools/list`. */
  visible(): readonly ToolDefinition[] {
    return this.all()
      .filter((tool) => this.#isVisible(tool))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  /**
   * Looks up a tool for execution.
   *
   * Hidden-but-registered tools produce a specific, recoverable error rather than
   * "unknown tool", because a model that saw the name earlier in the session — or guessed
   * it correctly — should be told how to enable it.
   */
  resolve(name: string): ToolDefinition {
    const tool = this.#tools.get(name);
    if (tool === undefined) {
      throw new PolicyError(`Unknown tool "${name}".`, 'Call tools/list to see the available tools for this server.');
    }
    if (this.#readOnly && tool.mutating) {
      throw new PolicyError(
        `"${name}" modifies Render resources and this server runs in read-only mode.`,
        'Unset RENDER_MCP_READ_ONLY in the MCP server configuration to allow write operations.',
      );
    }
    if (!this.#isVisible(tool)) {
      throw new PolicyError(
        `"${name}" belongs to the "${tool.toolset}" toolset, which is not enabled.`,
        `Add "${tool.toolset}" to RENDER_MCP_TOOLSETS in the MCP server configuration and restart the server.`,
      );
    }
    return tool;
  }

  /** Per-toolset tool counts, used by the meta-tool and the startup banner. */
  stats(): ReadonlyArray<{ toolset: ToolsetId | 'core'; enabled: boolean; tools: number; description: string }> {
    const counts = new Map<ToolsetId | 'core', number>();
    for (const tool of this.all()) {
      counts.set(tool.toolset, (counts.get(tool.toolset) ?? 0) + 1);
    }
    return [
      {
        toolset: 'core' as const,
        enabled: true,
        tools: counts.get('core') ?? 0,
        description: 'Always-on helpers that resolve names, wait for deploys and triage services.',
      },
      ...TOOLSET_IDS.map((toolset) => ({
        toolset,
        enabled: this.#enabled.has(toolset),
        tools: counts.get(toolset) ?? 0,
        description: TOOLSET_DESCRIPTIONS[toolset],
      })),
    ];
  }

  #isVisible(tool: ToolDefinition): boolean {
    if (this.#readOnly && tool.mutating) return false;
    return tool.toolset === 'core' || this.#enabled.has(tool.toolset);
  }

  #buildToolsetMetaTool(): ToolDefinition {
    return {
      name: 'render_toolsets',
      title: 'List Render toolsets',
      description:
        'Lists every Render toolset with its tool count and whether it is currently enabled. ' +
        'All toolsets are enabled by default; this is useful for discovering which Render capabilities exist, ' +
        'and for finding out what the operator has to change when a needed toolset is disabled. ' +
        'The set of enabled toolsets is fixed at startup — this tool reports it, it cannot change it.',
      toolset: 'core',
      mutating: false,
      annotations: {
        title: 'List Render toolsets',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      inputSchema: {
        type: 'object',
        properties: {},
        additionalProperties: false,
        $schema: 'http://json-schema.org/draft-07/schema#',
      },
      // Synchronous work, but the tool contract is uniformly async.
      handler: () => {
        const toolsets = this.stats();
        const disabled = toolsets.filter((entry) => !entry.enabled).map((entry) => entry.toolset);
        return Promise.resolve({
          toolsets,
          visibleTools: this.visible().length,
          ...(disabled.length > 0 && {
            howToEnable:
              `Toolsets are selected at startup and cannot be changed from here. To enable ${disabled.join(', ')}, ` +
              `set RENDER_MCP_TOOLSETS in the MCP server configuration (use "all", or a comma-separated list) ` +
              `and restart the server.`,
          }),
        });
      },
    };
  }
}
