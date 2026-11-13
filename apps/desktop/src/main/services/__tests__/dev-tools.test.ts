import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ shell: { openPath: vi.fn(), openExternal: vi.fn() } }));

import { escapeSingleQuotedPath, isPathSafe } from '../dev-tools';

// The module was moved whole out of the task worktree IPC handlers; these pin its two safety helpers
describe('opening a folder in the developer\'s tools', () => {
  it('escapes single quotes so a folder name cannot end the quoted string in a shell or AppleScript', () => {
    expect(escapeSingleQuotedPath("/tmp/it's here")).toBe("/tmp/it'\\''s here");
    expect(escapeSingleQuotedPath("/tmp/a'; rm -rf ~ '")).toBe("/tmp/a'\\''; rm -rf ~ '\\''");
    expect(escapeSingleQuotedPath('/tmp/plain')).toBe('/tmp/plain');
  });

  it('refuses a path that still climbs out after it is normalized', () => {
    expect(isPathSafe('/Applications/Code.app')).toBe(true);
    expect(isPathSafe('/Applications/x/../Code.app')).toBe(true);
    expect(isPathSafe('../outside')).toBe(false);
    expect(isPathSafe('a/../../b')).toBe(false);
  });
});
