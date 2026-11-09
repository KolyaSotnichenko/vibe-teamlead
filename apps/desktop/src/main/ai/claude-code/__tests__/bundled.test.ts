import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { HookInput } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it, vi } from 'vitest';

import { codegraphMcpServer, excludeIndexFromGit } from '../codegraph';
import { buildQueryOptions } from '../runner';
import { FRONTEND_DESIGN_SKILL, qaSkills, skillsForAgent, subtaskSkills, UX_REVIEW_SKILL } from '../skills';
import { PLAYWRIGHT_TOOLS } from '../../config/agent-configs';
import { isUiFile } from '../../design/design-lint';
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
    const all = (['spec_orchestrator', 'coder', 'qa_reviewer', 'qa_fixer', 'planner'] as const).flatMap((a) => skillsForAgent(a));
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
    expect(options.hooks?.PreToolUse).toHaveLength(3); // security, questions, dev server guard
  });

  it('lets agents with Bash stop their background commands, and tells them to', () => {
    const options = buildQueryOptions(config, new AbortController(), { codegraphReady: false });
    expect(options.tools).toContain('TaskStop');
    expect((options.systemPrompt as { append: string }).append).toMatch(/Stop each one with TaskStop/);
    const noBash = buildQueryOptions({ ...config, toolsOverride: ['Read', 'Grep'] }, new AbortController(), { codegraphReady: false });
    expect(noBash.tools).not.toContain('TaskStop');
    expect((noBash.systemPrompt as { append: string }).append).not.toMatch(/Background processes/);
  });

  it('skips CodeGraph when the index is not ready and skills when Superpowers is absent', () => {
    const options = buildQueryOptions({ ...config, bundled: {} }, new AbortController(), { codegraphReady: false });
    expect(options.mcpServers).not.toHaveProperty('codegraph');
    expect(options.plugins).toBeUndefined();
    expect(options.skills).toEqual([]);
  });
});

describe('frontend-design for UI subtasks', () => {
  const base: SessionConfig = {
    agentType: 'coder',
    model: 'claude-sonnet-4-6',
    auth: { apiKey: 'sk-ant-test' },
    systemPrompt: 'You are the coder.',
    initialMessages: [{ role: 'user', content: 'go' }],
    toolContext: { cwd: '/work', projectDir: '/work', specDir: '/work/spec', securityProfile: undefined as never },
    maxSteps: 10,
    specDir: '/work/spec',
    projectDir: '/work',
    bundled: { superpowersDir: '/r/superpowers', frontendDesignDir: '/r/frontend-design' },
  };

  it('picks the skill for subtasks that touch UI files, or name none in a UI project', () => {
    const opts = { isUiFile, projectHasUi: false };
    expect(subtaskSkills(['src/components/Login.tsx', 'src/api/auth.ts'], opts)).toEqual([FRONTEND_DESIGN_SKILL]);
    expect(subtaskSkills(['src/api/auth.ts', 'src/api/__tests__/auth.test.ts'], { ...opts, projectHasUi: true })).toEqual([]);
    expect(subtaskSkills([], { ...opts, projectHasUi: true })).toEqual([FRONTEND_DESIGN_SKILL]);
    expect(subtaskSkills([], opts)).toEqual([]);
  });

  it('loads the plugin, adds the skill and says the design system comes first', () => {
    const options = buildQueryOptions({ ...base, extraSkills: [FRONTEND_DESIGN_SKILL] }, new AbortController(), { codegraphReady: false });
    expect(options.plugins).toContainEqual({ type: 'local', path: '/r/frontend-design' });
    expect(options.skills).toContain(FRONTEND_DESIGN_SKILL);
    expect(options.skills).toContain('superpowers:test-driven-development');
    const append = (options.systemPrompt as { append: string }).append;
    expect(append).toMatch(/design system and the spec come first/);
  });

  it('ships the plugin under the name the skill id uses', () => {
    const root = join(__dirname, '..', '..', '..', '..', '..', 'vendor', 'frontend-design');
    expect(JSON.parse(readFileSync(join(root, '.claude-plugin', 'plugin.json'), 'utf-8')).name).toBe(FRONTEND_DESIGN_SKILL.split(':')[0]);
    expect(readFileSync(join(root, 'skills', 'frontend-design', 'SKILL.md'), 'utf-8')).toMatch(/^name: frontend-design$/m);
    expect(readFileSync(join(root, 'LICENSE.txt'), 'utf-8')).toMatch(/Apache License/);
    const pkg = JSON.parse(readFileSync(join(root, '..', '..', 'package.json'), 'utf-8'));
    expect(pkg.build.extraResources).toContainEqual({ from: 'vendor/frontend-design', to: 'plugins/frontend-design' });
  });

  it('leaves other sessions and builds without the plugin alone', () => {
    const plain = buildQueryOptions(base, new AbortController(), { codegraphReady: false });
    expect(plain.plugins).not.toContainEqual({ type: 'local', path: '/r/frontend-design' });
    expect(plain.skills).not.toContain(FRONTEND_DESIGN_SKILL);
    const missing = buildQueryOptions(
      { ...base, bundled: { superpowersDir: '/r/superpowers' }, extraSkills: [FRONTEND_DESIGN_SKILL] },
      new AbortController(),
      { codegraphReady: false },
    );
    expect(missing.skills).not.toContain(FRONTEND_DESIGN_SKILL);
    expect((missing.systemPrompt as { append: string }).append).not.toMatch(/frontend-design skill/);
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

describe('the UX review for QA on tasks that change UI', () => {
  const reviewer: SessionConfig = {
    agentType: 'qa_reviewer',
    model: 'claude-sonnet-4-6',
    auth: { apiKey: 'sk-ant-test' },
    systemPrompt: 'You are the reviewer.',
    initialMessages: [{ role: 'user', content: 'go' }],
    toolContext: { cwd: '/work', projectDir: '/work', specDir: '/work/spec', securityProfile: undefined as never },
    maxSteps: 10,
    specDir: '/work/spec',
    projectDir: '/work',
    bundled: { superpowersDir: '/r/superpowers', uxReviewDir: '/r/ux-review' },
  };

  it('goes to the reviewer only, and only when the task changed UI files', () => {
    expect(qaSkills('qa_reviewer', true)).toEqual([UX_REVIEW_SKILL]);
    expect(qaSkills('qa_reviewer', false)).toEqual([]);
    expect(qaSkills('qa_reviewer', undefined)).toEqual([]);
    expect(qaSkills('qa_fixer', true)).toEqual([]);
  });

  it('loads the plugin and tells the reviewer to look at the running page, at two widths and by keyboard', () => {
    const options = buildQueryOptions({ ...reviewer, extraSkills: [UX_REVIEW_SKILL] }, new AbortController(), { codegraphReady: false });
    expect(options.plugins).toContainEqual({ type: 'local', path: '/r/ux-review' });
    expect(options.skills).toContain(UX_REVIEW_SKILL);
    const append = (options.systemPrompt as { append: string }).append;
    expect(append).toMatch(/## UX review/);
    expect(append).toMatch(/375/);
    expect(append).toMatch(/1280/);
    expect(append).toMatch(/keyboard/i);
    expect(append).toMatch(/design system/i);
    const plain = buildQueryOptions(reviewer, new AbortController(), { codegraphReady: false });
    expect(plain.plugins).not.toContainEqual({ type: 'local', path: '/r/ux-review' });
    expect((plain.systemPrompt as { append: string }).append).not.toMatch(/## UX review/);
  });

  it('ships the plugin with its sources and their licenses', () => {
    const root = join(__dirname, '..', '..', '..', '..', '..', 'vendor', 'ux-review');
    expect(JSON.parse(readFileSync(join(root, '.claude-plugin', 'plugin.json'), 'utf-8')).name).toBe(UX_REVIEW_SKILL.split(':')[0]);
    const skill = readFileSync(join(root, 'skills', 'ux-review', 'SKILL.md'), 'utf-8');
    expect(skill).toMatch(/^name: ux-review$/m);
    for (const ref of ['web-interface-guidelines.md', 'impeccable-audit.md', 'impeccable-harden.md']) {
      expect(skill).toContain(`reference/${ref}`);
      expect(readFileSync(join(root, 'skills', 'ux-review', 'reference', ref), 'utf-8').length).toBeGreaterThan(1000);
    }
    expect(readFileSync(join(root, 'licenses', 'web-interface-guidelines.LICENSE'), 'utf-8')).toMatch(/MIT License/);
    expect(readFileSync(join(root, 'licenses', 'impeccable.LICENSE'), 'utf-8')).toMatch(/Apache License/);
    expect(readFileSync(join(root, 'licenses', 'impeccable.NOTICE.md'), 'utf-8')).toMatch(/Third-Party Notices/);
    const pkg = JSON.parse(readFileSync(join(root, '..', '..', 'package.json'), 'utf-8'));
    expect(pkg.build.extraResources).toContainEqual({ from: 'vendor/ux-review', to: 'plugins/ux-review' });
  });

  it('gives QA the browser tools to resize the page and use the keyboard', () => {
    expect(PLAYWRIGHT_TOOLS).toContain('mcp__playwright__browser_resize');
    expect(PLAYWRIGHT_TOOLS).toContain('mcp__playwright__browser_press_key');
    expect(PLAYWRIGHT_TOOLS).toContain('mcp__playwright__browser_emulate_media');
  });
});
