import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

import { AUTO_COMPACT_WINDOW, autoCompactWindow, compactInstructions, compactionLogLine, compactSettings, echoCommand } from '../compaction';
import { buildEnv, buildQueryOptions } from '../runner';
import type { SessionConfig } from '../../session/types';
import type { ToolContext } from '../../tools/types';
import { isWindowsHost } from '../../../platform/__tests__/host';

const toolContext: ToolContext = {
  cwd: '/work/tree',
  projectDir: '/work/tree',
  specDir: '/work/tree/.vibe-teamlead/specs/001-demo',
  securityProfile: undefined as never,
};

function config(overrides: Partial<SessionConfig> = {}): SessionConfig {
  return {
    agentType: 'coder',
    model: 'claude-haiku-5-5',
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

describe('auto-compact window per agent type', () => {
  it('designer, coder and QA fixer compact well before the 1M window; Claude Code accepts 100K..1M', () => {
    for (const agentType of ['designer', 'coder', 'qa_fixer'] as const) {
      const window = autoCompactWindow(agentType);
      expect(window).toBeDefined();
      expect(window).toBeGreaterThanOrEqual(100_000);
      expect(window).toBeLessThanOrEqual(1_000_000);
    }
    // Clears rebuild the cache: the threshold (window - ~33K) stays far above where a session starts (30-40K)
    expect(autoCompactWindow('designer')! - 33_000).toBeGreaterThan(3 * 40_000);
  });

  it('short agents keep Claude Code’s default', () => {
    for (const agentType of ['planner', 'spec_writer', 'qa_reviewer', 'architect'] as const) {
      expect(autoCompactWindow(agentType)).toBeUndefined();
    }
  });

  it('goes to the session as CLAUDE_CODE_AUTO_COMPACT_WINDOW', () => {
    expect(buildEnv(config({ agentType: 'designer' })).CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBe(String(AUTO_COMPACT_WINDOW.designer));
    expect(buildEnv(config({ agentType: 'coder' })).CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBe(String(AUTO_COMPACT_WINDOW.coder));
    expect(buildEnv(config({ agentType: 'planner' })).CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBeUndefined();
  });

  it('a window from the host environment never reaches the session', () => {
    process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW = '100000';
    process.env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE = '10';
    try {
      const env = buildEnv(config({ agentType: 'planner' }));
      expect(env.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBeUndefined();
      expect(env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE).toBeUndefined();
    } finally {
      delete process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW;
      delete process.env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE;
    }
  });
});

describe('compaction instructions per role', () => {
  it('coder: subtask, failing test and its file, files changed, what is left', () => {
    const text = compactInstructions('coder', '2.3')!;
    expect(text).toContain('2.3');
    expect(text).toMatch(/failing test/i);
    expect(text).toMatch(/files? (you )?changed/i);
    expect(text).toMatch(/left/i);
  });

  it('designer: frames done and left, the owner’s comments, design-system decisions', () => {
    const text = compactInstructions('designer')!;
    expect(text).toMatch(/frames/i);
    expect(text).toMatch(/owner/i);
    expect(text).toMatch(/token/i);
  });

  it('QA fixer: issues fixed and left', () => {
    expect(compactInstructions('qa_fixer')).toMatch(/issues?/i);
  });

  it('none for agents that keep the default window', () => {
    expect(compactInstructions('planner')).toBeUndefined();
    expect(compactSettings('planner')).toBeUndefined();
  });

  it('a subtask id that could break the shell command is left out', () => {
    expect(compactInstructions('coder', "1'; rm -rf ~ #")).not.toContain("'");
    expect(compactInstructions('coder', 'a\\b')).not.toContain('\\');
  });
});

describe('PreCompact hook command', () => {
  it('is a command hook in the session’s flag settings that prints the instructions', () => {
    const settings = compactSettings('designer')!;
    const hooks = settings.hooks?.PreCompact;
    expect(hooks).toHaveLength(1);
    expect(hooks![0].matcher).toBeUndefined(); // manual and auto
    expect(hooks![0].hooks[0]).toMatchObject({ type: 'command' });
    const options = buildQueryOptions(config({ agentType: 'designer' }), new AbortController());
    expect(options.settings).toEqual(settings);
    expect(buildQueryOptions(config({ agentType: 'planner' }), new AbortController()).settings).toBeUndefined();
  });

  it('is quoted the same way in bash, zsh and PowerShell: one line, single quotes, no backslash', () => {
    for (const agentType of ['designer', 'coder', 'qa_fixer'] as const) {
      const text = compactInstructions(agentType, '1.1')!;
      expect(text).not.toMatch(/['\\\n\r]/);
      expect(echoCommand(text)).toBe(`echo '${text}'`);
    }
    expect(() => echoCommand("it's")).toThrow();
    expect(() => echoCommand('a\nb')).toThrow();
    expect(() => echoCommand('a\\nb')).toThrow();
  });

  it.skipIf(isWindowsHost)('prints exactly the instructions when bash runs it', () => {
    const text = compactInstructions('coder', '3.1')!;
    const run = spawnSync('bash', ['-c', echoCommand(text)], { encoding: 'utf-8' });
    expect(run.status).toBe(0);
    expect(run.stdout).toBe(`${text}\n`);
  });

  it.skipIf(isWindowsHost || spawnSync('zsh', ['-c', 'true']).status !== 0)('and when zsh runs it (macOS $SHELL)', () => {
    const text = compactInstructions('designer')!;
    const run = spawnSync('zsh', ['-c', echoCommand(text)], { encoding: 'utf-8' });
    expect(run.stdout).toBe(`${text}\n`);
  });
});

describe('task log line when a session compacts', () => {
  it('says when and how much', () => {
    expect(compactionLogLine('designer', { trigger: 'auto', pre_tokens: 168_400, post_tokens: 52_100 })).toBe(
      'designer session compacted (auto): context 168K → 52K tokens',
    );
    expect(compactionLogLine('coder', { trigger: 'manual', pre_tokens: 90_000 })).toBe('coder session compacted (manual): context 90K tokens');
  });
});
