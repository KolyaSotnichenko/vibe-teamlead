/**
 * Environment variables across platforms. Windows names PATH `Path` and reads
 * every name case-insensitively; a plain object copied from process.env keeps
 * `Path`, and adding `PATH` to it gives a child both, one of which it ignores.
 * Pure, no Electron: the worker uses it.
 */

/**
 * What Windows programs need to run at all (system folders, the user's
 * folders, temp, executable extensions). No credentials.
 */
export const WINDOWS_HOST_ENV = [
  'SystemRoot',
  'windir',
  'USERPROFILE',
  'APPDATA',
  'LOCALAPPDATA',
  'TEMP',
  'TMP',
  'ComSpec',
  'PATHEXT',
  'ProgramFiles',
  'ProgramFiles(x86)',
  'ProgramW6432',
  'ProgramData',
  'HOMEDRIVE',
  'HOMEPATH',
  'USERNAME',
  'PROCESSOR_ARCHITECTURE',
  'NUMBER_OF_PROCESSORS',
  'OS',
] as const;

/** The value of `name` under any spelling of it. */
export function envValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  if (env[name] !== undefined) return env[name];
  const lower = name.toLowerCase();
  for (const key of Object.keys(env)) if (key.toLowerCase() === lower) return env[key];
  return undefined;
}

/** The key PATH is stored under (`Path` on Windows), or `PATH`. */
export function pathKey(env: NodeJS.ProcessEnv): string {
  if ('PATH' in env) return 'PATH';
  return Object.keys(env).find((key) => key.toLowerCase() === 'path') ?? 'PATH';
}

export function pathValue(env: NodeJS.ProcessEnv): string {
  return envValue(env, 'PATH') ?? '';
}

/** A copy of `env` with PATH set to `value` under one key only. */
export function withPath<T extends NodeJS.ProcessEnv>(env: T, value: string): T {
  const key = pathKey(env);
  const copy = { ...env } as Record<string, string | undefined>;
  for (const name of Object.keys(copy)) if (name.toLowerCase() === 'path') delete copy[name];
  copy[key] = value;
  return copy as T;
}
