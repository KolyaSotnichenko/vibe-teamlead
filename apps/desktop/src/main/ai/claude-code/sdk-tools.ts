/**
 * In-process MCP server exposing Vibe Teamlead build-management tools to
 * Claude Code (via the Claude Agent SDK).
 *
 * The existing tool implementations (`Tool.define(...)`) are reused as-is:
 * each definition's `execute(input, context)` is wrapped in an SDK `tool()`
 * and served from `createSdkMcpServer()`. Claude Code sees them under
 * `mcp__auto-claude__<name>`, matching the names in AGENT_CONFIGS.
 */

import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import type { McpSdkServerConfigWithInstance } from '@anthropic-ai/claude-agent-sdk';
import type { z } from 'zod/v3';

import {
  getBuildProgressTool,
  getSessionContextTool,
  recordDiscoveryTool,
  recordGotchaTool,
  updateQaStatusTool,
  updateSubtaskStatusTool,
} from '../tools/auto-claude';
import type { DefinedTool } from '../tools/define';
import type { ToolContext } from '../tools/types';

/** MCP server key; tool names become `mcp__auto-claude__<tool>` */
export const AUTO_CLAUDE_SERVER_KEY = 'auto-claude';
const TOOL_PREFIX = `mcp__${AUTO_CLAUDE_SERVER_KEY}__`;

const BUILD_TOOLS: readonly DefinedTool[] = [
  updateSubtaskStatusTool,
  getBuildProgressTool,
  recordDiscoveryTool,
  recordGotchaTool,
  getSessionContextTool,
  updateQaStatusTool,
] as unknown as readonly DefinedTool[];

function toText(output: unknown): string {
  if (typeof output === 'string') return output;
  try {
    return JSON.stringify(output, null, 2);
  } catch {
    return String(output);
  }
}

/**
 * Build the in-process MCP server for the given agent.
 *
 * @param context - Tool context (cwd, specDir, security profile) bound to every call
 * @param allowedToolNames - Full tool names (`mcp__auto-claude__*`) this agent may use.
 *   Pass `undefined` to expose all build tools.
 */
export function createBuildToolsServer(
  context: ToolContext,
  allowedToolNames?: readonly string[],
): McpSdkServerConfigWithInstance {
  const selected = BUILD_TOOLS.filter(
    (def) => !allowedToolNames || allowedToolNames.includes(def.metadata.name),
  );

  const tools = selected.map((def) => {
    const shortName = def.metadata.name.startsWith(TOOL_PREFIX)
      ? def.metadata.name.slice(TOOL_PREFIX.length)
      : def.metadata.name;
    const schema = def.config.inputSchema as unknown as z.ZodObject<z.ZodRawShape>;

    return tool(
      shortName,
      def.metadata.description,
      schema.shape,
      async (args) => {
        try {
          const output = await def.config.execute(args as never, context);
          return { content: [{ type: 'text' as const, text: toText(output) }] };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return {
            content: [{ type: 'text' as const, text: `Error: ${message}` }],
            isError: true,
          };
        }
      },
    );
  });

  return createSdkMcpServer({
    name: AUTO_CLAUDE_SERVER_KEY,
    version: '2.0.0',
    tools,
  });
}
