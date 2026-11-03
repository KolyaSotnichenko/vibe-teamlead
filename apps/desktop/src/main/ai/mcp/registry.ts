/**
 * MCP Server Registry
 * ====================
 *
 * Defines MCP server configurations for all supported integrations.
 *
 * Each server config defines how to connect (stdio or StreamableHTTP),
 * and whether it's enabled by default.
 */

import type { McpServerConfig, McpServerId } from './types';

// =============================================================================
// Server Configuration Definitions
// =============================================================================

/**
 * Context7 MCP server - documentation lookup.
 * Always enabled by default. Uses npx to launch.
 */
const CONTEXT7_SERVER: McpServerConfig = {
  id: 'context7',
  name: 'Context7',
  description: 'Documentation lookup for libraries and frameworks',
  enabledByDefault: true,
  // Context7's hosted server: Claude Code connects over HTTP, so nothing has to
  // be installed (the npx-launched server failed whenever the app, started from
  // Finder, had no npx on its PATH). A key only raises the rate limits.
  transport: {
    type: 'streamable-http',
    url: 'https://mcp.context7.com/mcp',
  },
};

/** Context7 with the user's key, when there is one (CONTEXT7_API_KEY) */
function context7Server(options: McpRegistryOptions): McpServerConfig {
  const key = (options.context7ApiKey ?? options.env?.CONTEXT7_API_KEY ?? process.env.CONTEXT7_API_KEY)?.trim();
  if (!key || CONTEXT7_SERVER.transport.type !== 'streamable-http') return CONTEXT7_SERVER;
  return { ...CONTEXT7_SERVER, transport: { ...CONTEXT7_SERVER.transport, headers: { Authorization: `Bearer ${key}` } } };
}

/**
 * Linear MCP server - project management.
 * Conditionally enabled when project has Linear integration active.
 * Requires LINEAR_API_KEY environment variable.
 */
const LINEAR_SERVER: McpServerConfig = {
  id: 'linear',
  name: 'Linear',
  description: 'Project management integration for issues and tasks',
  enabledByDefault: false,
  transport: {
    type: 'stdio',
    command: 'npx',
    args: ['-y', '@linear/mcp-server'],
  },
};

/**
 * Memory MCP server - knowledge graph memory.
 * Conditionally enabled when GRAPHITI_MCP_URL is set.
 * Connects via StreamableHTTP to the running memory sidecar.
 */
function createMemoryServer(url: string): McpServerConfig {
  return {
    id: 'memory',
    name: 'Memory',
    description: 'Knowledge graph memory for cross-session insights',
    enabledByDefault: false,
    transport: {
      type: 'streamable-http',
      url,
    },
  };
}

/**
 * Electron MCP server - desktop app automation.
 * Only available to QA agents. Requires ELECTRON_MCP_ENABLED=true.
 * Uses Chrome DevTools Protocol to connect to Electron apps.
 */
const ELECTRON_SERVER: McpServerConfig = {
  id: 'electron',
  name: 'Electron',
  description: 'Desktop app automation via Chrome DevTools Protocol',
  enabledByDefault: false,
  transport: {
    type: 'stdio',
    command: 'npx',
    args: ['-y', 'electron-mcp-server@1.5.1'],
  },
};

/**
 * Bundled browser MCP servers run on Electron's own Node (ELECTRON_RUN_AS_NODE),
 * headless and with in-memory profiles, against the user's installed Chrome.
 */
function bundledNodeServer(
  id: string,
  name: string,
  description: string,
  cli: string,
  args: string[],
  runtime: string,
  env: Record<string, string> = {},
): McpServerConfig {
  return {
    id,
    name,
    description,
    enabledByDefault: true,
    transport: {
      type: 'stdio',
      command: runtime,
      args: [cli, ...args],
      env: { ELECTRON_RUN_AS_NODE: '1', ...env },
    },
  };
}

/** Playwright MCP (Microsoft, Apache-2.0): drive the app under test as a user would. */
function createPlaywrightServer(cli: string, runtime: string, outputDir?: string): McpServerConfig {
  const args = ['--headless', '--isolated', '--browser', 'chrome', '--caps', 'testing'];
  if (outputDir) args.push('--output-dir', outputDir);
  return bundledNodeServer('playwright', 'Playwright', 'Browser automation for end-to-end validation', cli, args, runtime);
}

/** Chrome DevTools MCP (Google, Apache-2.0): console, network and performance debugging. */
function createChromeDevtoolsServer(cli: string, runtime: string): McpServerConfig {
  return bundledNodeServer(
    'chrome-devtools',
    'Chrome DevTools',
    'Console, network and performance inspection for debugging',
    cli,
    ['--headless', '--isolated', '--no-usage-statistics', '--no-performance-crux'],
    runtime,
    { CHROME_DEVTOOLS_MCP_NO_USAGE_STATISTICS: '1', CHROME_DEVTOOLS_MCP_NO_UPDATE_CHECKS: '1' },
  );
}


// =============================================================================
// Registry
// =============================================================================

/** Options for resolving MCP server configurations */
export interface McpRegistryOptions {
  /** Spec directory for auto-claude MCP server */
  specDir?: string;
  /** Memory MCP server URL (if enabled) */
  memoryMcpUrl?: string;
  /** Linear API key (if available) */
  linearApiKey?: string;
  /** Context7 API key (optional; higher rate limits) */
  context7ApiKey?: string;
  /** Environment variables for server processes */
  env?: Record<string, string>;
  /** Bundled MCP server entry points (browser servers are skipped when absent) */
  bundled?: { playwrightMcpCli?: string; chromeDevtoolsMcpCli?: string; nodeRuntime?: string };
  /** Where browser tools save screenshots and traces */
  browserOutputDir?: string;
}

/**
 * Get the MCP server configuration for a given server ID.
 *
 * @param serverId - The server identifier to resolve
 * @param options - Registry options for dynamic server configuration
 * @returns Server configuration or null if not recognized
 */
export function getMcpServerConfig(
  serverId: McpServerId | string,
  options: McpRegistryOptions = {},
): McpServerConfig | null {
  switch (serverId) {
    case 'context7':
      return context7Server(options);

    case 'linear': {
      if (!options.linearApiKey && !options.env?.LINEAR_API_KEY) return null;
      const server = { ...LINEAR_SERVER };
      // Pass LINEAR_API_KEY to the server process
      const apiKey = options.linearApiKey ?? options.env?.LINEAR_API_KEY;
      if (apiKey && server.transport.type === 'stdio') {
        server.transport = {
          ...server.transport,
          env: { ...server.transport.env, LINEAR_API_KEY: apiKey },
        };
      }
      return server;
    }

    case 'memory': {
      const url = options.memoryMcpUrl ?? options.env?.GRAPHITI_MCP_URL;
      if (!url) return null;
      return createMemoryServer(url);
    }

    case 'electron':
      return ELECTRON_SERVER;

    case 'playwright': {
      const { playwrightMcpCli, nodeRuntime } = options.bundled ?? {};
      if (!playwrightMcpCli || !nodeRuntime) return null;
      return createPlaywrightServer(playwrightMcpCli, nodeRuntime, options.browserOutputDir);
    }

    case 'chrome-devtools': {
      const { chromeDevtoolsMcpCli, nodeRuntime } = options.bundled ?? {};
      if (!chromeDevtoolsMcpCli || !nodeRuntime) return null;
      return createChromeDevtoolsServer(chromeDevtoolsMcpCli, nodeRuntime);
    }


    default:
      return null;
  }
}
