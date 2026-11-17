import { describe, expect, it } from 'vitest';
import { SETUP_TOKEN_DROPPED_ENV, isSetupTokenLaunch, setupTokenCommand, setupTokenEnv } from '../setup-token';

describe('setupTokenCommand', () => {
  it('macOS: quotes the bundled binary for the POSIX shell', () => {
    expect(setupTokenCommand('/Applications/Vibe Teamlead.app/Contents/Resources/claude-code/claude', 'darwin', '/bin/zsh')).toBe(
      "'/Applications/Vibe Teamlead.app/Contents/Resources/claude-code/claude' setup-token"
    );
  });

  it("macOS: a quote in the path can't break out of the quoting", () => {
    expect(setupTokenCommand("/Users/o'neil/claude", 'darwin', '/bin/bash')).toBe("'/Users/o'\\''neil/claude' setup-token");
  });

  const winBinary = 'D:\\Vibe Teamlead\\resources\\claude-code\\claude.exe';

  it('Windows cmd.exe: a double-quoted path on any drive, spaces included', () => {
    expect(setupTokenCommand(winBinary, 'win32', 'C:\\Windows\\System32\\cmd.exe')).toBe(`"${winBinary}" setup-token`);
  });

  it('Windows PowerShell 5.1 and 7: the call operator with a single-quoted path', () => {
    expect(setupTokenCommand(winBinary, 'win32', 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')).toBe(
      `& '${winBinary}' setup-token`
    );
    expect(setupTokenCommand("D:\\O'Neil\\claude.exe", 'win32', 'C:\\Program Files\\PowerShell\\7\\pwsh.exe')).toBe(
      "& 'D:\\O''Neil\\claude.exe' setup-token"
    );
  });

  it('Windows Git Bash: POSIX quoting', () => {
    expect(setupTokenCommand(winBinary, 'win32', 'C:\\Program Files\\Git\\bin\\bash.exe')).toBe(`'${winBinary}' setup-token`);
  });

  it('drops line breaks, which would end the command early', () => {
    expect(setupTokenCommand('/a\nrm -rf ~/claude', 'darwin', '/bin/zsh')).toBe("'/arm -rf ~/claude' setup-token");
  });
});

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
