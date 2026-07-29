import { describe, expect, it } from 'vitest';

import { loadConfig, parseToolsets } from '../src/config.js';
import { ConfigurationError } from '../src/errors.js';
import { DEFAULT_TOOLSETS, TOOLSET_IDS } from '../src/tools/toolsets.js';

const base = { RENDER_API_KEY: 'rnd_test' } satisfies NodeJS.ProcessEnv;

describe('loadConfig', () => {
  it('applies documented defaults', () => {
    const config = loadConfig({ env: base, version: '1.2.3' });

    expect(config.baseUrl).toBe('https://api.render.com/v1');
    expect(config.readOnly).toBe(false);
    expect(config.dynamicToolsets).toBe(true);
    expect(config.requestTimeoutMs).toBe(60_000);
    expect(config.maxRetries).toBe(3);
    expect(config.logLevel).toBe('info');
    expect(config.userAgent).toContain('1.2.3');
    expect([...config.toolsets].sort()).toEqual([...DEFAULT_TOOLSETS].sort());
  });

  it('fails fast, with instructions, when the API key is missing', () => {
    const error = (() => {
      try {
        loadConfig({ env: {}, version: '1.0.0' });
        return undefined;
      } catch (caught) {
        return caught as ConfigurationError;
      }
    })();

    expect(error).toBeInstanceOf(ConfigurationError);
    expect(error!.toToolMessage()).toContain('dashboard.render.com');
  });

  it('treats a blank API key as missing rather than as a schema violation', () => {
    // `${RENDER_API_KEY:-}` in a client config expands to this when the variable is unset.
    expect(() => loadConfig({ env: { RENDER_API_KEY: '   ' }, version: '1.0.0' })).toThrow(ConfigurationError);
    try {
      loadConfig({ env: { RENDER_API_KEY: '' }, version: '1.0.0' });
    } catch (caught) {
      expect((caught as ConfigurationError).toToolMessage()).toContain('dashboard.render.com');
    }
  });

  it('names the real problem when the client left a placeholder unsubstituted', () => {
    // A client that fails to interpolate passes the literal text through. It is non-empty,
    // so without this check it would reach Render and come back as an unexplained 401.
    const error = (() => {
      try {
        loadConfig({ env: { RENDER_API_KEY: '${RENDER_API_KEY}' }, version: '1.0.0' });
        return undefined;
      } catch (caught) {
        return caught as ConfigurationError;
      }
    })();

    expect(error).toBeInstanceOf(ConfigurationError);
    const message = error!.toToolMessage();
    expect(message).toContain('did not');
    expect(message).toContain('${RENDER_API_KEY}');
  });

  it('parses boolean and numeric overrides', () => {
    const config = loadConfig({
      env: {
        ...base,
        RENDER_MCP_READ_ONLY: 'true',
        RENDER_MCP_DYNAMIC_TOOLSETS: 'no',
        RENDER_MCP_TIMEOUT_MS: '15000',
        RENDER_MCP_MAX_RETRIES: '0',
        RENDER_MCP_LOG_LEVEL: 'debug',
      },
      version: '1.0.0',
    });

    expect(config.readOnly).toBe(true);
    expect(config.dynamicToolsets).toBe(false);
    expect(config.requestTimeoutMs).toBe(15_000);
    expect(config.maxRetries).toBe(0);
    expect(config.logLevel).toBe('debug');
  });

  it('strips a trailing slash from the base URL so paths never double up', () => {
    const config = loadConfig({
      env: { ...base, RENDER_API_BASE_URL: 'https://proxy.internal/v1/' },
      version: '1.0.0',
    });
    expect(config.baseUrl).toBe('https://proxy.internal/v1');
  });

  it('rejects out-of-range and malformed values', () => {
    expect(() => loadConfig({ env: { ...base, RENDER_MCP_TIMEOUT_MS: '5' }, version: '1.0.0' })).toThrow(
      ConfigurationError,
    );
    expect(() => loadConfig({ env: { ...base, RENDER_MCP_LOG_LEVEL: 'loud' }, version: '1.0.0' })).toThrow(
      ConfigurationError,
    );
    expect(() => loadConfig({ env: { ...base, RENDER_API_BASE_URL: 'not-a-url' }, version: '1.0.0' })).toThrow(
      ConfigurationError,
    );
    expect(() => loadConfig({ env: { ...base, RENDER_MCP_READ_ONLY: 'maybe' }, version: '1.0.0' })).toThrow(
      ConfigurationError,
    );
  });
});

describe('parseToolsets', () => {
  it('falls back to the default set', () => {
    expect([...parseToolsets(undefined)].sort()).toEqual([...DEFAULT_TOOLSETS].sort());
    expect([...parseToolsets('  ')].sort()).toEqual([...DEFAULT_TOOLSETS].sort());
  });

  it('expands "all"', () => {
    expect(parseToolsets('all').size).toBe(TOOLSET_IDS.length);
  });

  it('accepts a case-insensitive, whitespace-tolerant list', () => {
    expect([...parseToolsets(' Services , METRICS ')].sort()).toEqual(['metrics', 'services']);
  });

  it('names the invalid entries and the valid options', () => {
    const error = (() => {
      try {
        parseToolsets('services,nope');
        return undefined;
      } catch (caught) {
        return caught as ConfigurationError;
      }
    })();

    expect(error).toBeInstanceOf(ConfigurationError);
    expect(error!.message).toContain('nope');
    expect(error!.hint).toContain('services');
  });
});
