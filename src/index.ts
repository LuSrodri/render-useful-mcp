#!/usr/bin/env node
/**
 * Entry point: reads configuration, builds the server and serves it over stdio.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { serveStdio } from '@modelcontextprotocol/server/stdio';

import { loadConfig } from './config.js';
import { ConfigurationError, RenderMcpError } from './errors.js';
import { createLogger } from './logging.js';
import { createServer } from './server.js';
import { ToolRegistry } from './tools/registry.js';

export { loadConfig, parseToolsets } from './config.js';
export { createServer, serialise } from './server.js';
export { RenderClient } from './render/client.js';
export { ToolRegistry } from './tools/registry.js';
export { buildApiTools } from './tools/api-tools.js';
export { loadCatalogue, loadOperations } from './generated/catalogue.js';
export * from './errors.js';
export * from './tools/toolsets.js';
export type { ToolDefinition, ToolContext } from './tools/types.js';
export type { OperationDefinition, OperationCatalogue } from './generated/types.js';

function readVersion(): string {
  try {
    const path = fileURLToPath(new URL('../package.json', import.meta.url));
    const pkg = JSON.parse(readFileSync(path, 'utf8')) as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

export function main(): void {
  const version = readVersion();
  const config = loadConfig({ version });
  const logger = createLogger(config.logLevel);

  // Built once and shared by every instance the factory produces: the 212 tool
  // definitions are immutable, and rebuilding them per connection would be pure waste.
  const registry = new ToolRegistry({
    enabledToolsets: config.toolsets,
    readOnly: config.readOnly,
    dynamicToolsets: config.dynamicToolsets,
  });

  // `serveStdio` owns the protocol-era decision: a 2026-07-28 client is served directly,
  // while a client that opens with the old `initialize` handshake pins a 2025-era instance
  // from the same factory. Both eras are served by identical wiring.
  const handle = serveStdio(() => createServer({ config, version, logger, registry }).server, {
    onerror: (error) => {
      logger.error('stdio transport error', { error: error.message });
    },
  });

  const shutdown = (signal: string) => (): void => {
    logger.info('shutting down', { signal });
    void handle.close().finally(() => process.exit(0));
  };
  process.on('SIGINT', shutdown('SIGINT'));
  process.on('SIGTERM', shutdown('SIGTERM'));

  logger.info('render-useful-mcp ready', {
    version,
    baseUrl: config.baseUrl,
    readOnly: config.readOnly,
    workspaceId: config.defaultOwnerId ?? null,
    toolsets: [...config.toolsets].sort(),
    visibleTools: registry.visible().length,
    totalTools: registry.all().length,
  });
}

// Only self-start when executed directly, so the module stays importable for tests.
if (process.argv[1] !== undefined && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  try {
    main();
  } catch (error: unknown) {
    const logger = createLogger('error');
    const message = error instanceof RenderMcpError ? error.toToolMessage() : String(error);
    logger.error('failed to start render-useful-mcp', { error: message });
    // stderr is what a user actually sees when their MCP client reports a failed server.
    process.stderr.write(`\nrender-useful-mcp failed to start:\n${message}\n`);
    process.exit(error instanceof ConfigurationError ? 2 : 1);
  }
}
