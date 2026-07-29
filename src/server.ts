/**
 * MCP protocol wiring, on protocol revision 2026-07-28.
 *
 * The low-level `Server` is used rather than the `McpServer` façade because tool schemas
 * are generated JSON Schema, not Standard Schema. `McpServer.registerTool` only accepts a
 * `StandardSchemaWithJSON` (Zod v4, ArkType, Valibot), so going through it would mean
 * converting 207 spec-derived schemas twice and losing constraints along the way. Here the
 * spec's schemas reach the client untouched.
 */
import { Server, type CallToolResult } from '@modelcontextprotocol/server';

import type { Config } from './config.js';
import { RenderMcpError } from './errors.js';
import { createLogger, type Logger } from './logging.js';
import { RenderClient } from './render/client.js';
import { ToolRegistry } from './tools/registry.js';
import { validateArgs } from './tools/validate.js';
import type { ToolContext } from './tools/types.js';

export interface CreateServerOptions {
  readonly config: Config;
  readonly version: string;
  readonly logger?: Logger;
  readonly registry?: ToolRegistry;
  readonly client?: RenderClient;
}

export interface CreatedServer {
  readonly server: Server;
  readonly registry: ToolRegistry;
  readonly logger: Logger;
}

export function createServer(options: CreateServerOptions): CreatedServer {
  const logger = options.logger ?? createLogger(options.config.logLevel);
  const config = options.config;

  const client =
    options.client ??
    new RenderClient({
      apiKey: config.apiKey,
      baseUrl: config.baseUrl,
      userAgent: config.userAgent,
      timeoutMs: config.requestTimeoutMs,
      logger,
      retryPolicy: { maxRetries: config.maxRetries, baseDelayMs: 250, maxDelayMs: 20_000 },
    });

  const registry =
    options.registry ??
    new ToolRegistry({
      enabledToolsets: config.toolsets,
      readOnly: config.readOnly,
      dynamicToolsets: config.dynamicToolsets,
    });

  const server = new Server(
    { name: 'render-useful-mcp', version: options.version },
    {
      // No `listChanged`: the visible set is fixed for the lifetime of the process. The
      // spec requires the tool list not to vary per-connection or as a side effect of
      // other requests, so there is nothing to notify about.
      capabilities: { tools: {} },
      // Logging is not declared: diagnostics go to stderr (see `logging.ts`), which is
      // what SEP-2577 prescribes for stdio servers now that the Logging feature is
      // deprecated.
      cacheHints: {
        // Derived purely from this process's configuration — identical for every caller,
        // and immutable while the process lives — so it is safe for shared caches.
        'tools/list': { ttlMs: 300_000, cacheScope: 'public' },
      },
    },
  );

  server.setRequestHandler('tools/list', () => ({
    tools: registry.visible().map((tool) => ({
      name: tool.name,
      title: tool.title,
      description: tool.description,
      inputSchema: tool.inputSchema,
      annotations: tool.annotations,
    })),
  }));

  server.setRequestHandler('tools/call', async (request, ctx): Promise<CallToolResult> => {
    const { name, arguments: rawArgs } = request.params;
    const started = Date.now();
    const callLogger = logger.child({ tool: name });

    try {
      const tool = registry.resolve(name);
      const args = validateArgs(name, tool.inputSchema, rawArgs ?? {});

      const context: ToolContext = {
        client,
        config,
        logger: callLogger,
        signal: ctx.mcpReq.signal,
        callTool: async (otherName, otherArgs) => {
          const other = registry.resolve(otherName);
          return other.handler(validateArgs(otherName, other.inputSchema, otherArgs), context);
        },
      };

      const result = await tool.handler(args, context);
      callLogger.debug('tool call succeeded', { durationMs: Date.now() - started });
      return { content: [{ type: 'text', text: serialise(result, config.maxResponseBytes) }] };
    } catch (error) {
      callLogger.warn('tool call failed', {
        durationMs: Date.now() - started,
        error: error instanceof Error ? error.message : String(error),
      });
      // Tool failures are reported in-band as `isError` results: the model can read them and
      // adjust, whereas a JSON-RPC protocol error would abort the exchange.
      return { content: [{ type: 'text', text: describeError(error) }], isError: true };
    }
  });

  return { server, registry, logger };
}

/**
 * Renders a tool result as text, truncating oversized payloads.
 *
 * An unbounded response — a few thousand log lines, say — can consume an entire context
 * window. Truncating with an explicit marker keeps the call useful and tells the model to
 * narrow its query.
 */
export function serialise(result: unknown, maxBytes: number): string {
  if (typeof result === 'string') return truncate(result, maxBytes);
  let text: string;
  try {
    text = JSON.stringify(result, null, 2) ?? String(result);
  } catch {
    text = String(result);
  }
  return truncate(text, maxBytes);
}

function truncate(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text;
  // Slice on a character boundary; utf8 bytes >= chars, so this always fits.
  const kept = text.slice(0, maxBytes);
  return (
    `${kept}\n\n[truncated: response exceeded ${maxBytes} bytes. ` +
    `Narrow the request (lower "limit", tighter time range, more specific filters), ` +
    `or raise RENDER_MCP_MAX_RESPONSE_BYTES.]`
  );
}

function describeError(error: unknown): string {
  if (error instanceof RenderMcpError) return error.toToolMessage();
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return `Unexpected error: ${String(error)}`;
}
