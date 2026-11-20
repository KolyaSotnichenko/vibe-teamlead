import { describe, expect, it } from 'vitest';
import { SETUP_TOKEN_DROPPED_ENV, isSetupTokenLaunch, setupTokenEnv } from '../setup-token';

describe('setupTokenEnv', () => {
  it("keeps the app's credentials and Claude Code's nesting guard out, and uses the app's config dir", () => {
    const env = setupTokenEnv(
      {
        PATH: '/usr/bin',
        ANTHROPIC_API_KEY: 'sk-ant-api',
        ANTHROPIC_AUTH_TOKEN: 'x',
        ANTHROPIC_BASE_URL: 'https://gateway',
        CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat',
        CLAUDECODE: '1',
        CLAUDE_CONFIG_DIR: '/Users/me/.claude',
      },
      '/Users/me/.vibe-teamlead/claude-code'
    );
    expect(env).toEqual({ PATH: '/usr/bin', CLAUDE_CONFIG_DIR: '/Users/me/.vibe-teamlead/claude-code' });
    for (const name of SETUP_TOKEN_DROPPED_ENV) expect(env).not.toHaveProperty(name);
  });
});

describe('isSetupTokenLaunch', () => {
  it('accepts only the exact launch name', () => {
    expect(isSetupTokenLaunch('claude-setup-token')).toBe(true);
    expect(isSetupTokenLaunch('claude setup-token; rm -rf /')).toBe(false);
    expect(isSetupTokenLaunch(undefined)).toBe(false);
  });
});
