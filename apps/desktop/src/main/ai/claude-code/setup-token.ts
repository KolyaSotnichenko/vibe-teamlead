/**
 * Settings → Claude → "Get a token": the app's own terminal runs the bundled Claude Code
 * binary with `setup-token`, so the owner never has to find where the app is installed.
 *
 * The renderer only names the launch; the binary path, the command line and the
 * environment are decided here, in main. The app never reads the token from the
 * terminal: the owner pastes it into the subscription field.
 */

import { escapeShellArg } from '../../../shared/utils/shell-escape';

type PlatformKey = 'darwin' | 'win32' | 'linux';

/** The one launch a renderer may ask a new terminal for */
export const SETUP_TOKEN_LAUNCH = 'claude-setup-token';
export type TerminalLaunch = typeof SETUP_TOKEN_LAUNCH;

export function isSetupTokenLaunch(value: unknown): value is TerminalLaunch {
  return value === SETUP_TOKEN_LAUNCH;
}

/** Credentials (and the nesting guard) that must not reach `setup-token` from the app or settings files */
export const SETUP_TOKEN_DROPPED_ENV = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'CLAUDECODE',
] as const;

function shellName(shellPath: string): string {
  return (shellPath.split(/[/\\]/).pop() ?? '').toLowerCase();
}

/** The line typed into the terminal's shell: the binary quoted for that shell, then `setup-token`. */
export function setupTokenCommand(binary: string, platform: PlatformKey, shellPath: string): string {
  const path = binary.replace(/[\r\n]/g, '');
  if (platform !== 'win32') return `${escapeShellArg(path)} setup-token`;
  const shell = shellName(shellPath);
  // PowerShell: a quoted path is a string until the call operator runs it; '' is a literal quote
  if (shell === 'powershell.exe' || shell === 'pwsh.exe') return `& '${path.replace(/'/g, "''")}' setup-token`;
  if (shell.includes('bash') || shell === 'sh.exe') return `${escapeShellArg(path)} setup-token`;
  // cmd.exe: Windows paths can't contain a double quote
  return `"${path.replace(/"/g, '')}" setup-token`;
}

/** The terminal's environment without the dropped variables, on the app's own Claude Code config dir. */
export function setupTokenEnv(env: Record<string, string | undefined>, configDir: string): Record<string, string> {
  const dropped = new Set<string>(SETUP_TOKEN_DROPPED_ENV);
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    if (value !== undefined && !dropped.has(name)) out[name] = value;
  }
  out.CLAUDE_CONFIG_DIR = configDir;
  return out;
}
