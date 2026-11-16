import { describe, expect, it, vi } from 'vitest';

import { openSystemTerminal } from '../open-terminal';

function deps() {
  const unref = vi.fn();
  const spawn = vi.fn(() => ({ unref, on: vi.fn() }));
  const execFileSync = vi.fn();
  return { spawn, execFileSync, unref };
}

describe('openSystemTerminal', () => {
  it('on Windows starts cmd.exe in its own window, detached, without waiting for it to close', () => {
    const d = deps();
    expect(openSystemTerminal('C:\\Users\\me\\a&b project', 'win32', d)).toEqual({ opened: true });
    expect(d.execFileSync).not.toHaveBeenCalled();
    expect(d.spawn).toHaveBeenCalledTimes(1);
    const [cmd, args, options] = d.spawn.mock.calls[0] as unknown as [string, string[], Record<string, unknown>];
    expect(cmd).toBe('cmd.exe');
    // The folder is the working directory, never an argument cmd.exe would parse (a&b)
    expect(args.join(' ')).not.toContain('a&b');
    expect(options).toMatchObject({ cwd: 'C:\\Users\\me\\a&b project', detached: true, stdio: 'ignore', windowsHide: false });
    expect(d.unref).toHaveBeenCalled();
  });

  it('on macOS opens Terminal.app with open -a, as before', () => {
    const d = deps();
    expect(openSystemTerminal('/Users/me/p', 'darwin', d)).toEqual({ opened: true });
    expect(d.execFileSync).toHaveBeenCalledWith('open', ['-a', 'Terminal', '/Users/me/p'], { stdio: 'ignore' });
    expect(d.spawn).not.toHaveBeenCalled();
  });
});
