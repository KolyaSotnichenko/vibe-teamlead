/**
 * Tool.define()
 * =============
 *
 * Declares an app-provided tool: metadata, a Zod input schema and an
 * `execute(input, context)` function. Definitions are served to Claude Code
 * as an in-process MCP server (see `claude-code/sdk-tools.ts`), which binds
 * the ToolContext and enforces the schema.
 */

import type { z } from 'zod/v3';

import type { ToolDefinitionConfig, ToolMetadata } from './types';

export interface DefinedTool<TInput extends z.ZodType = z.ZodType, TOutput = unknown> {
  /** Tool metadata */
  metadata: ToolMetadata;
  /** Original config (schema + execute) */
  config: ToolDefinitionConfig<TInput, TOutput>;
}

function define<TInput extends z.ZodType, TOutput>(
  config: ToolDefinitionConfig<TInput, TOutput>,
): DefinedTool<TInput, TOutput> {
  return { metadata: config.metadata, config };
}

export const Tool = { define } as const;
