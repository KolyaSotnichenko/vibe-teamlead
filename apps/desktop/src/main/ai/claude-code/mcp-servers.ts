/**
 * Resolve the MCP servers a given agent should get, in Claude Agent SDK format.
 *
 * Server selection still comes from AGENT_CONFIGS / getRequiredMcpServers();
 * this module only converts the registry entries into SDK `McpServerConfig`s
 * and swaps the build-management server for the in-process SDK server.
 *
 * The record key becomes the tool prefix inside Claude Code
 * (`mcp__<key>__<tool>`), so keys match the tool names used in AGENT_CONFIGS.
 */

import type { McpServerConfig as SdkMcpServerConfig } from '@anthropic-ai/claude-agent-sdk';

import {
  getAgentConfig,
  getRequiredMcpServers,
  type AgentType,
  type McpServerResolveOptions,
} from '../config/agent-configs';
import { getMcpServerConfig, type McpRegistryOptions } from '../mcp/registry';
import type { McpServerConfig } from '../mcp/types';
import type { ToolContext } from '../tools/types';
import { APP_TOOLS_SERVER_KEY, createBuildToolsServer } from './sdk-tools';

/** Registry id → key Claude Code uses as the tool prefix */
const SERVER_KEYS: Record<string, string> = {
  context7: 'context7',
  linear: 'linear-server',
  memory: 'graphiti-memory',
  electron: 'electron',
  playwright: 'playwright',
  'chrome-devtools': 'chrome-devtools',
};

/**
 * Claude Code starts stdio MCP servers with its own environment merged in,
 * which holds the session's Claude credentials. Third-party servers never
 * need them, so they are blanked.
 */
export const CREDENTIAL_BLANKING_ENV: Record<string, string> = {
  ANTHROPIC_API_KEY: '',
  ANTHROPIC_AUTH_TOKEN: '',
  CLAUDE_CODE_OAUTH_TOKEN: '',
};

export function toSdkServerConfig(config: McpServerConfig): SdkMcpServerConfig {
  const transport = config.transport;
  if (transport.type === 'stdio') {
    return {
      type: 'stdio',
      command: transport.command,
      args: transport.args,
      env: { ...transport.env, ...CREDENTIAL_BLANKING_ENV },
    };
  }
  return {
    type: 'http',
    url: transport.url,
    headers: transport.headers,
  };
}

export function buildMcpServers(
  agentType: AgentType,
  context: ToolContext,
  resolveOptions: McpServerResolveOptions = {},
  registryOptions: McpRegistryOptions = {},
): Record<string, SdkMcpServerConfig> {
  const servers: Record<string, SdkMcpServerConfig> = {};
  const agentConfig = getAgentConfig(agentType);

  for (const id of getRequiredMcpServers(agentType, resolveOptions)) {
    if (id === 'vibe-teamlead') {
      servers[APP_TOOLS_SERVER_KEY] = createBuildToolsServer(
        context,
        agentConfig.appTools,
      );
      continue;
    }
    const config = getMcpServerConfig(id, registryOptions);
    if (!config) continue;
    servers[SERVER_KEYS[id] ?? id] = toSdkServerConfig(config);
  }

  return servers;
}
