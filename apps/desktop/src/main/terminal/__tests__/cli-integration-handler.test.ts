import path from 'path';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import type * as pty from '@lydell/node-pty';
import type { TerminalProcess } from '../types';
import { buildCdCommand, escapeShellArg } from '../../../shared/utils/shell-escape';

// Mock the platform module (main/platform/index.ts)
vi.mock('../../platform', () => ({
  isWindows: vi.fn(() => false),
  isMacOS: vi.fn(() => false),
  isLinux: vi.fn(() => false),
  isUnix: vi.fn(() => false),
  getCurrentOS: vi.fn(() => 'linux'),
}));

import { isWindows } from '../../platform';

const mockGetClaudeCliInvocation = vi.fn();
const mockGetClaudeCliInvocationAsync = vi.fn();
const mockPersistSession = vi.fn();
const mockReleaseSessionId = vi.fn();

const createMockDisposable = (): pty.IDisposable => ({ dispose: vi.fn() });

const createMockPty = (): pty.IPty => ({
  pid: 123,
  cols: 80,
  rows: 24,
  process: 'bash',
  handleFlowControl: false,
  onData: vi.fn(() => createMockDisposable()),
  onExit: vi.fn(() => createMockDisposable()),
  write: vi.fn(),
  resize: vi.fn(),
  pause: vi.fn(),
  resume: vi.fn(),
  kill: vi.fn(),
  clear: vi.fn(),
});

const createMockTerminal = (overrides: Partial<TerminalProcess> = {}): TerminalProcess => ({
  id: 'term-1',
  pty: createMockPty(),
  outputBuffer: '',
  isCLIMode: false,
  claudeSessionId: undefined,
  title: 'Terminal 1',  // Use default terminal name pattern to match production behavior
  cwd: '/tmp/project',
  projectPath: '/tmp/project',
  ...overrides,
});

vi.mock('../../cli-utils', () => ({
  getClaudeCliInvocation: mockGetClaudeCliInvocation,
  getClaudeCliInvocationAsync: mockGetClaudeCliInvocationAsync,
}));

vi.mock('../session-handler', () => ({
  persistSession: mockPersistSession,
  releaseSessionId: mockReleaseSessionId,
}));

// Mock PtyManager.writeToPty - the implementation now uses this instead of terminal.pty.write
const mockWriteToPty = vi.fn();
vi.mock('../pty-manager', () => ({
  writeToPty: mockWriteToPty,
}));

// Mock settings-utils so invokeCLIAsync defaults to claude-code in tests
vi.mock('../../settings-utils', () => ({
  readSettingsFileAsync: vi.fn(async () => undefined),
}));

/**
 * Helper to set the current platform for testing
 */
function mockPlatform(platform: 'win32' | 'darwin' | 'linux') {
  const mockIsWindows = vi.mocked(isWindows);
  mockIsWindows.mockReturnValue(platform === 'win32');
}

/**
 * Helper to get platform-specific expectations for PATH prefix
 */
function getPathPrefixExpectation(
  platform: 'win32' | 'darwin' | 'linux',
  pathValue: string,
  command: string
): string {
  // Absolute executable commands no longer need PATH prefix injection.
  if (path.isAbsolute(command)) {
    return '';
  }

  if (platform === 'win32') {
    // Windows: set "PATH=value" &&
    return `set "PATH=${pathValue}" && `;
  }
  // Unix/macOS: PATH='value' '
  return `PATH='${pathValue}' `;
}

function expectPathPrefix(
  written: string,
  platform: 'win32' | 'darwin' | 'linux',
  pathValue: string,
  command: string
): void {
  const expectedPrefix = getPathPrefixExpectation(platform, pathValue, command);
  if (expectedPrefix) {
    expect(written).toContain(expectedPrefix);
  } else {
    expect(written).not.toContain('PATH=');
  }
}

/**
 * Helper to get platform-specific expectations for command quoting
 */
function getQuotedCommand(platform: 'win32' | 'darwin' | 'linux', command: string): string {
  if (platform === 'win32') {
    // Windows: double quotes, use escapeForWindowsDoubleQuote logic
    // Inside double quotes, only " needs escaping (as "")
    const escaped = command.replace(/"/g, '""');
    return `"${escaped}"`;
  }
  // Unix/macOS: use escapeShellArg which properly handles embedded single quotes
  return escapeShellArg(command);
}

describe('cli-integration-handler', () => {
  beforeEach(() => {
    mockGetClaudeCliInvocation.mockClear();
    mockPersistSession.mockClear();
    mockReleaseSessionId.mockClear();
    mockWriteToPty.mockClear();
  });

  describe.each(['win32', 'darwin', 'linux'] as const)('on %s', (platform) => {
    beforeEach(() => {
      mockPlatform(platform);
    });

    it('uses the resolved CLI path and PATH prefix when invoking Claude', async () => {
      mockGetClaudeCliInvocation.mockReturnValue({
        command: "/opt/claude bin/claude's",
        env: { PATH: '/opt/claude/bin:/usr/bin' },
      });

      const terminal = createMockTerminal();

      const { invokeClaude } = await import('../cli-integration-handler');
      invokeClaude(terminal, '/tmp/project', () => null, vi.fn());

      const written = mockWriteToPty.mock.calls[0][1] as string;
      expect(written).toContain(buildCdCommand('/tmp/project'));
      expectPathPrefix(written, platform, '/opt/claude/bin:/usr/bin', "/opt/claude bin/claude's");
      expect(written).toContain(getQuotedCommand(platform, "/opt/claude bin/claude's"));
      expect(mockReleaseSessionId).toHaveBeenCalledWith('term-1');
      expect(mockPersistSession).toHaveBeenCalledWith(terminal);
    });

    it('uses --continue regardless of sessionId (sessionId is deprecated)', async () => {
      mockGetClaudeCliInvocation.mockReturnValue({
        command: '/opt/claude/bin/claude',
        env: { PATH: '/opt/claude/bin:/usr/bin' },
      });

      const terminal = createMockTerminal({
        id: 'term-2',
        cwd: undefined,
        projectPath: '/tmp/project',
      });

      const { resumeClaude } = await import('../cli-integration-handler');

      // Even when sessionId is passed, it should be ignored and --continue used
      resumeClaude(terminal, 'abc123', () => null);

      const resumeCall = mockWriteToPty.mock.calls[0][1] as string;
      expectPathPrefix(resumeCall, platform, '/opt/claude/bin:/usr/bin', '/opt/claude/bin/claude');
      expect(resumeCall).toContain(getQuotedCommand(platform, '/opt/claude/bin/claude') + ' --continue');
      expect(resumeCall).not.toContain('--resume');
      // sessionId is cleared because --continue doesn't track specific sessions
      expect(terminal.claudeSessionId).toBeUndefined();
      expect(terminal.isCLIMode).toBe(true);
      expect(mockPersistSession).toHaveBeenCalledWith(terminal);

      mockWriteToPty.mockClear();
      mockPersistSession.mockClear();
      terminal.projectPath = undefined;
      terminal.isCLIMode = false;
      resumeClaude(terminal, undefined, () => null);
      const continueCall = mockWriteToPty.mock.calls[0][1] as string;
      expect(continueCall).toContain(getQuotedCommand(platform, '/opt/claude/bin/claude') + ' --continue');
      expect(terminal.isCLIMode).toBe(true);
      expect(terminal.claudeSessionId).toBeUndefined();
      expect(mockPersistSession).not.toHaveBeenCalled();
    });
  });

  it('throws when invokeClaude cannot resolve the CLI invocation', async () => {
    mockGetClaudeCliInvocation.mockImplementation(() => {
      throw new Error('boom');
    });

    const terminal = createMockTerminal({ id: 'term-err' });

    const { invokeClaude } = await import('../cli-integration-handler');
    expect(() => invokeClaude(terminal, '/tmp/project', () => null, vi.fn())).toThrow('boom');
    expect(mockReleaseSessionId).toHaveBeenCalledWith('term-err');
    expect(mockWriteToPty).not.toHaveBeenCalled();
  });

  it('throws when resumeClaude cannot resolve the CLI invocation', async () => {
    mockGetClaudeCliInvocation.mockImplementation(() => {
      throw new Error('boom');
    });

    const terminal = createMockTerminal({
      id: 'term-err-2',
      cwd: undefined,
      projectPath: '/tmp/project',
    });

    const { resumeClaude } = await import('../cli-integration-handler');
    expect(() => resumeClaude(terminal, 'abc123', () => null)).toThrow('boom');
    expect(mockWriteToPty).not.toHaveBeenCalled();
  });

  it('includes YOLO mode flag when dangerouslySkipPermissions is true', async () => {
    mockGetClaudeCliInvocation.mockReturnValue({
      command: '/opt/claude/bin/claude',
      env: { PATH: '/opt/claude/bin:/usr/bin' },
    });

    const terminal = createMockTerminal();

    const { invokeClaude } = await import('../cli-integration-handler');
    invokeClaude(terminal, '/tmp/project', () => null, vi.fn(), true);

    const written = mockWriteToPty.mock.calls[0][1] as string;
    expect(written).toContain('--dangerously-skip-permissions');
    expect(terminal.dangerouslySkipPermissions).toBe(true);
  });

  it('does not include YOLO mode flag when dangerouslySkipPermissions is false', async () => {
    mockGetClaudeCliInvocation.mockReturnValue({
      command: '/opt/claude/bin/claude',
      env: { PATH: '/opt/claude/bin:/usr/bin' },
    });

    const terminal = createMockTerminal();

    const { invokeClaude } = await import('../cli-integration-handler');
    invokeClaude(terminal, '/tmp/project', () => null, vi.fn(), false);

    const written = mockWriteToPty.mock.calls[0][1] as string;
    expect(written).not.toContain('--dangerously-skip-permissions');
    expect(terminal.dangerouslySkipPermissions).toBe(false);
  });

  it('resets terminal state on error', async () => {
    mockGetClaudeCliInvocation.mockImplementation(() => {
      throw new Error('CLI error');
    });

    const terminal = createMockTerminal({
      isCLIMode: false,
    });

    const { invokeClaude } = await import('../cli-integration-handler');
    expect(() => invokeClaude(terminal, '/tmp/project', () => null, vi.fn())).toThrow('CLI error');

    // Terminal state should be rolled back
    expect(terminal.isCLIMode).toBe(false);
    expect(terminal.claudeSessionId).toBeUndefined();
  });
});

/**
 * Tests for invokeCLIAsync() - async version with timeout protection
 */
describe('invokeCLIAsync', () => {
  beforeEach(() => {
    mockGetClaudeCliInvocationAsync.mockClear();
    mockPersistSession.mockClear();
    mockReleaseSessionId.mockClear();
    mockWriteToPty.mockClear();
  });

  describe.each(['win32', 'darwin', 'linux'] as const)('on %s', (platform) => {
    beforeEach(() => {
      mockPlatform(platform);
    });

    it('should invoke Claude asynchronously', async () => {
      mockGetClaudeCliInvocationAsync.mockResolvedValue({
        command: '/opt/claude/bin/claude',
        env: { PATH: '/opt/claude/bin:/usr/bin' },
      });

      const terminal = createMockTerminal();

      const { invokeCLIAsync } = await import('../cli-integration-handler');
      await invokeCLIAsync(terminal, '/tmp/project', () => null, vi.fn());

      const written = mockWriteToPty.mock.calls[0][1] as string;
      expect(written).toContain(buildCdCommand('/tmp/project'));
      expectPathPrefix(written, platform, '/opt/claude/bin:/usr/bin', '/opt/claude/bin/claude');
      expect(mockReleaseSessionId).toHaveBeenCalledWith('term-1');
      expect(mockPersistSession).toHaveBeenCalledWith(terminal);
    });

    it('should timeout after 10 seconds if CLI invocation hangs', async () => {
      mockGetClaudeCliInvocationAsync.mockImplementation(() =>
        new Promise(resolve => setTimeout(() => resolve({
          command: '/opt/claude/bin/claude',
          env: { PATH: '/opt/claude/bin:/usr/bin' },
        }), 15000))
      );

      const terminal = createMockTerminal();

      const { invokeCLIAsync } = await import('../cli-integration-handler');

      await expect(invokeCLIAsync(terminal, '/tmp/project', () => null, vi.fn()))
        .rejects.toThrow('CLI invocation timeout after 10s');

      // Terminal state should be rolled back
      expect(terminal.isCLIMode).toBe(false);
    }, 12000); // Allow 12 seconds for test (10s timeout + 2s buffer)

    it('should reset terminal state on async error', async () => {
      mockGetClaudeCliInvocationAsync.mockRejectedValue(new Error('Async CLI error'));

      const terminal = createMockTerminal({
        isCLIMode: false,
      });

      const { invokeCLIAsync } = await import('../cli-integration-handler');
      await expect(invokeCLIAsync(terminal, '/tmp/project', () => null, vi.fn()))
        .rejects.toThrow('Async CLI error');

      // Terminal state should be rolled back
      expect(terminal.isCLIMode).toBe(false);
      expect(terminal.claudeSessionId).toBeUndefined();
    });

    it('should include YOLO mode flag when dangerouslySkipPermissions is true', async () => {
      mockGetClaudeCliInvocationAsync.mockResolvedValue({
        command: '/opt/claude/bin/claude',
        env: { PATH: '/opt/claude/bin:/usr/bin' },
      });

      const terminal = createMockTerminal();

      const { invokeCLIAsync } = await import('../cli-integration-handler');
      await invokeCLIAsync(terminal, '/tmp/project', () => null, vi.fn(), true);

      const written = mockWriteToPty.mock.calls[0][1] as string;
      expect(written).toContain('--dangerously-skip-permissions');
      expect(terminal.dangerouslySkipPermissions).toBe(true);
    });

    it('should call onSessionCapture callback with correct parameters', async () => {
      mockGetClaudeCliInvocationAsync.mockResolvedValue({
        command: '/opt/claude/bin/claude',
        env: { PATH: '/opt/claude/bin:/usr/bin' },
      });

      const terminal = createMockTerminal();
      const mockOnSessionCapture = vi.fn();
      const startTime = Date.now();

      const { invokeCLIAsync } = await import('../cli-integration-handler');
      await invokeCLIAsync(terminal, '/tmp/project', () => null, mockOnSessionCapture);

      expect(mockOnSessionCapture).toHaveBeenCalledWith(
        terminal.id,
        '/tmp/project',
        expect.any(Number)
      );

      const capturedTime = mockOnSessionCapture.mock.calls[0][2];
      expect(capturedTime).toBeGreaterThanOrEqual(startTime);
    });
  });
});

/**
 * Unit tests for helper functions
 */
describe('cli-integration-handler - Helper Functions', () => {
  describe('buildClaudeShellCommand', () => {
    describe.each(['win32', 'darwin', 'linux'] as const)('on %s', (platform) => {
      beforeEach(() => {
        mockPlatform(platform);
      });

      it('should build default command without cwd or PATH prefix', async () => {
        const { buildClaudeShellCommand } = await import('../cli-integration-handler');
        const result = buildClaudeShellCommand('', '', "'/opt/bin/claude'");

        expect(result).toBe("'/opt/bin/claude'\r");
      });

      it('should build command with cwd', async () => {
        const { buildClaudeShellCommand } = await import('../cli-integration-handler');
        const result = buildClaudeShellCommand("cd '/tmp/project' && ", '', "'/opt/bin/claude'");

        expect(result).toBe("cd '/tmp/project' && '/opt/bin/claude'\r");
      });

      it('should build command with PATH prefix', async () => {
        const { buildClaudeShellCommand } = await import('../cli-integration-handler');
        const result = buildClaudeShellCommand('', "PATH='/custom/path' ", "'/opt/bin/claude'");

        expect(result).toBe("PATH='/custom/path' '/opt/bin/claude'\r");
      });

    });
  });

  describe('finalizeClaudeInvoke', () => {
    it('should set terminal title to "Claude" when terminal has default name', async () => {
      const { finalizeClaudeInvoke } = await import('../cli-integration-handler');
      // Use a default terminal name pattern so renaming logic kicks in
      const terminal = createMockTerminal({ title: 'Terminal 1' });
      const mockWindow = {
        isDestroyed: () => false,
        webContents: { send: vi.fn(), isDestroyed: () => false }
      };

      finalizeClaudeInvoke(
        terminal,
        '/tmp/project',
        Date.now(),
        () => mockWindow as any,
        vi.fn()
      );

      expect(terminal.title).toBe('Claude');
    });

    it('should send IPC message to renderer when terminal has default name', async () => {
      const { finalizeClaudeInvoke } = await import('../cli-integration-handler');
      // Use a default terminal name pattern so renaming logic kicks in
      const terminal = createMockTerminal({ title: 'Terminal 3' });
      const mockSend = vi.fn();
      const mockWindow = {
        isDestroyed: () => false,
        webContents: { send: mockSend, isDestroyed: () => false }
      };

      finalizeClaudeInvoke(
        terminal,
        '/tmp/project',
        Date.now(),
        () => mockWindow as any,
        vi.fn()
      );

      expect(mockSend).toHaveBeenCalledWith(
        expect.stringContaining('title'),
        terminal.id,
        'Claude'
      );
    });

    it('should NOT rename terminal when already named Claude', async () => {
      const { finalizeClaudeInvoke } = await import('../cli-integration-handler');
      // Terminal already has Claude title - should NOT be renamed
      const terminal = createMockTerminal({ title: 'Claude' });
      const mockSend = vi.fn();
      const mockWindow = {
        isDestroyed: () => false,
        webContents: { send: mockSend, isDestroyed: () => false }
      };

      finalizeClaudeInvoke(
        terminal,
        '/tmp/project',
        Date.now(),
        () => mockWindow as any,
        vi.fn()
      );

      // Title should remain unchanged
      expect(terminal.title).toBe('Claude');
      // No IPC message should be sent for title change
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('should NOT rename terminal with user-customized name', async () => {
      const { finalizeClaudeInvoke } = await import('../cli-integration-handler');
      // User has customized the terminal name - should NOT be renamed
      const terminal = createMockTerminal({ title: 'My Custom Terminal' });
      const mockSend = vi.fn();
      const mockWindow = {
        isDestroyed: () => false,
        webContents: { send: mockSend, isDestroyed: () => false }
      };

      finalizeClaudeInvoke(
        terminal,
        '/tmp/project',
        Date.now(),
        () => mockWindow as any,
        vi.fn()
      );

      // Title should remain unchanged
      expect(terminal.title).toBe('My Custom Terminal');
      // No IPC message should be sent for title change
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('should persist session when terminal has projectPath', async () => {
      const { finalizeClaudeInvoke } = await import('../cli-integration-handler');
      const terminal = createMockTerminal({ projectPath: '/tmp/project' });

      finalizeClaudeInvoke(
        terminal,
        '/tmp/project',
        Date.now(),
        () => null,
        vi.fn()
      );

      expect(mockPersistSession).toHaveBeenCalledWith(terminal);
    });

    it('should call onSessionCapture when projectPath is provided', async () => {
      const { finalizeClaudeInvoke } = await import('../cli-integration-handler');
      const terminal = createMockTerminal();
      const mockOnSessionCapture = vi.fn();
      const startTime = Date.now();

      finalizeClaudeInvoke(
        terminal,
        '/tmp/project',
        startTime,
        () => null,
        mockOnSessionCapture
      );

      expect(mockOnSessionCapture).toHaveBeenCalledWith(terminal.id, '/tmp/project', startTime);
    });

    it('should not crash when getWindow returns null', async () => {
      const { finalizeClaudeInvoke } = await import('../cli-integration-handler');
      const terminal = createMockTerminal();

      expect(() => {
        finalizeClaudeInvoke(
          terminal,
          '/tmp/project',
          Date.now(),
          () => null,
          vi.fn()
        );
      }).not.toThrow();
    });
  });

  describe('shouldAutoRenameTerminal', () => {
    it('should return true for default terminal names', async () => {
      const { shouldAutoRenameTerminal } = await import('../cli-integration-handler');

      expect(shouldAutoRenameTerminal('Terminal 1')).toBe(true);
      expect(shouldAutoRenameTerminal('Terminal 2')).toBe(true);
      expect(shouldAutoRenameTerminal('Terminal 99')).toBe(true);
      expect(shouldAutoRenameTerminal('Terminal 123')).toBe(true);
    });

    it('should return false for terminals already named Claude', async () => {
      const { shouldAutoRenameTerminal } = await import('../cli-integration-handler');

      expect(shouldAutoRenameTerminal('Claude')).toBe(false);
      expect(shouldAutoRenameTerminal('Claude (Work)')).toBe(false);
      expect(shouldAutoRenameTerminal('Claude (Profile Name)')).toBe(false);
    });

    it('should return false for user-customized terminal names', async () => {
      const { shouldAutoRenameTerminal } = await import('../cli-integration-handler');

      expect(shouldAutoRenameTerminal('My Custom Terminal')).toBe(false);
      expect(shouldAutoRenameTerminal('Dev Server')).toBe(false);
      expect(shouldAutoRenameTerminal('Backend')).toBe(false);
    });

    it('should return false for edge cases that do not match the pattern', async () => {
      const { shouldAutoRenameTerminal } = await import('../cli-integration-handler');

      // Terminal 0 is not a valid default (terminals start at 1)
      expect(shouldAutoRenameTerminal('Terminal 0')).toBe(true);  // Pattern matches \d+, so this is valid

      // Lowercase doesn't match
      expect(shouldAutoRenameTerminal('terminal 1')).toBe(false);

      // Extra whitespace doesn't match
      expect(shouldAutoRenameTerminal('Terminal  1')).toBe(false);
      expect(shouldAutoRenameTerminal(' Terminal 1')).toBe(false);
      expect(shouldAutoRenameTerminal('Terminal 1 ')).toBe(false);

      // Tab instead of space doesn't match
      expect(shouldAutoRenameTerminal('Terminal\t1')).toBe(false);
    });
  });
});
