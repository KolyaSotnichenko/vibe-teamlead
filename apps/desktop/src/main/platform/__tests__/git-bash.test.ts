import { describe, expect, it } from 'vitest';

import { deriveGitBashPath, findGitBash } from '../git-bash';

const files = (...paths: string[]) => {
  const set = new Set(paths.map((p) => p.toLowerCase()));
  return (p: string) => set.has(p.toLowerCase());
};

describe('deriveGitBashPath', () => {
  const bash = 'C:\\Program Files\\Git\\bin\\bash.exe';
  const exists = files(bash);

  it('finds bin\\bash.exe from each place git.exe lives', () => {
    expect(deriveGitBashPath('C:\\Program Files\\Git\\cmd\\git.exe', exists)).toBe(bash);
    expect(deriveGitBashPath('C:\\Program Files\\Git\\bin\\git.exe', exists)).toBe(bash);
    expect(deriveGitBashPath('C:\\Program Files\\Git\\mingw64\\bin\\git.exe', exists)).toBe(bash);
  });

  it('is null when there is no bash.exe', () => {
    expect(deriveGitBashPath('C:\\tools\\git\\git.exe', files())).toBeNull();
  });
});

describe('findGitBash', () => {
  const bash = 'D:\\Git\\bin\\bash.exe';

  it('is null on macOS and Linux', () => {
    expect(findGitBash({ platform: 'darwin', env: { PATH: '/usr/bin' }, exists: () => true })).toBeNull();
  });

  it('keeps a bash the user set in CLAUDE_CODE_GIT_BASH_PATH', () => {
    const own = 'E:\\msys\\usr\\bin\\bash.exe';
    expect(findGitBash({ platform: 'win32', env: { CLAUDE_CODE_GIT_BASH_PATH: own }, exists: files(own, bash) })).toBe(own);
  });

  it('derives it from git.exe on Path', () => {
    expect(findGitBash({ platform: 'win32', env: { Path: 'C:\\Windows;D:\\Git\\cmd' }, exists: files('D:\\Git\\cmd\\git.exe', bash) })).toBe(bash);
  });

  it('looks in the standard install folders when git is not on Path', () => {
    const local = 'C:\\Users\\me\\AppData\\Local\\Programs\\Git\\bin\\bash.exe';
    expect(findGitBash({ platform: 'win32', env: { LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local' }, exists: files(local) })).toBe(local);
    const programFiles = 'C:\\Program Files\\Git\\bin\\bash.exe';
    expect(findGitBash({ platform: 'win32', env: {}, exists: files(programFiles) })).toBe(programFiles);
  });

  it('is null when Git for Windows is not installed', () => {
    expect(findGitBash({ platform: 'win32', env: { Path: 'C:\\Windows' }, exists: files() })).toBeNull();
  });
});
