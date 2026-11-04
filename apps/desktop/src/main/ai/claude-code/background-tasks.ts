/**
 * Background tasks an agent leaves running (a dev server for QA, a watcher)
 * keep the session open until they time out, then wake the agent for another
 * full-context turn just to say so. These hooks track the tasks the session
 * starts with Bash `run_in_background` and stops with TaskStop, and hold the
 * agent's final stop once until it has stopped the rest.
 */

import type { HookCallbackMatcher, HookInput, HookJSONOutput } from '@anthropic-ai/claude-agent-sdk';

/** The background task id in a Bash result: the structured field, or the line Claude Code prints. Pure. */
export function backgroundTaskId(response: unknown): string | undefined {
  if (response && typeof response === 'object') {
    const id = (response as { backgroundTaskId?: unknown }).backgroundTaskId;
    if (typeof id === 'string' && id) return id;
  }
  const text = typeof response === 'string' ? response : response ? JSON.stringify(response) : '';
  return /running in background with ID:\s*([\w-]+)/i.exec(text)?.[1];
}

function stoppedTaskId(input: unknown): string | undefined {
  const i = (input ?? {}) as { task_id?: unknown; shell_id?: unknown };
  const id = i.task_id ?? i.shell_id;
  return typeof id === 'string' && id ? id : undefined;
}

export function stopReminder(ids: string[]): string {
  return `Before finishing, stop the background tasks you started and haven't stopped: ${ids.join(', ')}. Call TaskStop with each task_id (one that has already ended can be skipped), then end your turn. Don't restart anything.`;
}

export interface BackgroundTaskHooks {
  PostToolUse: HookCallbackMatcher[];
  PostToolUseFailure: HookCallbackMatcher[];
  Stop: HookCallbackMatcher[];
  /** Tasks started and not yet stopped */
  running(): string[];
}

export function buildBackgroundTaskHooks(): BackgroundTaskHooks {
  const running = new Set<string>();

  const afterTool = async (input: HookInput): Promise<HookJSONOutput> => {
    if (input.hook_event_name !== 'PostToolUse' && input.hook_event_name !== 'PostToolUseFailure') return {};
    if (input.tool_name === 'Bash' && input.hook_event_name === 'PostToolUse') {
      const id = backgroundTaskId(input.tool_response);
      if (id) running.add(id);
    } else if (input.tool_name === 'TaskStop') {
      // Stopped, or already gone (the stop failed): either way nothing is left running
      const id = stoppedTaskId(input.tool_input);
      if (id) running.delete(id);
    }
    return {};
  };

  const beforeStop = async (input: HookInput): Promise<HookJSONOutput> => {
    if (input.hook_event_name !== 'Stop') return {};
    // Ask once: a second stop goes through, so a task that ended by itself can't loop the agent
    if (input.stop_hook_active || running.size === 0) return {};
    return { decision: 'block', reason: stopReminder([...running]) };
  };

  return {
    PostToolUse: [{ matcher: 'Bash|TaskStop', hooks: [afterTool] }],
    PostToolUseFailure: [{ matcher: 'TaskStop', hooks: [afterTool] }],
    Stop: [{ hooks: [beforeStop] }],
    running: () => [...running],
  };
}
