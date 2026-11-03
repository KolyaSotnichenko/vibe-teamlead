/**
 * Integration tests for AgentProcessManager
 * Tests environment variable injection into spawnProcess
 * (the app's Claude credential, CLI tool paths).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';

// Create a mock process object that will be returned by spawn
function createMockProcess() {
  return {
    stdout: { on: vi.fn() },
    stderr: { on: vi.fn() },
    on: vi.fn((event: string, callback: (code: number) => void) => {
      if (event === 'exit') {
        // Simulate immediate exit with code 0
        setTimeout(() => callback(0), 10);
      }
    }),
    kill: vi.fn()
  };
}

// Mock child_process - must be BEFORE imports of modules that use it
const spawnCalls: Array<{ command: string; args: string[]; options: { env: Record<string, string>; cwd?: string; [key: string]: unknown } }> = [];

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  const mockSpawn = vi.fn((command: string, args: string[], options: { env: Record<string, string>; cwd?: string; [key: string]: unknown }) => {
    // Record the call for test assertions
    spawnCalls.push({ command, args, options });
    return createMockProcess();
  });

  return {
    ...actual,
    spawn: mockSpawn,
    execSync: vi.fn((command: string) => {
      if (command.includes('git')) {
        return '/fake/path';
      }
      return '';
    })
  };
});

// Mock project-initializer to avoid child_process.execSync issues
vi.mock('../project-initializer', () => ({
  getAutoBuildPath: vi.fn(() => '/fake/auto-build'),
  isInitialized: vi.fn(() => true),
  initializeProject: vi.fn(),
  getProjectStorePath: vi.fn(() => '/fake/store/path')
}));

// Mock project-store BEFORE agent-process imports it
vi.mock('../project-store', () => ({
  projectStore: {
    getProject: vi.fn(),
    listProjects: vi.fn(),
    createProject: vi.fn(),
    updateProject: vi.fn(),
    deleteProject: vi.fn(),
    getProjectSettings: vi.fn(),
    updateProjectSettings: vi.fn()
  }
}));

// Mock dependencies
vi.mock('../ai/claude-code/credential', () => ({
  getClaudeCredentialEnv: vi.fn(() => ({}))
}));

vi.mock('../rate-limit-detector', () => ({
  detectRateLimit: vi.fn(() => ({ isRateLimited: false })),
  createSDKRateLimitInfo: vi.fn(),
  detectAuthFailure: vi.fn(() => ({ isAuthFailure: false }))
}));

// Python detector and env manager are no longer used (migration to Vercel AI SDK)

vi.mock('electron', () => ({
  app: {
    getAppPath: vi.fn(() => '/fake/app/path')
  }
}));

// Mock cli-tool-manager to avoid blocking tool detection on Windows
vi.mock('../cli-tool-manager', () => ({
  getToolInfo: vi.fn((tool: string) => {
    if (tool === 'gh') {
      // Default: gh CLI not found
      return { found: false, path: undefined, source: 'user-config', message: 'gh CLI not found' };
    }
    if (tool === 'claude') {
      return { found: false, path: undefined, source: 'user-config', message: 'Claude CLI not found' };
    }
    return { found: false, path: undefined, source: 'user-config', message: `${tool} not found` };
  }),
  // getClaudeCliPathForSdk returns null by default (simulates not found or .cmd file on Windows)
  getClaudeCliPathForSdk: vi.fn(() => null),
  deriveGitBashPath: vi.fn(() => null),
  clearCache: vi.fn()
}));

// Mock env-utils to avoid blocking environment augmentation
vi.mock('../env-utils', () => ({
  getAugmentedEnv: vi.fn(() => ({ ...process.env }))
}));

// Mock fs.existsSync for getAutoBuildSourcePath path validation
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    existsSync: vi.fn((inputPath: string) => {
      // Normalize path separators for cross-platform compatibility
      // path.join() uses backslashes on Windows, so we normalize to forward slashes
      const normalizedPath = inputPath.replace(/\\/g, '/');
      // Return true for the fake auto-build path and its expected files
      if (normalizedPath === '/fake/auto-build' ||
          normalizedPath === '/fake/auto-build/runners' ||
          normalizedPath === '/fake/auto-build/runners/spec_runner.py') {
        return true;
      }
      return false;
    })
  };
});

// Import AFTER all mocks are set up
import { AgentProcessManager } from './agent-process';
import { AgentState } from './agent-state';
import { AgentEvents } from './agent-events';
import { getClaudeCredentialEnv } from '../ai/claude-code/credential';
import { getToolInfo, getClaudeCliPathForSdk } from '../cli-tool-manager';

describe('AgentProcessManager - spawn environment', () => {
  let processManager: AgentProcessManager;
  let state: AgentState;
  let events: AgentEvents;
  let emitter: EventEmitter;

  beforeEach(() => {
    // Reset all mocks and spawn calls
    vi.clearAllMocks();
    spawnCalls.length = 0;

    // Clear environment variables that could interfere with tests
    delete process.env.ANTHROPIC_AUTH_TOKEN;
    delete process.env.ANTHROPIC_BASE_URL;
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    // Clear CLI path env vars so tests use mocked getToolInfo
    delete process.env.CLAUDE_CLI_PATH;
    delete process.env.GITHUB_CLI_PATH;

    // Initialize components
    state = new AgentState();
    events = new AgentEvents();
    emitter = new EventEmitter();
    processManager = new AgentProcessManager(state, events, emitter);
  });

  afterEach(() => {
    processManager.killAllProcesses();
  });

  describe('Claude credential', () => {
    it('injects the app credential into the spawn environment', async () => {
      vi.mocked(getClaudeCredentialEnv).mockReturnValue({
        ANTHROPIC_API_KEY: 'sk-ant-api03-test',
        ANTHROPIC_BASE_URL: 'https://gateway.example.com'
      });

      await processManager.spawnProcess('task-1', '/fake/cwd', ['run.py'], {}, 'task-execution');

      expect(spawnCalls).toHaveLength(1);
      expect(spawnCalls[0].options.env).toMatchObject({
        ANTHROPIC_API_KEY: 'sk-ant-api03-test',
        ANTHROPIC_BASE_URL: 'https://gateway.example.com'
      });
    });

    it('gives the credential precedence over extraEnv', async () => {
      vi.mocked(getClaudeCredentialEnv).mockReturnValue({ ANTHROPIC_API_KEY: 'sk-ant-api03-app' });

      await processManager.spawnProcess('task-1', '/fake/cwd', ['run.py'], { ANTHROPIC_API_KEY: 'sk-stale' }, 'task-execution');

      expect(spawnCalls[0].options.env.ANTHROPIC_API_KEY).toBe('sk-ant-api03-app');
    });
  });

  describe('No API Key Logging', () => {
    it('should never log full API keys in spawn env vars', async () => {
      vi.mocked(getClaudeCredentialEnv).mockReturnValue({
        ANTHROPIC_API_KEY: 'sk-sensitive-api-key-12345678',
        ANTHROPIC_BASE_URL: 'https://api.example.com'
      });

      // Mock ALL console methods to capture any debug/error output
      const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const consoleDebugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});

      await processManager.spawnProcess('task-1', '/fake/cwd', ['run.py'], {}, 'task-execution');

      // Get the env object passed to spawn
      const envArg = spawnCalls[0].options.env as Record<string, unknown>;

      // Verify the full API key is in the env (for subprocess)
      expect(envArg.ANTHROPIC_API_KEY).toBe('sk-sensitive-api-key-12345678');

      // Collect ALL console output from all methods
      const allLogCalls = [
        ...consoleLogSpy.mock.calls,
        ...consoleErrorSpy.mock.calls,
        ...consoleWarnSpy.mock.calls,
        ...consoleDebugSpy.mock.calls
      ].flatMap(call => call.map(String));
      const logString = JSON.stringify(allLogCalls);

      // The full API key should NOT appear in any logs (AC4 compliance)
      expect(logString).not.toContain('sk-sensitive-api-key-12345678');

      // Restore all spies
      consoleLogSpy.mockRestore();
      consoleErrorSpy.mockRestore();
      consoleWarnSpy.mockRestore();
      consoleDebugSpy.mockRestore();
    });

    it('should not log API key even in error scenarios', async () => {
      vi.mocked(getClaudeCredentialEnv).mockReturnValue({
        ANTHROPIC_API_KEY: 'sk-secret-key-for-error-test',
        ANTHROPIC_BASE_URL: 'https://api.example.com'
      });

      // Mock console methods
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      await processManager.spawnProcess('task-1', '/fake/cwd', ['run.py'], {}, 'task-execution');

      // Collect all error and log output
      const allOutput = [
        ...consoleErrorSpy.mock.calls,
        ...consoleLogSpy.mock.calls
      ].flatMap(call => call.map(arg => typeof arg === 'object' ? JSON.stringify(arg) : String(arg)));
      const outputString = allOutput.join(' ');

      // Verify API key is never exposed in logs
      expect(outputString).not.toContain('sk-secret-key-for-error-test');

      consoleErrorSpy.mockRestore();
      consoleLogSpy.mockRestore();
    });
  });

  // ensurePythonEnvReady tests removed — method deleted as part of Python → Vercel AI SDK migration

  describe('GITHUB_CLI_PATH Environment Variable (ACS-321)', () => {
    let originalEnv: NodeJS.ProcessEnv;

    beforeEach(() => {
      // Save original environment before each test
      originalEnv = { ...process.env };
      // Clear GITHUB_CLI_PATH if set
      delete process.env.GITHUB_CLI_PATH;
    });

    afterEach(() => {
      // Restore original environment after each test
      process.env = originalEnv;
    });

    it('should NOT set GITHUB_CLI_PATH when gh CLI is not found', async () => {
      // Mock gh CLI as not found
      vi.mocked(getToolInfo).mockReturnValue({
        found: false,
        path: undefined,
        source: 'user-config',
        message: 'gh CLI not found'
      });

      await processManager.spawnProcess('task-1', '/fake/cwd', ['run.py'], {}, 'task-execution');

      expect(spawnCalls).toHaveLength(1);
      const envArg = spawnCalls[0].options.env as Record<string, unknown>;

      // GITHUB_CLI_PATH should not be set
      expect(envArg.GITHUB_CLI_PATH).toBeUndefined();
    });

    it('should set GITHUB_CLI_PATH when gh CLI is found by getToolInfo', async () => {
      // Mock gh CLI as found
      vi.mocked(getToolInfo).mockReturnValue({
        found: true,
        path: '/opt/homebrew/bin/gh',
        source: 'homebrew',
        message: 'gh CLI found via Homebrew'
      });

      await processManager.spawnProcess('task-1', '/fake/cwd', ['run.py'], {}, 'task-execution');

      expect(spawnCalls).toHaveLength(1);
      const envArg = spawnCalls[0].options.env as Record<string, unknown>;

      // GITHUB_CLI_PATH should be set to the detected path
      expect(envArg.GITHUB_CLI_PATH).toBe('/opt/homebrew/bin/gh');
    });

    it('should NOT override existing GITHUB_CLI_PATH from process.env', async () => {
      // Set GITHUB_CLI_PATH in process environment
      process.env.GITHUB_CLI_PATH = '/existing/path/to/gh';

      // Mock gh CLI as found at different path
      vi.mocked(getToolInfo).mockReturnValue({
        found: true,
        path: '/opt/homebrew/bin/gh',
        source: 'homebrew',
        message: 'gh CLI found via Homebrew'
      });

      await processManager.spawnProcess('task-1', '/fake/cwd', ['run.py'], {}, 'task-execution');

      expect(spawnCalls).toHaveLength(1);
      const envArg = spawnCalls[0].options.env as Record<string, unknown>;

      // Should use existing GITHUB_CLI_PATH from process.env, not detected one
      expect(envArg.GITHUB_CLI_PATH).toBe('/existing/path/to/gh');
    });

    it('should detect gh CLI from system-path source', async () => {
      // Mock gh CLI found in system PATH
      vi.mocked(getToolInfo).mockReturnValue({
        found: true,
        path: 'C:\\Program Files\\GitHub CLI\\gh.exe',
        source: 'system-path',
        message: 'gh CLI found in system PATH'
      });

      await processManager.spawnProcess('task-1', '/fake/cwd', ['run.py'], {}, 'task-execution');

      expect(spawnCalls).toHaveLength(1);
      const envArg = spawnCalls[0].options.env as Record<string, unknown>;

      expect(envArg.GITHUB_CLI_PATH).toBe('C:\\Program Files\\GitHub CLI\\gh.exe');
    });

    it('should handle getToolInfo errors gracefully', async () => {
      // Mock getToolInfo to throw an error
      vi.mocked(getToolInfo).mockImplementation(() => {
        throw new Error('Tool detection failed');
      });

      // Should not throw - should fall back to not setting GITHUB_CLI_PATH
      await expect(
        processManager.spawnProcess('task-1', '/fake/cwd', ['run.py'], {}, 'task-execution')
      ).resolves.not.toThrow();

      expect(spawnCalls).toHaveLength(1);
      const envArg = spawnCalls[0].options.env as Record<string, unknown>;

      // GITHUB_CLI_PATH should not be set on error
      expect(envArg.GITHUB_CLI_PATH).toBeUndefined();
    });

    it('should set GITHUB_CLI_PATH with same precedence as CLAUDE_CLI_PATH', async () => {
      // Mock Claude CLI via getClaudeCliPathForSdk (returns path directly, not .cmd file)
      vi.mocked(getClaudeCliPathForSdk).mockReturnValue('/opt/homebrew/bin/claude');

      // Mock gh CLI via getToolInfo (gh still uses standard detection)
      vi.mocked(getToolInfo).mockImplementation((tool: string) => {
        if (tool === 'gh') {
          return { found: true, path: '/opt/homebrew/bin/gh', source: 'homebrew', message: 'gh CLI found via Homebrew' };
        }
        return { found: false, path: undefined, source: 'user-config', message: `${tool} not found` };
      });

      await processManager.spawnProcess('task-1', '/fake/cwd', ['run.py'], {}, 'task-execution');

      expect(spawnCalls).toHaveLength(1);
      const envArg = spawnCalls[0].options.env as Record<string, unknown>;

      // Both should be set
      expect(envArg.CLAUDE_CLI_PATH).toBe('/opt/homebrew/bin/claude');
      expect(envArg.GITHUB_CLI_PATH).toBe('/opt/homebrew/bin/gh');
    });
  });

});
