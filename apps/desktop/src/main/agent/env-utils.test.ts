/**
 * Unit tests for env-utils
 * Tests PATH normalization and merging
 */

import { describe, it, expect } from 'vitest';
import { normalizeEnvPathKey, mergePythonEnvPath } from './env-utils';

describe('normalizeEnvPathKey', () => {
  it('should leave an already-uppercase PATH key untouched', () => {
    const env: Record<string, string | undefined> = { PATH: '/usr/bin:/bin', HOME: '/home/user' };
    normalizeEnvPathKey(env);
    expect(env).toEqual({ PATH: '/usr/bin:/bin', HOME: '/home/user' });
  });

  it('should rename a lowercase-variant "Path" key to "PATH"', () => {
    const env: Record<string, string | undefined> = { Path: 'C:\\Windows\\system32', HOME: '/home/user' };
    normalizeEnvPathKey(env);
    expect(env['PATH']).toBe('C:\\Windows\\system32');
    expect('Path' in env).toBe(false);
  });

  it('should prefer existing "PATH" and remove "Path" when both keys coexist', () => {
    // Simulates process.env spread ('Path') after getAugmentedEnv writes ('PATH')
    const env: Record<string, string | undefined> = {
      Path: 'C:\\old',
      PATH: 'C:\\Windows\\system32;C:\\augmented',
      HOME: '/home/user'
    };
    normalizeEnvPathKey(env);
    expect(env.PATH).toBe('C:\\Windows\\system32;C:\\augmented');
    expect('Path' in env).toBe(false);
  });

  it('should remove all case-variant PATH duplicates when PATH is already present', () => {
    const env: Record<string, string | undefined> = {
      PATH: '/correct',
      Path: '/old1',
      path: '/old2'
    };
    normalizeEnvPathKey(env);
    expect(env.PATH).toBe('/correct');
    expect('Path' in env).toBe(false);
    expect('path' in env).toBe(false);
  });

  it('should handle env with no PATH-like key gracefully', () => {
    const env: Record<string, string | undefined> = { HOME: '/home/user', SHELL: '/bin/zsh' };
    normalizeEnvPathKey(env);
    expect(env).toEqual({ HOME: '/home/user', SHELL: '/bin/zsh' });
  });

  it('should return the same env object reference (mutates in place)', () => {
    const env: Record<string, string | undefined> = { PATH: '/usr/bin' };
    const result = normalizeEnvPathKey(env);
    expect(result).toBe(env);
  });
});

describe('mergePythonEnvPath - Windows PATH merge logic (#1661)', () => {
  const SEP = ';'; // Use Windows separator for these tests

  it('should prepend pythonEnv-only entries to the augmented PATH', () => {
    const env: Record<string, string | undefined> = {
      PATH: 'C:\\npm;C:\\homebrew'
    };
    const mergedPythonEnv: Record<string, string | undefined> = {
      PATH: 'C:\\pywin32_system32;C:\\npm;C:\\homebrew'
    };

    mergePythonEnvPath(env, mergedPythonEnv, SEP);

    // pywin32_system32 is unique to pythonEnv, so it should be prepended
    expect(mergedPythonEnv.PATH).toBe('C:\\pywin32_system32;C:\\npm;C:\\homebrew');
  });

  it('should deduplicate entries that already exist in augmented PATH', () => {
    const env: Record<string, string | undefined> = {
      PATH: 'C:\\npm;C:\\homebrew;C:\\pywin32_system32'
    };
    const mergedPythonEnv: Record<string, string | undefined> = {
      PATH: 'C:\\pywin32_system32;C:\\npm'
    };

    mergePythonEnvPath(env, mergedPythonEnv, SEP);

    // All pythonEnv entries are already in env.PATH, so mergedPythonEnv.PATH should equal env.PATH
    expect(mergedPythonEnv.PATH).toBe('C:\\npm;C:\\homebrew;C:\\pywin32_system32');
  });

  it('should normalize Windows-style "Path" key in pythonEnv to "PATH"', () => {
    const env: Record<string, string | undefined> = {
      PATH: 'C:\\npm;C:\\homebrew'
    };
    // pythonEnv uses 'Path' (Windows native casing)
    const mergedPythonEnv: Record<string, string | undefined> = {
      Path: 'C:\\pywin32_system32;C:\\npm'
    };

    mergePythonEnvPath(env, mergedPythonEnv, SEP);

    // 'Path' should be normalized to 'PATH' and pythonEnv-specific entry prepended
    expect('Path' in mergedPythonEnv).toBe(false);
    expect(mergedPythonEnv.PATH).toBe('C:\\pywin32_system32;C:\\npm;C:\\homebrew');
  });

  it('should normalize Windows-style "Path" in env and deduplicate duplicates', () => {
    // Simulates process.env spread ('Path') + getAugmentedEnv write ('PATH') leaving both
    const env: Record<string, string | undefined> = {
      Path: 'C:\\old',
      PATH: 'C:\\npm;C:\\homebrew'
    };
    const mergedPythonEnv: Record<string, string | undefined> = {
      PATH: 'C:\\pywin32_system32;C:\\npm'
    };

    mergePythonEnvPath(env, mergedPythonEnv, SEP);

    // env 'Path' should be removed; augmented 'PATH' value preserved
    expect('Path' in env).toBe(false);
    expect(env.PATH).toBe('C:\\npm;C:\\homebrew');
    // Only the unique pywin32_system32 entry prepended
    expect(mergedPythonEnv.PATH).toBe('C:\\pywin32_system32;C:\\npm;C:\\homebrew');
  });

  it('should use env.PATH unchanged when pythonEnv has no unique entries', () => {
    const env: Record<string, string | undefined> = {
      PATH: 'C:\\npm;C:\\homebrew'
    };
    const mergedPythonEnv: Record<string, string | undefined> = {
      PATH: 'C:\\npm;C:\\homebrew'
    };

    mergePythonEnvPath(env, mergedPythonEnv, SEP);

    expect(mergedPythonEnv.PATH).toBe('C:\\npm;C:\\homebrew');
  });

  it('should work correctly with Unix colon separator', () => {
    const unixSep = ':';
    const env: Record<string, string | undefined> = {
      PATH: '/usr/bin:/bin'
    };
    const mergedPythonEnv: Record<string, string | undefined> = {
      PATH: '/opt/pyenv/shims:/usr/bin:/bin'
    };

    mergePythonEnvPath(env, mergedPythonEnv, unixSep);

    // /opt/pyenv/shims is unique and should be prepended
    expect(mergedPythonEnv.PATH).toBe('/opt/pyenv/shims:/usr/bin:/bin');
  });

  it('should handle missing PATH in pythonEnv gracefully (no-op)', () => {
    const env: Record<string, string | undefined> = {
      PATH: 'C:\\npm;C:\\homebrew'
    };
    // pythonEnv has no PATH at all
    const mergedPythonEnv: Record<string, string | undefined> = {
      PYTHONPATH: '/site-packages'
    };

    mergePythonEnvPath(env, mergedPythonEnv, SEP);

    // Nothing should change
    expect(mergedPythonEnv.PATH).toBeUndefined();
    expect(mergedPythonEnv.PYTHONPATH).toBe('/site-packages');
    expect(env.PATH).toBe('C:\\npm;C:\\homebrew');
  });
});
