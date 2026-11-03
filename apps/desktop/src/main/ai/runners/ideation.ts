/**
 * Ideation Runner
 * ===============
 *
 * AI-powered idea generation via Claude Code.
 *
 * Runs one Claude Code session per ideation type (`runClaudeTask()`) with
 * read-only exploration + web research tools, plus Write/Edit confined to the
 * output directory, to generate ideas of different types: code improvements,
 * UI/UX, documentation, security, performance, and code quality.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { RESEARCH_TOOLS, runClaudeTask } from '../claude-code/task';
import type { ModelShorthand, ThinkingLevel } from '../config/types';
import type { StreamEvent } from '../session/types';

// =============================================================================
// Constants
// =============================================================================

/** Supported ideation types */
export const IDEATION_TYPES = [
  'code_improvements',
  'ui_ux_improvements',
  'documentation_gaps',
  'security_hardening',
  'performance_optimizations',
  'code_quality',
] as const;

export type IdeationType = (typeof IDEATION_TYPES)[number];

/** Human-readable labels for ideation types */
export const IDEATION_TYPE_LABELS: Record<IdeationType, string> = {
  code_improvements: 'Code Improvements',
  ui_ux_improvements: 'UI/UX Improvements',
  documentation_gaps: 'Documentation Gaps',
  security_hardening: 'Security Hardening',
  performance_optimizations: 'Performance Optimizations',
  code_quality: 'Code Quality & Refactoring',
};

/** Prompt file mapping per ideation type */
const IDEATION_TYPE_PROMPTS: Record<IdeationType, string> = {
  code_improvements: 'ideation_code_improvements.md',
  ui_ux_improvements: 'ideation_ui_ux.md',
  documentation_gaps: 'ideation_documentation.md',
  security_hardening: 'ideation_security.md',
  performance_optimizations: 'ideation_performance.md',
  code_quality: 'ideation_code_quality.md',
};

/** Explore the codebase, research the web, write the ideas JSON to the output dir */
const IDEATION_TOOLS = [...RESEARCH_TOOLS, 'Write', 'Edit'] as const;

/** Maximum agentic turns per ideation type */
const MAX_TURNS = 30;

// =============================================================================
// Types
// =============================================================================

/** Configuration for running ideation */
export interface IdeationConfig {
  /** Project directory path */
  projectDir: string;
  /** Output directory for results */
  outputDir: string;
  /** Prompts directory containing ideation prompt files */
  promptsDir: string;
  /** Type of ideation to run */
  ideationType: IdeationType;
  /** Model shorthand (defaults to 'sonnet') */
  modelShorthand?: ModelShorthand;
  /** Thinking level (defaults to 'medium') */
  thinkingLevel?: ThinkingLevel;
  /** Maximum ideas per type (defaults to 5) */
  maxIdeasPerType?: number;
  /** Abort signal for cancellation */
  abortSignal?: AbortSignal;
}

/** Result of an ideation run */
export interface IdeationResult {
  /** Whether the run succeeded */
  success: boolean;
  /** Full response text from the agent */
  text: string;
  /** Error message if failed */
  error?: string;
}

/** Callback for streaming events from the ideation runner */
export type IdeationStreamCallback = (event: IdeationStreamEvent) => void;

/** Events emitted during ideation streaming */
export type IdeationStreamEvent =
  | { type: 'text-delta'; text: string }
  | { type: 'tool-use'; name: string }
  | { type: 'error'; error: string };

// =============================================================================
// Ideation Runner
// =============================================================================

/**
 * Run an ideation agent for a specific ideation type.
 *
 * Loads the appropriate prompt, runs a Claude Code session with exploration
 * tools (writes confined to `outputDir`), and streams the response. Mirrors Python's `IdeationGenerator.run_agent()`.
 *
 * @param config - Ideation configuration
 * @param onStream - Optional callback for streaming events
 * @returns Ideation result
 */
export async function runIdeation(
  config: IdeationConfig,
  onStream?: IdeationStreamCallback,
): Promise<IdeationResult> {
  const {
    projectDir,
    outputDir,
    promptsDir,
    ideationType,
    modelShorthand = 'sonnet',
    thinkingLevel = 'medium',
    maxIdeasPerType = 5,
    abortSignal,
  } = config;

  // Load prompt file
  const promptFile = IDEATION_TYPE_PROMPTS[ideationType];
  const promptPath = join(promptsDir, promptFile);

  if (!existsSync(promptPath)) {
    return {
      success: false,
      text: '',
      error: `Prompt not found: ${promptPath}`,
    };
  }

  let prompt: string;
  try {
    prompt = readFileSync(promptPath, 'utf-8');
  } catch (error) {
    return {
      success: false,
      text: '',
      error: `Failed to read prompt: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  // Add context to prompt (matches Python format)
  prompt += `\n\n---\n\n**Output Directory**: ${outputDir}\n`;
  prompt += `**Project Directory**: ${projectDir}\n`;
  prompt += `**Max Ideas**: ${maxIdeasPerType}\n`;

  let responseText = '';
  let lastError: string | undefined;
  const userPrompt = `Analyze the project at ${projectDir} and generate up to ${maxIdeasPerType} ${ideationType.replace(/_/g, ' ')} ideas. Use the available tools to explore the codebase, then write your findings as a JSON file to the output directory.`;

  const onEvent = (event: StreamEvent) => {
    switch (event.type) {
      case 'text-delta': {
        responseText += event.text;
        onStream?.({ type: 'text-delta', text: event.text });
        break;
      }
      case 'tool-call': {
        onStream?.({ type: 'tool-use', name: event.toolName });
        break;
      }
      case 'error': {
        lastError = event.error.message;
        onStream?.({ type: 'error', error: event.error.message });
        break;
      }
    }
  };

  try {
    const result = await runClaudeTask({
      systemPrompt: prompt,
      prompt: userPrompt,
      model: modelShorthand,
      thinkingLevel,
      tools: IDEATION_TOOLS,
      cwd: projectDir,
      specDir: join(projectDir, '.vibe-teamlead', 'specs'),
      allowedWritePaths: [outputDir],
      agentType: 'ideation',
      maxTurns: MAX_TURNS,
      abortSignal,
      onEvent,
    });

    return {
      success: true,
      text: responseText || result.text,
    };
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    if (errorMsg !== lastError) onStream?.({ type: 'error', error: errorMsg });
    return {
      success: false,
      text: responseText,
      error: errorMsg,
    };
  }
}
