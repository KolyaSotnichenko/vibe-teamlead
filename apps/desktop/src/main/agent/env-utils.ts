/**
 * Utility functions for managing environment variables in agent spawning
 */

/**
 * Normalize the PATH key in an environment object to a single uppercase 'PATH' key.
 *
 * On Windows, process.env spreads as 'Path' (the native casing) while getAugmentedEnv()
 * writes 'PATH'. Without normalization, both keys coexist in the object and the child
 * process receives duplicate PATH entries, causing tool-not-found errors like #1661.
 *
 * Mutates the provided env object in place and returns it for convenience.
 *
 * @param env - Mutable environment record to normalize
 * @returns The same env object with PATH normalized to uppercase
 */
export function normalizeEnvPathKey(env: Record<string, string | undefined>): Record<string, string | undefined> {
  // If 'PATH' already exists, delete all other case-variant keys (e.g. 'Path')
  if ('PATH' in env) {
    for (const key of Object.keys(env)) {
      if (key !== 'PATH' && key.toUpperCase() === 'PATH') {
        delete env[key];
      }
    }
    return env;
  }

  // No uppercase 'PATH' key - find the first case-variant and rename it
  const pathKey = Object.keys(env).find(k => k.toUpperCase() === 'PATH');
  if (pathKey) {
    env['PATH'] = env[pathKey];
    delete env[pathKey];
    // Remove any remaining case-variant keys
    for (const key of Object.keys(env)) {
      if (key !== 'PATH' && key.toUpperCase() === 'PATH') {
        delete env[key];
      }
    }
  }

  return env;
}

/**
 * Merge pythonEnv PATH entries with the augmented PATH in env, deduplicating entries.
 *
 * pythonEnv may carry its own PATH (e.g. pywin32_system32 prepended on Windows).
 * Simply spreading pythonEnv after env would overwrite the augmented PATH (which
 * includes npm globals, Homebrew, etc.), causing "Claude code not found" (#1661).
 *
 * Strategy:
 *  1. Normalize PATH key casing in both env and pythonEnv to uppercase 'PATH'.
 *  2. Extract only pythonEnv PATH entries that are not already in env.PATH.
 *  3. Prepend those unique entries to env.PATH and store the result in pythonEnv.PATH.
 *
 * Mutates mergedPythonEnv in place (caller should pass a shallow copy if immutability is needed).
 *
 * @param env - The base environment (already augmented with tool paths)
 * @param mergedPythonEnv - Shallow copy of pythonEnv to merge PATH into
 * @param pathSep - Platform path separator (';' on Windows, ':' elsewhere)
 */
export function mergePythonEnvPath(
  env: Record<string, string | undefined>,
  mergedPythonEnv: Record<string, string | undefined>,
  pathSep: string
): void {
  // Normalize PATH key to uppercase in both objects
  normalizeEnvPathKey(env);
  normalizeEnvPathKey(mergedPythonEnv);

  if (mergedPythonEnv['PATH'] && env['PATH']) {
    const augmentedPathEntries = new Set(
      (env['PATH'] as string).split(pathSep).filter(Boolean)
    );
    // Extract only new entries from pythonEnv.PATH that aren't already in the augmented PATH
    const pythonPathEntries = (mergedPythonEnv['PATH'] as string)
      .split(pathSep)
      .filter(entry => entry && !augmentedPathEntries.has(entry));

    // Prepend python-specific paths (e.g., pywin32_system32) to the augmented PATH
    mergedPythonEnv['PATH'] = pythonPathEntries.length > 0
      ? [...pythonPathEntries, env['PATH'] as string].join(pathSep)
      : env['PATH'] as string;
  }
}
