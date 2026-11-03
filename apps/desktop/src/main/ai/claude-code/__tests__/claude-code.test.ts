import { describe, expect, it, vi } from 'vitest';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';

import { SessionAccumulator } from '../event-mapper';
import { buildEnv, buildQueryOptions, resolveBuiltinTools, runAgentSession } from '../runner';
import { evaluatePreToolUse } from '../security-hooks';
import type { SessionConfig, StreamEvent } from '../../session/types';
import type { ToolContext } from '../../tools/types';

const toolContext: ToolContext = {
  cwd: '/work/tree',
  projectDir: '/work/tree',
  specDir: '/work/tree/.auto-claude/specs/001-demo',
  securityProfile: undefined as never,
};

function baseConfig(overrides: Partial<SessionConfig> = {}): SessionConfig {
  return {
    agentType: 'coder',
    model: 'claude-sonnet-4-6',
    auth: { apiKey: 'sk-ant-test' },
    systemPrompt: 'You are the coder.',
    initialMessages: [{ role: 'user', content: 'Implement subtask 1' }],
    toolContext,
    maxSteps: 50,
    specDir: toolContext.specDir,
    projectDir: toolContext.projectDir,
    ...overrides,
  };
}

const msg = (m: unknown) => m as SDKMessage;

describe('SessionAccumulator', () => {
  it('maps SDK messages to stream events and totals', () => {
    const events: StreamEvent[] = [];
    const acc = new SessionAccumulator((e) => events.push(e));

    acc.handle(msg({ type: 'system', subtype: 'init', session_id: 's-1' }));
    acc.handle(msg({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hi' } } }));
    acc.handle(msg({
      type: 'assistant',
      message: {
        id: 'm1',
        usage: { input_tokens: 10, output_tokens: 5 },
        content: [
          { type: 'text', text: 'Reading file' },
          { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: 'a.ts' } },
        ],
      },
    }));
    acc.handle(msg({
      type: 'user',
      message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: 'ok' }] }] },
    }));
    acc.handle(msg({
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: 'done',
      total_cost_usd: 0.12,
      usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 50, cache_creation_input_tokens: 0 },
    }));

    expect(events.map((e) => e.type)).toEqual(['text-delta', 'tool-call', 'tool-result', 'step-finish', 'usage-update']);
    expect(events[2]).toMatchObject({ toolName: 'Read', result: 'ok', isError: false });
    expect(acc.sessionId).toBe('s-1');
    expect(acc.stepsExecuted).toBe(1);
    expect(acc.toolCallCount).toBe(1);
    expect(acc.usage).toMatchObject({ promptTokens: 150, completionTokens: 20, totalTokens: 170 });
    expect(acc.messages).toEqual([{ role: 'assistant', content: 'Reading file' }]);
    expect(acc.resolveOutcome(false).outcome).toBe('completed');
  });

  it('classifies max turns, rate limits, auth and aborts', () => {
    const maxTurns = new SessionAccumulator(() => undefined);
    maxTurns.handle(msg({ type: 'result', subtype: 'error_max_turns', is_error: true, errors: [], usage: {} }));
    expect(maxTurns.resolveOutcome(false).outcome).toBe('max_steps');

    const limited = new SessionAccumulator(() => undefined);
    limited.handle(msg({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected' } }));
    expect(limited.resolveOutcome(false).outcome).toBe('rate_limited');

    const auth = new SessionAccumulator(() => undefined);
    auth.handle(msg({ type: 'assistant', error: 'authentication_failed', message: { id: 'm', content: [] } }));
    expect(auth.resolveOutcome(false).outcome).toBe('auth_failure');

    expect(new SessionAccumulator(() => undefined).resolveOutcome(true).outcome).toBe('cancelled');
  });
});

describe('resolveBuiltinTools', () => {
  it('maps SpawnSubagent to Agent and keeps Claude Code tools only', () => {
    const tools = resolveBuiltinTools(['Read', 'Write', 'Bash', 'SpawnSubagent', 'mcp__x__y'], false);
    expect(tools).toEqual(expect.arrayContaining(['Read', 'Write', 'Bash', 'Agent', 'TodoWrite', 'Skill']));
    expect(tools).not.toContain('mcp__x__y');
    expect(tools).not.toContain('SpawnSubagent');
  });
});

describe('buildQueryOptions', () => {
  it('runs Claude Code with the role prompt, API key auth and security hooks', () => {
    const options = buildQueryOptions(
      baseConfig({ thinkingLevel: 'high', outputSchema: z.object({ ok: z.boolean() }) }),
      new AbortController(),
    );
    expect(options.systemPrompt).toMatchObject({ type: 'preset', preset: 'claude_code' });
    const append = (options.systemPrompt as { append: string }).append;
    expect(append.startsWith('You are the coder.')).toBe(true);
    expect(append).toContain('AskUserQuestion');
    expect(options.cwd).toBe('/work/tree');
    expect(options.maxTurns).toBe(50);
    expect(options.effort).toBe('high');
    expect(options.permissionMode).toBe('bypassPermissions');
    expect(options.env?.ANTHROPIC_API_KEY).toBe('sk-ant-test');
    expect(options.env?.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expect(options.env?.CLAUDE_CONFIG_DIR).toMatch(/\.vibe-teamlead/);
    expect(options.hooks?.PreToolUse).toHaveLength(2);
    expect(options.mcpServers).toHaveProperty('auto-claude');
    expect(options.outputFormat?.type).toBe('json_schema');
  });
});

describe('buildEnv', () => {
  it('does not leak host Claude credentials into the session', () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'host-token';
    process.env.ANTHROPIC_AUTH_TOKEN = 'host-auth';
    try {
      const env = buildEnv(baseConfig({ claudeConfigDir: '/tmp/vtl' }));
      expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
      expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
      expect(env.ANTHROPIC_API_KEY).toBe('sk-ant-test');
      expect(env.CLAUDE_CONFIG_DIR).toBe('/tmp/vtl');
      expect(env.PATH).toBe(process.env.PATH);
    } finally {
      delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
      delete process.env.ANTHROPIC_AUTH_TOKEN;
    }
  });
});

describe('runAgentSession', () => {
  it('fails fast with auth_failure when no API key is configured', async () => {
    const onEvent = vi.fn();
    const result = await runAgentSession(baseConfig({ auth: {} }), { onEvent });
    expect(result.outcome).toBe('auth_failure');
    expect(onEvent).toHaveBeenCalledWith(expect.objectContaining({ type: 'error' }));
  });
});

describe('evaluatePreToolUse', () => {
  it('confines writes to allowedWritePaths', () => {
    const ctx = { ...toolContext, allowedWritePaths: [toolContext.specDir] };
    expect(evaluatePreToolUse('Write', { file_path: `${toolContext.specDir}/spec.md` }, ctx)).toEqual({});
    const denied = evaluatePreToolUse('Edit', { file_path: 'src/index.ts' }, ctx) as {
      hookSpecificOutput: { permissionDecision: string };
    };
    expect(denied.hookSpecificOutput.permissionDecision).toBe('deny');
  });

  it('ignores read-only tools', () => {
    expect(evaluatePreToolUse('Read', { file_path: '/etc/passwd' }, toolContext)).toEqual({});
  });
});
