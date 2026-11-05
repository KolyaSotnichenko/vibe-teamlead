import type { HookInput } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it } from 'vitest';

import { backgroundTaskId, buildBackgroundTaskHooks } from '../background-tasks';
import { browserToolsSection, buildQueryOptions } from '../runner';
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
    expect((options.systemPrompt as { append: string }).append).toContain('Keeping your context small');
  });
});

describe('dev server guard', () => {
  const session = (agentType: string) =>
    ({
      agentType,
      model: 'claude-sonnet-4-6',
      auth: { apiKey: 'sk-ant-test' },
      systemPrompt: 'x',
      initialMessages: [{ role: 'user', content: 'go' }],
      toolContext: { cwd: '/w', projectDir: '/w', specDir: '/w/spec', securityProfile: undefined as never },
      maxSteps: 10,
      specDir: '/w/spec',
      projectDir: '/w',
      bundled: {},
    }) as unknown as SessionConfig;

  const ask = async (agentType: string, command: string) => {
    const options = buildQueryOptions(session(agentType), new AbortController(), { codegraphReady: false });
    const matchers = options.hooks?.PreToolUse ?? [];
    const results = [];
    for (const m of matchers.filter((x) => x.matcher === 'Bash')) {
      for (const h of m.hooks) {
        results.push(await h({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command } } as never, 'id', { signal: new AbortController().signal }));
      }
    }
    return JSON.stringify(results);
  };

  it('sends dev servers started with Bash to the tool', async () => {
    expect(await ask('qa_reviewer', '(cd apps/web && pnpm run dev) > /tmp/web.log &')).toContain('start_dev_server');
    expect(await ask('coder', 'pnpm dev')).toContain('start_dev_server');
  });

  it('leaves other commands alone', async () => {
    expect(await ask('qa_reviewer', 'pnpm test')).not.toContain('start_dev_server');
  });
});

describe('browser tools section', () => {
  it('names the browser tools QA really has', () => {
    const s = browserToolsSection('qa_reviewer', ['vibe-teamlead', 'playwright'], { is_web_frontend: true });
    expect(s).toContain('`mcp__playwright__*`');
    expect(s).toMatch(/No other browser tools/);
  });

  it('tells QA there are none, and why, so it never probes for one', () => {
    expect(browserToolsSection('qa_reviewer', ['context7'], { is_web_frontend: false })).toMatch(/None \(this project has no web or desktop UI\)\. Don't call/);
    expect(browserToolsSection('qa_reviewer', ['context7'], { is_web_frontend: true }, false)).toMatch(/None \(this task changed no UI file, so visual verification is N\/A\)\. Don't call/);
    expect(browserToolsSection('qa_fixer', [], { is_web_frontend: true })).toMatch(/turned off, not bundled in this build, or could not start/);
  });

  it('is only for QA, and reaches the QA system prompt', () => {
    expect(browserToolsSection('coder', [], undefined)).toBe('');
    const options = buildQueryOptions(
      {
        agentType: 'qa_reviewer',
        model: 'm',
        auth: { apiKey: 'sk-ant-test' },
        systemPrompt: 'QA',
        initialMessages: [{ role: 'user', content: 'go' }],
        toolContext: { cwd: '/w', projectDir: '/w', specDir: '/w/spec', securityProfile: undefined as never },
        maxSteps: 10,
        specDir: '/w/spec',
        projectDir: '/w',
        bundled: {},
        mcpOptions: { projectCapabilities: { is_web_frontend: false } },
      } as SessionConfig,
      new AbortController(),
      { codegraphReady: false },
    );
    expect((options.systemPrompt as { append: string }).append).toMatch(/## Browser tools in this session\nNone/);
  });
});
