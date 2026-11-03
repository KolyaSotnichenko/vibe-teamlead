/**
 * @vitest-environment node
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { InsightsConfig } from '../insights/config';

vi.mock('electron', () => ({
  app: {
    getAppPath: () => '/app',
    getPath: () => '/tmp',
    isPackaged: false
  }
}));

const mockGetClaudeCredentialEnv = vi.fn();
vi.mock('../ai/claude-code/credential', () => ({
  getClaudeCredentialEnv: (...args: unknown[]) => mockGetClaudeCredentialEnv(...args)
}));

describe('InsightsConfig', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...originalEnv, TEST_ENV: 'ok' };
    mockGetClaudeCredentialEnv.mockReturnValue({
      ANTHROPIC_API_KEY: 'sk-ant-api03-key',
      ANTHROPIC_BASE_URL: 'https://gateway.example.com'
    });
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.clearAllMocks();
    vi.restoreAllMocks();
  });

  it('should build process env with the Claude credential', async () => {
    const config = new InsightsConfig();
    vi.spyOn(config, 'loadAutoBuildEnv').mockReturnValue({ CUSTOM_ENV: '1' });

    const env = await config.getProcessEnv();

    expect(env.TEST_ENV).toBe('ok');
    expect(env.CUSTOM_ENV).toBe('1');
    expect(env.ANTHROPIC_API_KEY).toBe('sk-ant-api03-key');
    expect(env.ANTHROPIC_BASE_URL).toBe('https://gateway.example.com');
  });

  it('should let the credential override a stale key from the environment', async () => {
    process.env = { ...originalEnv, ANTHROPIC_API_KEY: 'stale-key' };

    const env = await new InsightsConfig().getProcessEnv();

    expect(env.ANTHROPIC_API_KEY).toBe('sk-ant-api03-key');
  });
});
