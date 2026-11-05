/**
 * The host variables a child process the app starts may inherit. Everything
 * else in the app's environment (credentials, tokens, NODE_OPTIONS, Claude
 * Code settings) stays with the app: the Claude Code session gets this
 * allowlist in runner.ts (buildEnv), the project's own format/lint tools get
 * the smaller one in format-lint-hook.ts. Pure.
 */

/** Variables Claude Code and MCP servers legitimately need. */
export const SESSION_HOST_ENV = [
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TMPDIR',
  'TERM',
  'HTTPS_PROXY',
  'HTTP_PROXY',
  'NO_PROXY',
  'https_proxy',
  'http_proxy',
  'no_proxy',
  'NODE_EXTRA_CA_CERTS',
  'SSL_CERT_FILE',
] as const;

/** Enough for a formatter or linter to find its home directory, temp dir and locale. */
export const TOOL_HOST_ENV = ['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'LC_CTYPE'] as const;

/** The named variables of `source` that are set, nothing else. */
export function pickHostEnv(names: readonly string[], source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of names) {
    const value = source[key];
    if (value) env[key] = value;
  }
  return env;
}
