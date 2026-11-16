import { describe, expect, it } from 'vitest';

import { envValue, pathKey, pathValue, WINDOWS_HOST_ENV, withPath } from '../env';

describe('PATH under any spelling', () => {
  it('finds the key Windows uses (Path) and falls back to PATH', () => {
    expect(pathKey({ Path: 'C:\\x' })).toBe('Path');
    expect(pathKey({ PATH: '/bin' })).toBe('PATH');
    expect(pathKey({})).toBe('PATH');
    expect(pathValue({ Path: 'C:\\x' })).toBe('C:\\x');
    expect(pathValue({})).toBe('');
  });

  it('sets PATH under the existing key, so a child never gets both Path and PATH', () => {
    const env = withPath({ Path: 'old', SystemRoot: 'C:\\Windows' }, 'new');
    expect(env).toEqual({ Path: 'new', SystemRoot: 'C:\\Windows' });
    expect(withPath({ PATH: 'old', path: 'dup' }, 'new')).toEqual({ PATH: 'new' });
    expect(withPath({ HOME: '/h' }, '/bin')).toEqual({ HOME: '/h', PATH: '/bin' });
  });

  it('reads any variable case-insensitively', () => {
    expect(envValue({ PATHEXT: '.EXE' }, 'PathExt')).toBe('.EXE');
    expect(envValue({}, 'X')).toBeUndefined();
  });
});

describe('WINDOWS_HOST_ENV', () => {
  it('keeps what Windows programs need, and no credentials', () => {
    for (const name of ['SystemRoot', 'windir', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP', 'ComSpec', 'PATHEXT', 'ProgramFiles', 'ProgramFiles(x86)', 'ProgramW6432', 'ProgramData', 'HOMEDRIVE', 'HOMEPATH', 'USERNAME', 'PROCESSOR_ARCHITECTURE', 'NUMBER_OF_PROCESSORS', 'OS']) {
      expect(WINDOWS_HOST_ENV).toContain(name);
    }
    expect(WINDOWS_HOST_ENV.some((name) => /KEY|TOKEN|SECRET|PASSWORD/i.test(name))).toBe(false);
  });
});
