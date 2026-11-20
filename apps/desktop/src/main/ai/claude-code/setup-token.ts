/**
 * Settings → Claude → "Get a token": the app's own terminal runs the bundled Claude Code
 * binary with `setup-token` (as the terminal's program, not typed into a shell), so the owner
 * never has to find where the app is installed.
 *
 * The renderer only names the launch; the binary and the environment are decided in main.
 * The app never reads the token from the terminal: the owner pastes it into the subscription field.
 */

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
