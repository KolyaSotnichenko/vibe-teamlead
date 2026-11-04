import type { HookInput } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it } from 'vitest';

import { backgroundTaskId, buildBackgroundTaskHooks } from '../background-tasks';
import { buildQueryOptions } from '../runner';
import type { SessionConfig } from '../../session/types';

const signal = new AbortController().signal;
const common = { session_id: 's', transcript_path: '', cwd: '/w' };

function post(tool_name: string, tool_input: unknown, tool_response: unknown): HookInput {
  return { ...common, hook_event_name: 'PostToolUse', tool_name, tool_input, tool_response, tool_use_id: 't' } as HookInput;
}
function failed(tool_name: string, tool_input: unknown): HookInput {
  return { ...common, hook_event_name: 'PostToolUseFailure', tool_name, tool_input, error: 'gone', tool_use_id: 't' } as HookInput;
}
const stop = (active = false) => ({ ...common, hook_event_name: 'Stop', stop_hook_active: active }) as HookInput;

async function fire(hooks: ReturnType<typeof buildBackgroundTaskHooks>, input: HookInput) {
  const list =
    input.hook_event_name === 'Stop' ? hooks.Stop : input.hook_event_name === 'PostToolUse' ? hooks.PostToolUse : hooks.PostToolUseFailure;
  const matcher = list[0];
  if ('tool_name' in input && matcher.matcher && !new RegExp(`^(${matcher.matcher})$`).test(input.tool_name)) return {};
  return matcher.hooks[0](input, 't', { signal });
}

describe('background task id', () => {
  it('reads the structured field or the printed line', () => {
    expect(backgroundTaskId({ stdout: '', backgroundTaskId: 'bw4h0odm5' })).toBe('bw4h0odm5');
    expect(backgroundTaskId('Command running in background with ID: b32xv76r5. Output is being written to …')).toBe('b32xv76r5');
    expect(backgroundTaskId({ stdout: 'ok' })).toBeUndefined();
  });
});

describe('background task hooks', () => {
  it('holds the final stop once until the agent stops what it started', async () => {
    const hooks = buildBackgroundTaskHooks();
    await fire(hooks, post('Bash', { command: 'npm run dev', run_in_background: true }, { backgroundTaskId: 'api' }));
    await fire(hooks, post('Bash', { command: 'vite', run_in_background: true }, { backgroundTaskId: 'web' }));
    await fire(hooks, post('Bash', { command: 'npm test' }, { stdout: 'ok' }));
    expect(hooks.running()).toEqual(['api', 'web']);

    const held = (await fire(hooks, stop())) as { decision?: string; reason?: string };
    expect(held.decision).toBe('block');
    expect(held.reason).toMatch(/TaskStop/);
    expect(held.reason).toContain('api, web');

    // Asked once: the agent's next stop goes through even if it didn't comply
    expect(await fire(hooks, stop(true))).toEqual({});
  });

  it('lets the agent finish once each task is stopped or already gone', async () => {
    const hooks = buildBackgroundTaskHooks();
    await fire(hooks, post('Bash', {}, { backgroundTaskId: 'api' }));
    await fire(hooks, post('Bash', {}, { backgroundTaskId: 'web' }));
    await fire(hooks, post('TaskStop', { task_id: 'api' }, { message: 'stopped' }));
    await fire(hooks, failed('TaskStop', { shell_id: 'web' }));
    expect(hooks.running()).toEqual([]);
    expect(await fire(hooks, stop())).toEqual({});
  });

  it('is wired into sessions that can run Bash', () => {
    const config = {
      agentType: 'qa_reviewer',
      model: 'claude-sonnet-4-6',
      auth: { apiKey: 'sk-ant-test' },
      systemPrompt: 'QA',
      initialMessages: [{ role: 'user', content: 'go' }],
      toolContext: { cwd: '/w', projectDir: '/w', specDir: '/w/spec', securityProfile: undefined as never },
      maxSteps: 10,
      specDir: '/w/spec',
      projectDir: '/w',
      bundled: {},
    } as SessionConfig;
    const options = buildQueryOptions(config, new AbortController(), { codegraphReady: false });
    expect(options.tools).toContain('Bash');
    expect(options.hooks?.Stop).toHaveLength(1);
    expect(options.hooks?.PostToolUse?.[0].matcher).toBe('Bash|TaskStop');
  });
});
