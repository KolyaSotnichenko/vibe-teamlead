/**
 * Unit tests for GitHub OAuth handlers
 * Tests device code parsing, shell.openExternal handling, and error recovery
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';

// Mock child_process before importing
const mockSpawn = vi.fn();
const mockExecSync = vi.fn();
const mockExecFileSync = vi.fn();
const mockExecFile = vi.fn();

vi.mock('../../../github-auth/token-store', () => ({
  getValidAccessToken: vi.fn(async () => null),
  getStoredAccessTokenSync: vi.fn(() => null),
  loadGitHubAuth: vi.fn(() => null),
  saveGitHubAuth: vi.fn(),
}));

vi.mock('../../../github-auth/device-flow', () => ({
  requestDeviceCode: vi.fn(),
  pollForToken: vi.fn(),
}));

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return {
    ...actual,
    spawn: (...args: unknown[]) => mockSpawn(...args),
    execSync: (...args: unknown[]) => mockExecSync(...args),
    execFileSync: (...args: unknown[]) => mockExecFileSync(...args),
    execFile: (...args: unknown[]) => mockExecFile(...args)
  };
});

// Mock shell.openExternal
const mockOpenExternal = vi.fn();

vi.mock('electron', () => {
  const mockIpcMain = new (class extends EventEmitter {
    private handlers: Map<string, Function> = new Map();

    handle(channel: string, handler: Function): void {
      this.handlers.set(channel, handler);
    }

    removeHandler(channel: string): void {
      this.handlers.delete(channel);
    }

    async invokeHandler(channel: string, event: unknown, ...args: unknown[]): Promise<unknown> {
      const handler = this.handlers.get(channel);
      if (handler) {
        return handler(event, ...args);
      }
      throw new Error(`No handler for channel: ${channel}`);
    }

    getHandler(channel: string): Function | undefined {
      return this.handlers.get(channel);
    }
  })();

  // Mock BrowserWindow for sendDeviceCodeToRenderer
  const mockBrowserWindow = {
    getAllWindows: () => [{
      webContents: {
        send: vi.fn()
      }
    }]
  };

  return {
    ipcMain: mockIpcMain,
    shell: {
      openExternal: (...args: unknown[]) => mockOpenExternal(...args)
    },
    BrowserWindow: mockBrowserWindow
  };
});

// Mock @electron-toolkit/utils
vi.mock('@electron-toolkit/utils', () => ({
  is: {
    dev: true,
    windows: process.platform === 'win32',
    macos: process.platform === 'darwin',
    linux: process.platform === 'linux'
  }
}));

// Mock env-utils
const mockFindExecutable = vi.fn();
const mockGetAugmentedEnv = vi.fn();

vi.mock('../../../env-utils', () => ({
  findExecutable: mockFindExecutable,
  getAugmentedEnv: mockGetAugmentedEnv,
  isCommandAvailable: vi.fn((cmd: string) => mockFindExecutable(cmd) !== null)
}));

// Mock cli-tool-manager to avoid child_process import issues
vi.mock('../../../cli-tool-manager', () => ({
  getToolPath: vi.fn(() => '/usr/local/bin/gh'),
  detectCLITools: vi.fn(),
  getAllToolStatus: vi.fn()
}));

// Create mock process for spawn
function createMockProcess(): EventEmitter & {
  stdout: EventEmitter | null;
  stderr: EventEmitter | null;
  stdin: { write: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn> } | null;
} {
  const proc = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter | null;
    stderr: EventEmitter | null;
    stdin: { write: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn> } | null;
  };
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.stdin = { write: vi.fn(), end: vi.fn() };
  return proc;
}

// Helper to wait for async setup (getCurrentGitHubUsername) to complete
// This is needed because the handler now awaits async operations before spawning
const waitForAsyncSetup = () => new Promise(resolve => setTimeout(resolve, 20));

describe('GitHub OAuth Handlers', () => {
  let ipcMain: EventEmitter & {
    handlers: Map<string, Function>;
    invokeHandler: (channel: string, event: unknown, ...args: unknown[]) => Promise<unknown>;
    getHandler: (channel: string) => Function | undefined;
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();

    // Set up default env-utils mocks
    mockGetAugmentedEnv.mockReturnValue(process.env as Record<string, string>);
    mockFindExecutable.mockReturnValue(null); // Default: executable not found

    // Set up default execFile mock for getCurrentGitHubUsername (async)
    // This returns null by default (not authenticated)
    mockExecFile.mockImplementation(
      (
        _cmd: string,
        _args: string[],
        _options: unknown,
        callback?: (error: Error | null, stdout: string, stderr: string) => void
      ) => {
        // If callback provided, call it with error to simulate not authenticated
        if (callback) {
          callback(new Error('not authenticated'), '', '');
        }
        // Return a mock ChildProcess-like object
        return { on: vi.fn(), stdout: null, stderr: null };
      }
    );

    // Get mocked ipcMain
    const electron = await import('electron');
    ipcMain = electron.ipcMain as unknown as typeof ipcMain;
  });

  afterEach(() => {
    vi.clearAllMocks();
  });




  describe('gh CLI Check Handler', () => {
    it('should return installed: true when gh CLI is found', async () => {
      // Mock findExecutable to return gh path
      mockFindExecutable.mockReturnValue('/usr/local/bin/gh');

      // Mock execFileSync for version check
      mockExecFileSync.mockImplementation((_cmd: string, args?: string[]) => {
        if (args && args[0] === '--version') {
          return 'gh version 2.65.0 (2024-01-15)\n';
        }
        return '';
      });

      const { registerCheckGhCli } = await import('../oauth-handlers');
      registerCheckGhCli();

      const result = await ipcMain.invokeHandler('github:checkCli', {});

      expect(result).toHaveProperty('success', true);
      const data = (result as { data: { installed: boolean; version: string } }).data;
      expect(data.installed).toBe(true);
      expect(data.version).toContain('gh version');
    });

    it('should return installed: false when gh CLI is not found', async () => {
      // Mock findExecutable to return null (not found)
      mockFindExecutable.mockReturnValue(null);

      const { registerCheckGhCli } = await import('../oauth-handlers');
      registerCheckGhCli();

      const result = await ipcMain.invokeHandler('github:checkCli', {});

      expect(result).toHaveProperty('success', true);
      const data = (result as { data: { installed: boolean } }).data;
      expect(data.installed).toBe(false);
    });
  });



  describe('Repository Validation', () => {
    it('should reject invalid repository format', async () => {
      const { registerGetGitHubBranches } = await import('../oauth-handlers');
      registerGetGitHubBranches();

      // Test with injection attempt
      const result = await ipcMain.invokeHandler(
        'github:getBranches',
        {},
        'owner/repo; rm -rf /',
        'token'
      );

      expect(result).toHaveProperty('success', false);
      expect(result).toHaveProperty('error', 'Invalid repository format. Expected: owner/repo');
    });

    it('should accept valid repository format', async () => {
      mockExecFileSync.mockReturnValue('main\nfeature-branch\n');

      const { registerGetGitHubBranches } = await import('../oauth-handlers');
      registerGetGitHubBranches();

      const result = await ipcMain.invokeHandler(
        'github:getBranches',
        {},
        'valid-owner/valid-repo',
        'token'
      );

      expect(result).toHaveProperty('success', true);
      const data = (result as { data: string[] }).data;
      expect(data).toContain('main');
      expect(data).toContain('feature-branch');
    });
  });
});
