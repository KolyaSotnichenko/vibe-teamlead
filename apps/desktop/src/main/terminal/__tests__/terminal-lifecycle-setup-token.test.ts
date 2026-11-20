import { beforeEach, describe, expect, it, vi } from 'vitest';

const write = vi.fn();
const spawnPtyProcess = vi.fn();
const tools: { claudeCodeExecutable?: string } = {};

vi.mock('../pty-manager', () => ({
  spawnPtyProcess: (...args: unknown[]) => spawnPtyProcess(...args),
  setupPtyHandlers: vi.fn(),
}));
vi.mock('../session-handler', () => ({ clearPendingDelete: vi.fn(), persistSessionAsync: vi.fn() }));
vi.mock('../../ipc-handlers/utils', () => ({ safeSendToRenderer: vi.fn() }));
vi.mock('../../claude-code-settings', () => ({ getClaudeCodeEnv: () => ({ ANTHROPIC_BASE_URL: 'https://from-settings', FOO: 'bar' }) }));
vi.mock('../../ai/claude-code/bundled-tools', () => ({ resolveBundledTools: () => tools }));
vi.mock('../../platform', () => ({ isWindows: () => false, getPlatformKey: () => 'darwin' }));

import { createTerminal } from '../terminal-lifecycle';

const BINARY = '/Applications/Vibe Teamlead.app/Contents/Resources/claude-code/claude';

describe('createTerminal with the setup-token launch', () => {
  beforeEach(() => {
    write.mockReset();
    spawnPtyProcess.mockReset();
    spawnPtyProcess.mockReturnValue({ pty: { pid: 1, write }, shellType: undefined, shell: '/bin/zsh' });
    tools.claudeCodeExecutable = BINARY;
  });

  it('types the bundled binary with setup-token into the new shell, with credentials kept out', async () => {
    const result = await createTerminal({ id: 't1', cwd: '/p', projectPath: '/p', launch: 'claude-setup-token' }, new Map(), () => null, vi.fn());
    expect(result.success).toBe(true);
    expect(write).toHaveBeenCalledWith(`'${BINARY}' setup-token\r`);

    const [, , , extraEnv, transformEnv] = spawnPtyProcess.mock.calls[0];
    // Settings-file env (which could carry a gateway or a key) is not used for this terminal
    expect(extraEnv).toEqual({});
    const env = transformEnv({ PATH: '/bin', ANTHROPIC_API_KEY: 'k', CLAUDE_CODE_OAUTH_TOKEN: 'o' });
    expect(env.PATH).toBe('/bin');
    expect(env).not.toHaveProperty('ANTHROPIC_API_KEY');
    expect(env).not.toHaveProperty('CLAUDE_CODE_OAUTH_TOKEN');
    expect(env.CLAUDE_CONFIG_DIR).toMatch(/\.vibe-teamlead[/\\]claude-code$/);
  });

  it('marks the token terminal as never saved, and a plain one as saved', async () => {
    const terminals = new Map();
    await createTerminal({ id: 't5', cwd: '/p', projectPath: '/p', launch: 'claude-setup-token' }, terminals, () => null, vi.fn());
    await createTerminal({ id: 't6', cwd: '/p', projectPath: '/p' }, terminals, () => null, vi.fn());
    expect(terminals.get('t5').ephemeral).toBe(true);
    expect(terminals.get('t6').ephemeral).toBeFalsy();
  });

  it('fails without opening a shell when the bundled binary is missing', async () => {
    tools.claudeCodeExecutable = undefined;
    const result = await createTerminal({ id: 't2', cwd: '/p', launch: 'claude-setup-token' }, new Map(), () => null, vi.fn());
    expect(result.success).toBe(false);
    expect(spawnPtyProcess).not.toHaveBeenCalled();
  });

  it('a plain terminal types nothing and keeps the settings env', async () => {
    await createTerminal({ id: 't3', cwd: '/p' }, new Map(), () => null, vi.fn());
    expect(write).not.toHaveBeenCalled();
    const [, , , extraEnv, transformEnv] = spawnPtyProcess.mock.calls[0];
    expect(extraEnv).toEqual({ ANTHROPIC_BASE_URL: 'https://from-settings', FOO: 'bar' });
    expect(transformEnv).toBeUndefined();
  });

  it('an unknown launch name from the renderer is ignored', async () => {
    await createTerminal({ id: 't4', cwd: '/p', launch: 'rm -rf /' as never }, new Map(), () => null, vi.fn());
    expect(write).not.toHaveBeenCalled();
  });
});
