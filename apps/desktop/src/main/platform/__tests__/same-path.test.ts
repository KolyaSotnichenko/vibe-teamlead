import { describe, expect, it } from 'vitest';

import { isSameOrInside, samePath } from '../same-path';

describe('samePath', () => {
  // What Windows' realpath gives: the long name of an 8.3 short one (RUNNER~1), in the case on disk
  const longNames = (p: string) => p.replace('RUNNER~1', 'runneradmin').replace(/^c:/, 'C:');

  it('on Windows, matches the forward-slash path git prints with the short-name path Node has', () => {
    const git = 'C:/Users/runneradmin/AppData/Local/Temp/p/.vibe-teamlead/worktrees/tasks/001';
    const node = 'C:\\Users\\RUNNER~1\\AppData\\Local\\Temp\\p\\.vibe-teamlead\\worktrees\\tasks\\001';
    expect(samePath(git, node, 'win32', longNames)).toBe(true);
  });

  it('on Windows, ignores case and still tells different folders apart, also when they are missing', () => {
    const missing = () => {
      throw new Error('ENOENT');
    };
    expect(samePath('c:\\Projects\\App', 'C:/projects/app', 'win32', missing)).toBe(true);
    expect(samePath('C:\\Projects\\App', 'C:\\Projects\\App-2', 'win32', missing)).toBe(false);
  });

  it('elsewhere compares the strings as given, as before', () => {
    expect(samePath('/p/a', '/p/a', 'darwin')).toBe(true);
    expect(samePath('/p/A', '/p/a', 'darwin')).toBe(false);
    expect(samePath('/p/a/', '/p/a', 'linux')).toBe(false);
  });
});

describe('isSameOrInside', () => {
  it('on Windows ignores case and slash direction, and needs a whole folder name', () => {
    const root = 'C:\\Users\\n\\p\\.vibe-teamlead\\worktrees\\tasks\\014-x';
    expect(isSameOrInside('c:/users/N/p/.vibe-teamlead/worktrees/tasks/014-x/apps/api', root, 'win32')).toBe(true);
    expect(isSameOrInside(root, root.toUpperCase(), 'win32')).toBe(true);
    expect(isSameOrInside(`${root}-2\\apps`, root, 'win32')).toBe(false);
    expect(isSameOrInside('', root, 'win32')).toBe(false);
  });

  it('elsewhere compares as given', () => {
    expect(isSameOrInside('/p/t/apps', '/p/t', 'darwin')).toBe(true);
    expect(isSameOrInside('/p/t', '/p/t', 'darwin')).toBe(true);
    expect(isSameOrInside('/p/t-2', '/p/t', 'darwin')).toBe(false);
    expect(isSameOrInside('/P/t/apps', '/p/t', 'darwin')).toBe(false);
  });
});
