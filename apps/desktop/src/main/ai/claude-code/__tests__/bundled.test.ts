import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { HookInput } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it, vi } from 'vitest';

import { codegraphMcpServer, excludeIndexFromGit } from '../codegraph';
import { buildQueryOptions } from '../runner';
import { skillsForAgent } from '../skills';
import { type AgentQuestion, buildAskUserHook } from '../user-questions';
import type { SessionConfig } from '../../session/types';

const questions: AgentQuestion[] = [
  {
    question: 'Which database?',
    header: 'Database',
    multiSelect: false,
    options: [
      { label: 'PostgreSQL', description: 'Relational' },
      { label: 'SQLite', description: 'Embedded' },
    ],
  },
];

function preToolUse(toolInput: unknown): HookInput {
  return {
    hook_event_name: 'PreToolUse',
    tool_name: 'AskUserQuestion',
    tool_input: toolInput,
    tool_use_id: 't1',
    session_id: 's',
    transcript_path: '',
    cwd: '/tmp',
  } as HookInput;
}

const signal = new AbortController().signal;

describe('AskUserQuestion hook', () => {
  it('returns the user answers as the tool input', async () => {
    const ask = vi.fn().mockResolvedValue({ 'Which database?': 'PostgreSQL' });
    const hook = buildAskUserHook(ask);
    expect(hook.matcher).toBe('AskUserQuestion');

    const out = (await hook.hooks[0](preToolUse({ questions }), 't1', { signal })) as {
      hookSpecificOutput: { permissionDecision: string; updatedInput: Record<string, unknown> };
    };
    expect(ask).toHaveBeenCalledWith(questions, signal);
    expect(out.hookSpecificOutput.permissionDecision).toBe('allow');
    expect(out.hookSpecificOutput.updatedInput.answers).toEqual({ 'Which database?': 'PostgreSQL' });
  });

  it('tells the agent to proceed on an assumption when nobody answers', async () => {
    for (const hook of [buildAskUserHook(), buildAskUserHook(vi.fn().mockResolvedValue(null))]) {
      const out = (await hook.hooks[0](preToolUse({ questions }), 't1', { signal })) as {
        hookSpecificOutput: { permissionDecision: string; permissionDecisionReason: string };
      };
      expect(out.hookSpecificOutput.permissionDecision).toBe('deny');
      expect(out.hookSpecificOutput.permissionDecisionReason).toMatch(/assumption/);
    }
  });
});

describe('skillsForAgent', () => {
  it('gives brainstorming to the spec stage and TDD to coders, never workflow skills', () => {
    expect(skillsForAgent('spec_gatherer')).toEqual(['superpowers:brainstorming']);
    expect(skillsForAgent('coder')).toContain('superpowers:test-driven-development');
    const all = (['spec_orchestrator', 'coder', 'qa_reviewer', 'qa_fixer', 'planner'] as const).flatMap(skillsForAgent);
    expect(all).not.toContain('superpowers:using-git-worktrees');
    expect(all).not.toContain('superpowers:finishing-a-development-branch');
  });
});

describe('bundled tools in query options', () => {
  const config: SessionConfig = {
    agentType: 'coder',
    model: 'claude-sonnet-4-6',
    auth: { apiKey: 'sk-ant-test' },
    systemPrompt: 'You are the coder.',
    initialMessages: [{ role: 'user', content: 'go' }],
    toolContext: { cwd: '/work', projectDir: '/work', specDir: '/work/spec', securityProfile: undefined as never },
    maxSteps: 10,
    specDir: '/work/spec',
    projectDir: '/work',
    bundled: {
      claudeCodeExecutable: '/app/Resources/claude-code/claude',
      superpowersDir: '/app/Resources/plugins/superpowers',
      codegraphBin: '/app/Resources/codegraph/bin/codegraph',
    },
  };

  it('uses the bundled Claude Code, Superpowers plugin and CodeGraph MCP', () => {
    const options = buildQueryOptions(config, new AbortController(), { codegraphReady: true });
    expect(options.pathToClaudeCodeExecutable).toBe('/app/Resources/claude-code/claude');
    expect(options.plugins).toEqual([{ type: 'local', path: '/app/Resources/plugins/superpowers' }]);
    expect(options.skills).toContain('superpowers:test-driven-development');
    expect(options.mcpServers?.codegraph).toMatchObject({
      command: '/app/Resources/codegraph/bin/codegraph',
      args: ['serve', '--mcp', '--path', '/work'],
    });
    expect(options.tools).toContain('AskUserQuestion');
    expect(options.hooks?.PreToolUse).toHaveLength(2);
  });

  it('skips CodeGraph when the index is not ready and skills when Superpowers is absent', () => {
    const options = buildQueryOptions({ ...config, bundled: {} }, new AbortController(), { codegraphReady: false });
    expect(options.mcpServers).not.toHaveProperty('codegraph');
    expect(options.plugins).toBeUndefined();
    expect(options.skills).toEqual([]);
  });
});

describe('CodeGraph helpers', () => {
  it('builds a telemetry-free stdio server', () => {
    const server = codegraphMcpServer('/bin/codegraph', '/repo');
    expect(server.env?.CODEGRAPH_TELEMETRY).toBe('0');
    expect(server.env?.CODEGRAPH_NO_DOWNLOAD).toBe('1');
  });

  it('excludes .codegraph/ via .git/info/exclude exactly once', () => {
    const repo = mkdtempSync(join(tmpdir(), 'vtl-cg-'));
    execFileSync('git', ['init', '-q'], { cwd: repo });
    writeFileSync(join(repo, '.git', 'info', 'exclude'), '# existing');
    excludeIndexFromGit(repo);
    excludeIndexFromGit(repo);
    const exclude = readFileSync(join(repo, '.git', 'info', 'exclude'), 'utf-8');
    expect(exclude.match(/^\.codegraph\/$/gm)).toHaveLength(1);
    expect(exclude).toContain('# existing');
  });
});
