#!/usr/bin/env node
/**
 * Entry point: reads configuration, builds the server and serves it over stdio.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { loadConfig } from './config.js';
import { ConfigurationError, RenderMcpError } from './errors.js';
import { createLogger } from './logging.js';
import { createServer } from './server.js';

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

export async function main(): Promise<void> {
  const version = readVersion();
  const config = loadConfig({ version });
  const { server, registry, logger } = createServer({ config, version });

  const shutdown = (signal: string) => (): void => {
    logger.info('shutting down', { signal });
    void server.close().finally(() => process.exit(0));
  };
  process.on('SIGINT', shutdown('SIGINT'));
  process.on('SIGTERM', shutdown('SIGTERM'));

  await server.connect(new StdioServerTransport());

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
  main().catch((error: unknown) => {
    const logger = createLogger('error');
    const message = error instanceof RenderMcpError ? error.toToolMessage() : String(error);
    logger.error('failed to start render-useful-mcp', { error: message });
    // stderr is what a user actually sees when their MCP client reports a failed server.
    process.stderr.write(`\nrender-useful-mcp failed to start:\n${message}\n`);
    process.exit(error instanceof ConfigurationError ? 2 : 1);
  });
}
