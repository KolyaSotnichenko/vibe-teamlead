/**
 * Tests for MCP Server Registry
 *
 * Validates server configuration resolution, required server lookup,
 * and option-based server filtering.
 */

import { describe, expect, it } from 'vitest';
import { getMcpServerConfig } from '../registry';

// =============================================================================
// getMcpServerConfig
// =============================================================================

describe('getMcpServerConfig', () => {
  describe('context7', () => {
    it('returns the context7 server config', () => {
      const config = getMcpServerConfig('context7');
      expect(config).not.toBeNull();
      expect(config?.id).toBe('context7');
      expect(config?.enabledByDefault).toBe(true);
    });

    it('uses stdio transport with npx', () => {
      const config = getMcpServerConfig('context7');
      expect(config?.transport.type).toBe('stdio');
      if (config?.transport.type === 'stdio') {
        expect(config.transport.command).toBe('npx');
      }
    });
  });

  describe('linear', () => {
    it('returns null when no API key provided', () => {
      const config = getMcpServerConfig('linear', {});
      expect(config).toBeNull();
    });

    it('returns config when linearApiKey is provided', () => {
      const config = getMcpServerConfig('linear', { linearApiKey: 'lin_api_123' });
      expect(config).not.toBeNull();
      expect(config?.id).toBe('linear');
    });

    it('returns config when LINEAR_API_KEY is in env option', () => {
      const config = getMcpServerConfig('linear', { env: { LINEAR_API_KEY: 'lin_env_456' } });
      expect(config).not.toBeNull();
    });

    it('injects LINEAR_API_KEY into the transport env', () => {
      const config = getMcpServerConfig('linear', { linearApiKey: 'lin_inject' });
      expect(config?.transport.type).toBe('stdio');
      if (config?.transport.type === 'stdio') {
        expect(config.transport.env?.LINEAR_API_KEY).toBe('lin_inject');
      }
    });
  });

  describe('memory', () => {
    it('returns null when no memory URL provided', () => {
      const config = getMcpServerConfig('memory', {});
      expect(config).toBeNull();
    });

    it('returns config with streamable-http transport when URL is provided', () => {
      const config = getMcpServerConfig('memory', { memoryMcpUrl: 'http://localhost:8080/mcp' });
      expect(config).not.toBeNull();
      expect(config?.transport.type).toBe('streamable-http');
      if (config?.transport.type === 'streamable-http') {
        expect(config.transport.url).toBe('http://localhost:8080/mcp');
      }
    });

    it('reads URL from env.GRAPHITI_MCP_URL option', () => {
      const config = getMcpServerConfig('memory', { env: { GRAPHITI_MCP_URL: 'http://graphiti.local' } });
      expect(config?.transport.type).toBe('streamable-http');
    });
  });

  describe('electron', () => {
    it('returns the electron server config', () => {
      const config = getMcpServerConfig('electron');
      expect(config).not.toBeNull();
      expect(config?.id).toBe('electron');
      expect(config?.enabledByDefault).toBe(false);
    });

    it('uses stdio transport', () => {
      const config = getMcpServerConfig('electron');
      expect(config?.transport.type).toBe('stdio');
    });
  });

  describe('bundled browser servers', () => {
    const bundled = { playwrightMcpCli: '/r/pw/cli.js', chromeDevtoolsMcpCli: '/r/cd/cli.js', nodeRuntime: '/r/Electron' };

    it('are skipped when not bundled', () => {
      expect(getMcpServerConfig('playwright')).toBeNull();
      expect(getMcpServerConfig('chrome-devtools')).toBeNull();
    });

    it('run Playwright headless and isolated on Electron as Node', () => {
      const config = getMcpServerConfig('playwright', { bundled, browserOutputDir: '/spec/qa-browser' });
      expect(config?.transport).toMatchObject({
        type: 'stdio',
        command: '/r/Electron',
        args: ['/r/pw/cli.js', '--headless', '--isolated', '--browser', 'chrome', '--caps', 'testing', '--output-dir', '/spec/qa-browser'],
        env: { ELECTRON_RUN_AS_NODE: '1' },
      });
    });

    it('run Chrome DevTools without usage statistics or CrUX lookups', () => {
      const config = getMcpServerConfig('chrome-devtools', { bundled });
      const transport = config?.transport as { args: string[]; env: Record<string, string> };
      expect(transport.args).toEqual(expect.arrayContaining(['--no-usage-statistics', '--no-performance-crux', '--isolated']));
      expect(transport.env.CHROME_DEVTOOLS_MCP_NO_USAGE_STATISTICS).toBe('1');
    });
  });

  describe('unknown server', () => {
    it('returns null for unrecognized server ID', () => {
      const config = getMcpServerConfig('nonexistent-server');
      expect(config).toBeNull();
    });
  });
});
