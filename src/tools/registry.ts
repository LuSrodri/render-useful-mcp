/**
 * The set of tools the server exposes, and the policy that decides which are visible.
 *
 * Visibility is dynamic: a client may enable further toolsets mid-session, so the registry
 * owns the enabled set and notifies listeners when it changes.
 */
import { PolicyError } from '../errors.js';
import type { ToolDefinition } from './types.js';
import { buildApiTools } from './api-tools.js';
import { buildCompositeTools } from './composite/index.js';
import { TOOLSET_DESCRIPTIONS, TOOLSET_IDS, isToolsetId, type ToolsetId } from './toolsets.js';

export interface RegistryOptions {
  readonly enabledToolsets: Iterable<ToolsetId>;
  readonly readOnly: boolean;
  readonly dynamicToolsets: boolean;
}

export class ToolRegistry {
  readonly #tools = new Map<string, ToolDefinition>();
  readonly #enabled: Set<ToolsetId>;
  readonly #readOnly: boolean;
  readonly #listeners = new Set<() => void>();

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
        this.#tools.has('render_toolsets')
          ? `Call render_toolsets with enable: "${tool.toolset}", then call "${name}" again.`
          : `Add "${tool.toolset}" to RENDER_MCP_TOOLSETS in the MCP server configuration.`,
      );
    }
    return tool;
  }

  enableToolset(toolset: ToolsetId): { readonly changed: boolean; readonly toolCount: number } {
    const changed = !this.#enabled.has(toolset);
    this.#enabled.add(toolset);
    if (changed) this.#notify();
    return { changed, toolCount: this.visible().length };
  }

  /** Registers a callback fired whenever the visible tool list changes. */
  onChange(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
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

  #notify(): void {
    for (const listener of this.#listeners) {
      try {
        listener();
      } catch {
        // A misbehaving listener must not break toolset switching.
      }
    }
  }

  #buildToolsetMetaTool(): ToolDefinition {
    return {
      name: 'render_toolsets',
      title: 'List or enable Render toolsets',
      description:
        'Lists every Render toolset with its tool count and whether it is enabled, and optionally enables one. ' +
        'All toolsets are enabled by default, so this is mainly useful for discovering which Render capabilities ' +
        'exist, or for re-enabling a toolset when the operator narrowed the surface with RENDER_MCP_TOOLSETS. ' +
        'Enabling a toolset makes its tools available immediately.',
      toolset: 'core',
      mutating: false,
      annotations: {
        title: 'List or enable Render toolsets',
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      inputSchema: {
        type: 'object',
        properties: {
          enable: {
            type: 'string',
            enum: [...TOOLSET_IDS],
            description: 'Toolset to enable. Omit to only list the current state.',
          },
        },
        additionalProperties: false,
        $schema: 'http://json-schema.org/draft-07/schema#',
      },
      // Synchronous work, but the tool contract is uniformly async.
      handler: (args) => {
        const requested: unknown = args['enable'];
        if (requested === undefined) {
          return Promise.resolve({ toolsets: this.stats(), visibleTools: this.visible().length });
        }
        if (typeof requested !== 'string' || !isToolsetId(requested)) {
          throw new PolicyError(
            `Unknown toolset "${JSON.stringify(requested)}".`,
            `Valid toolsets: ${TOOLSET_IDS.join(', ')}.`,
          );
        }
        const { changed, toolCount } = this.enableToolset(requested);
        return Promise.resolve({
          toolset: requested,
          enabled: true,
          alreadyEnabled: !changed,
          visibleTools: toolCount,
          message: changed
            ? `Enabled "${requested}". Its tools are now listed; re-read tools/list to see them.`
            : `"${requested}" was already enabled.`,
        });
      },
    };
  }
}
