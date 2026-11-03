/**
 * Insights Runner
 * ===============
 *
 * AI chat for codebase insights.
 *
 * Provides an AI-powered chat interface for asking questions about a codebase.
 * Can also suggest tasks based on the conversation.
 *
 * Runs one Claude Code session via `runClaudeTask()` with read-only tools
 * (Read, Glob, Grep), streaming text and tool activity to the caller.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { READ_TOOLS, runClaudeTask } from '../claude-code/task';
import type { ModelShorthand, ThinkingLevel } from '../config/types';
import type { StreamEvent } from '../session/types';
import { safeParseJson } from '../../utils/json-repair';
import { parseLLMJson } from '../schema/structured-output';
import { TaskSuggestionSchema } from '../schema/insight-extractor';

// =============================================================================
// Types
// =============================================================================

/** A message in the insights conversation history */
export interface InsightsMessage {
  role: 'user' | 'assistant';
  content: string;
}

/** Configuration for running an insights query */
export interface InsightsConfig {
  /** Project directory path */
  projectDir: string;
  /** For the project's memory (prompt section and tools) */
  projectId?: string;
  /** User message to process */
  message: string;
  /** Previous conversation history */
  history?: InsightsMessage[];
  /** Model shorthand (defaults to 'sonnet') */
  modelShorthand?: ModelShorthand;
  /** Thinking level (defaults to 'medium') */
  thinkingLevel?: ThinkingLevel;
  /** Abort signal for cancellation */
  abortSignal?: AbortSignal;
}

/** Result of an insights query */
export interface InsightsResult {
  /** Full response text */
  text: string;
  /** Task suggestion if detected, or null */
  taskSuggestion: TaskSuggestion | null;
  /** Tool calls made during the session */
  toolCalls: ToolCallInfo[];
}

/** A task suggestion extracted from the response */
export interface TaskSuggestion {
  title: string;
  description: string;
  metadata: {
    category: string;
    complexity: string;
    impact: string;
  };
}

/** Info about a tool call made during the session */
export interface ToolCallInfo {
  name: string;
  input: string;
}

/** Callback for streaming events from the insights runner */
export type InsightsStreamCallback = (event: InsightsStreamEvent) => void;

/** Events emitted during insights streaming */
export type InsightsStreamEvent =
  | { type: 'text-delta'; text: string }
  | { type: 'tool-start'; name: string; input: string }
  | { type: 'tool-end'; name: string }
  | { type: 'error'; error: string };

// =============================================================================
// Project Context Loading
// =============================================================================

/**
 * Load project context for the AI.
 * Mirrors Python's `load_project_context()`.
 */
function loadProjectContext(projectDir: string): string {
  const contextParts: string[] = [];

  // Load project index if available
  const indexPath = join(projectDir, '.vibe-teamlead', 'project_index.json');
  if (existsSync(indexPath)) {
    const index = safeParseJson<Record<string, unknown>>(readFileSync(indexPath, 'utf-8'));
    if (index) {
      const summary = {
        project_root: index.project_root ?? '',
        project_type: index.project_type ?? 'unknown',
        services: Object.keys((index.services as Record<string, unknown>) ?? {}),
        infrastructure: index.infrastructure ?? {},
      };
      contextParts.push(
        `## Project Structure\n\`\`\`json\n${JSON.stringify(summary, null, 2)}\n\`\`\``,
      );
    }
  }

  // Load roadmap if available
  const roadmapPath = join(projectDir, '.vibe-teamlead', 'roadmap', 'roadmap.json');
  if (existsSync(roadmapPath)) {
    const roadmap = safeParseJson<Record<string, unknown>>(readFileSync(roadmapPath, 'utf-8'));
    if (roadmap) {
      const features = ((roadmap.features as Record<string, unknown>[]) ?? []).slice(0, 10);
      const featureSummary = features.map((f: Record<string, unknown>) => ({
        title: f.title ?? '',
        status: f.status ?? '',
      }));
      contextParts.push(
        `## Roadmap Features\n\`\`\`json\n${JSON.stringify(featureSummary, null, 2)}\n\`\`\``,
      );
    }
  }

  // Load existing tasks
  const tasksPath = join(projectDir, '.vibe-teamlead', 'specs');
  if (existsSync(tasksPath)) {
    try {
      const taskDirs = readdirSync(tasksPath, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name)
        .slice(0, 10);
      if (taskDirs.length > 0) {
        contextParts.push(`## Existing Tasks/Specs\n- ${taskDirs.join('\n- ')}`);
      }
    } catch {
      // Ignore read errors
    }
  }

  return contextParts.length > 0
    ? contextParts.join('\n\n')
    : 'No project context available yet.';
}

/**
 * Build the system prompt for the insights agent.
 * Mirrors Python's `build_system_prompt()`.
 */
function buildSystemPrompt(projectDir: string): string {
  const context = loadProjectContext(projectDir);

  return `You are an AI assistant helping developers understand and work with their codebase.
You have access to the following project context:

${context}

Your capabilities:
1. Answer questions about the codebase structure, patterns, and architecture
2. Suggest improvements, features, or bug fixes based on the code
3. Help plan implementation of new features
4. Provide code examples and explanations

When the user asks you to create a task, wants to turn the conversation into a task, or when you believe creating a task would be helpful, output a task suggestion in this exact format on a SINGLE LINE:
__TASK_SUGGESTION__:{"title": "Task title here", "description": "Detailed description of what the task involves", "metadata": {"category": "feature", "complexity": "medium", "impact": "medium"}}

Valid categories: feature, bug_fix, refactoring, documentation, security, performance, ui_ux, infrastructure, testing
Valid complexity: trivial, small, medium, large, complex
Valid impact: low, medium, high, critical

How to work:
- Answer in the language the user writes in.
- Be efficient with tools: start from the project structure above and CodeGraph (callers, definitions) before reading files one by one, read only what the question needs, and answer once you know enough — usually within 15–20 tool calls.
- Check this project's memory ("Project memory" below, and search_memory) for decisions, gotchas and earlier findings; save a durable finding with remember when the user confirms it.
- Use Context7 for library documentation instead of guessing APIs.
- Don't narrate every step; give the answer with file paths and lines.

Be conversational and helpful. Focus on providing actionable insights and clear explanations.
Keep responses concise but informative.`;
}

// =============================================================================
// Task Suggestion Extraction
// =============================================================================

const TASK_SUGGESTION_PREFIX = '__TASK_SUGGESTION__:';

/**
 * Extract a task suggestion from the response text if present.
 */
function extractTaskSuggestion(text: string): TaskSuggestion | null {
  const idx = text.indexOf(TASK_SUGGESTION_PREFIX);
  if (idx === -1) return null;

  // Find the JSON on the same line
  const afterPrefix = text.substring(idx + TASK_SUGGESTION_PREFIX.length);
  const lineEnd = afterPrefix.indexOf('\n');
  const jsonStr = lineEnd === -1 ? afterPrefix.trim() : afterPrefix.substring(0, lineEnd).trim();

  const validated = parseLLMJson(jsonStr, TaskSuggestionSchema);
  if (validated && validated.title && validated.description) {
    return validated as TaskSuggestion;
  }

  return null;
}

// =============================================================================
// Insights Runner
// =============================================================================

/**
 * Run an insights chat query with streaming.
 *
 * @param config - Insights query configuration
 * @param onStream - Optional callback for streaming events
 * @returns Insights result with text, task suggestion, and tool call info
 */
export async function runInsightsQuery(
  config: InsightsConfig,
  onStream?: InsightsStreamCallback,
): Promise<InsightsResult> {
  const {
    projectDir,
    message,
    history = [],
    modelShorthand = 'sonnet',
    thinkingLevel = 'medium',
    abortSignal,
  } = config;

  const systemPrompt = buildSystemPrompt(projectDir);

  // Build conversation context from history
  let fullPrompt = message;
  if (history.length > 0) {
    const conversationContext = history
      .map((msg) => `${msg.role === 'user' ? 'User' : 'Assistant'}: ${msg.content}`)
      .join('\n\n');
    fullPrompt = `Previous conversation:\n${conversationContext}\n\nCurrent question: ${message}`;
  }

  const toolCalls: ToolCallInfo[] = [];
  let responseText = '';
  let lastError: string | undefined;

  const emitError = (error: string) => {
    lastError = error;
    onStream?.({ type: 'error', error });
  };

  // Text from separate turns (before and after tool calls) gets a paragraph break
  let afterTools = false;
  const onEvent = (event: StreamEvent) => {
    switch (event.type) {
      case 'text-delta': {
        const text = afterTools && responseText && !responseText.endsWith('\n') ? `\n\n${event.text}` : event.text;
        afterTools = false;
        responseText += text;
        onStream?.({ type: 'text-delta', text });
        break;
      }
      case 'tool-call': {
        afterTools = true;
        const input = extractToolInput(event.args ?? {});
        toolCalls.push({ name: event.toolName, input });
        onStream?.({ type: 'tool-start', name: event.toolName, input });
        break;
      }
      case 'tool-result': {
        onStream?.({ type: 'tool-end', name: event.toolName });
        break;
      }
      case 'error': {
        emitError(event.error.message);
        break;
      }
    }
  };

  const memory = config.projectId ? await projectMemory(config.projectId, message) : undefined;

  try {
    const result = await runClaudeTask({
      systemPrompt: memory?.section ? `${systemPrompt}\n\n${memory.section}` : systemPrompt,
      prompt: fullPrompt,
      model: modelShorthand,
      thinkingLevel,
      tools: READ_TOOLS,
      cwd: projectDir,
      specDir: join(projectDir, '.vibe-teamlead', 'specs'),
      agentType: 'insights_chat',
      maxTurns: 60,
      abortSignal,
      onEvent,
      memory: memory?.tools,
    });
    // Fall back to the final assistant message if nothing was streamed
    if (!responseText) responseText = result.text;
    if (result.session.outcome === 'max_steps') {
      const note = '\n\n_Stopped at the step limit before finishing. Ask a narrower question, or say "continue"._';
      responseText += note;
      onStream?.({ type: 'text-delta', text: note });
    }
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    // Avoid a duplicate when the session already reported this error
    if (errorMsg !== lastError) emitError(errorMsg);
    throw error;
  }

  const taskSuggestion = extractTaskSuggestion(responseText);

  return {
    text: responseText,
    taskSuggestion,
    toolCalls,
  };
}

// =============================================================================
// Helpers
// =============================================================================

/** The project's memory for the chat: relevant memories up front, and the search/remember tools. */
async function projectMemory(projectId: string, question: string) {
  try {
    const memory = await import('../memory/agent-memory');
    const section = await memory.memoryPromptSection(projectId, question).catch(() => '');
    return {
      section,
      tools: {
        search: async (query: string, limit?: number) => {
          const found = await memory.searchProjectMemory(projectId, query, limit);
          return found.length ? memory.formatMemories(found) : 'No memories match.';
        },
        remember: async (memoryType: string, content: string, files?: string[]) => {
          const type = (memory.AGENT_MEMORY_TYPES as readonly string[]).includes(memoryType)
            ? (memoryType as (typeof memory.AGENT_MEMORY_TYPES)[number])
            : 'gotcha';
          await memory.rememberForAgent({ projectId }, { type, content, files });
          return 'Saved to project memory.';
        },
      },
    };
  } catch {
    return undefined;
  }
}

/**
 * Extract a brief description from tool call args for UI display.
 */
function extractToolInput(args: Record<string, unknown>): string {
  if (args.pattern) return `pattern: ${args.pattern}`;
  if (args.file_path) {
    const fp = String(args.file_path);
    return fp.length > 50 ? `...${fp.slice(-47)}` : fp;
  }
  if (args.path) return String(args.path);
  return '';
}
