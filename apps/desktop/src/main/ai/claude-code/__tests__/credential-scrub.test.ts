import { describe, expect, it } from 'vitest';

import { CLAUDE_CREDENTIAL_ENV, evaluatePreToolUse, withoutClaudeCredentials } from '../security-hooks';
import type { ToolContext } from '../../tools/types';

const context: ToolContext = {
  cwd: '/work/tree',
  projectDir: '/work/tree',
  specDir: '/work/tree/.vibe-teamlead/specs/001-demo',
  securityProfile: undefined as never,
};

type Output = { hookSpecificOutput?: { permissionDecision?: string; updatedInput?: Record<string, unknown> } };
const UNSET = `unset ${CLAUDE_CREDENTIAL_ENV.join(' ')}; `;

// F-001: Claude Code hands its own environment to every Bash command, and the app's key is in it
describe("the app's Claude credential in the commands an agent runs", () => {
  it('names the key, the token and the gateway they go to', () => {
    expect(CLAUDE_CREDENTIAL_ENV).toEqual(
      expect.arrayContaining(['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'CLAUDE_CODE_OAUTH_TOKEN']),
    );
  });

  it('is removed before the command starts: project tests and install scripts never see it', () => {
    const output = evaluatePreToolUse('Bash', { command: 'node scripts/seed.js', description: 'seed' }, context) as Output;
    expect(output.hookSpecificOutput?.permissionDecision).toBe('allow');
    expect(output.hookSpecificOutput?.updatedInput).toEqual({ command: `${UNSET}node scripts/seed.js`, description: 'seed' });
    // A test run is also shortened (output-trim.ts), still after the unset
    const tests = evaluatePreToolUse('Bash', { command: 'npm test' }, context) as Output;
    expect((tests.hookSpecificOutput?.updatedInput as { command: string }).command.startsWith(UNSET)).toBe(true);
  });

  it('leaves the command itself as the agent wrote it, a heredoc included', () => {
    const command = "cat > notes.md <<'EOF'\nANTHROPIC_API_KEY is read from the environment\nEOF";
    expect(withoutClaudeCredentials(command)).toBe(`${UNSET}${command}`);
  });

  it('is not added twice', () => {
    expect(withoutClaudeCredentials(withoutClaudeCredentials('ls'))).toBe(`${UNSET}ls`);
  });

  it('leaves an empty command empty', () => {
    expect(withoutClaudeCredentials('')).toBe('');
    expect(evaluatePreToolUse('Bash', {}, context)).toEqual({});
  });

  it('is removed from a command that starts a container too', () => {
    const output = evaluatePreToolUse('Bash', { command: 'docker run -d pg' }, context) as Output;
    expect(output.hookSpecificOutput?.updatedInput?.command).toBe(`${UNSET}docker run --label 'vibe-teamlead.task-folder=/work/tree' -d pg`);
  });

  it('does not turn a denied command into an allowed one', () => {
    const output = evaluatePreToolUse('Bash', { command: 'git push origin main' }, { ...context, agentType: 'qa_reviewer' }) as Output;
    expect(output.hookSpecificOutput?.permissionDecision).toBe('deny');
    expect(output.hookSpecificOutput?.updatedInput).toBeUndefined();
  });
});
