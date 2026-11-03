/**
 * In-process MCP server exposing Vibe Teamlead build-management tools to
 * Claude Code (via the Claude Agent SDK).
 *
 * The existing tool implementations (`Tool.define(...)`) are reused as-is:
 * each definition's `execute(input, context)` is wrapped in an SDK `tool()`
 * and served from `createSdkMcpServer()`. Claude Code sees them under
 * `mcp__auto-claude__<name>`, matching the names in AGENT_CONFIGS.
 */

import { readFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';

import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z as z4 } from 'zod';
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
import { isPathContained } from '../security/path-containment';
import type { DefinedTool } from '../tools/define';
import type { ToolContext } from '../tools/types';

/** MCP server key; tool names become `mcp__auto-claude__<tool>` */
export const AUTO_CLAUDE_SERVER_KEY = 'auto-claude';
const TOOL_PREFIX = `mcp__${AUTO_CLAUDE_SERVER_KEY}__`;
export const RENDER_DIAGRAM_TOOL = `${TOOL_PREFIX}render_diagram`;
export const SEARCH_MEMORY_TOOL = `${TOOL_PREFIX}search_memory`;
export const REMEMBER_TOOL = `${TOOL_PREFIX}remember`;


/**
 * render_diagram: lets the architect see its own draw.io diagram.
 * Renders in the main process, saves <name>.png next to the file and returns the image.
 */
function renderDiagramTool(context: ToolContext) {
  return tool(
    'render_diagram',
    'Render a .drawio diagram file to PNG and return the image so you can review the layout. ' +
      'Saves <name>.png next to the .drawio file. Use after every change to a diagram.',
    { path: z4.string().describe('Path to the .drawio file (relative to the working directory or absolute)') },
    async ({ path }) => {
      const target = isAbsolute(path) ? resolve(path) : resolve(context.cwd, path);
      const roots = [context.specDir, context.cwd, ...(context.allowedWritePaths ?? [])];
      if (!/\.drawio$/i.test(target) || !roots.some((root) => isPathContained(target, root).contained)) {
        return {
          content: [{ type: 'text' as const, text: `Error: ${path} is not a .drawio file inside the project or spec directory` }],
          isError: true,
        };
      }
      try {
        const rendered = await context.renderDiagram!(target);
        const data = readFileSync(rendered.pngPath).toString('base64');
        return {
          content: [
            { type: 'image' as const, data, mimeType: 'image/png' },
            {
              type: 'text' as const,
              text: `Rendered ${rendered.width}×${rendered.height}px → ${rendered.pngPath}. Check for overlaps, crossings, cut-off text and unlabeled edges.`,
            },
          ],
        };
      } catch (error) {
        return {
          content: [{ type: 'text' as const, text: `Error rendering diagram: ${error instanceof Error ? error.message : String(error)}` }],
          isError: true,
        };
      }
    },
  );
}

/** search_memory: what agents learned earlier in this project. */
function searchMemoryTool(context: ToolContext) {
  return tool(
    'search_memory',
    "Search this project's memory: gotchas, decisions, patterns and per-file notes that agents saved in earlier tasks. " +
      'Use it before working in an unfamiliar area, and when something fails in a way that may have happened before.',
    {
      query: z4.string().describe('What you want to know, in a sentence (e.g. "how auth tokens are refreshed")'),
      limit: z4.number().int().min(1).max(20).optional().describe('How many memories to return (default 8)'),
    },
    async ({ query, limit }) => {
      try {
        return { content: [{ type: 'text' as const, text: await context.searchMemory!(query, limit) }] };
      } catch (error) {
        return { content: [{ type: 'text' as const, text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
      }
    },
  );
}

/** remember: keep a lesson for the agents that work on this project later. */
function rememberTool(context: ToolContext) {
  return tool(
    'remember',
    'Save something the next agent working on this project should know: a non-obvious gotcha, a decision and why, ' +
      'a pattern this codebase follows, or what a file is really for. One fact per call, specific and self-contained. ' +
      'Not for progress notes or anything only this task needs.',
    {
      type: z4.enum(['gotcha', 'decision', 'pattern', 'module_insight', 'error_pattern', 'requirement']),
      content: z4.string().min(12).describe('The fact, written so it makes sense without this conversation'),
      files: z4.array(z4.string()).optional().describe('Files it is about (relative paths)'),
    },
    async ({ type, content, files }) => {
      try {
        return { content: [{ type: 'text' as const, text: await context.remember!(type, content, files) }] };
      } catch (error) {
        return { content: [{ type: 'text' as const, text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
      }
    },
  );
}

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

  const wants = (name: string) => !allowedToolNames || allowedToolNames.includes(name);
  const allTools = [
    ...tools,
    ...(wants(RENDER_DIAGRAM_TOOL) && context.renderDiagram ? [renderDiagramTool(context)] : []),
    ...(wants(SEARCH_MEMORY_TOOL) && context.searchMemory ? [searchMemoryTool(context)] : []),
    ...(wants(REMEMBER_TOOL) && context.remember ? [rememberTool(context)] : []),
  ];

  return createSdkMcpServer({
    name: AUTO_CLAUDE_SERVER_KEY,
    version: '2.0.0',
    tools: allTools,
  });
}
