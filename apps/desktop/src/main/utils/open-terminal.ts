/**
 * Open the system terminal in a folder (Settings → "Open in terminal").
 *
 * Windows: cmd.exe in a new console window, spawned detached and unref'd so the
 * main process never waits for that window to close. The folder is the child's
 * working directory, never an argument, so cmd.exe can't read `&` or `|` in a
 * path as a command. macOS: Terminal.app through `open -a` (returns at once).
 * Linux: the first terminal emulator found.
 */

import { execFileSync as nodeExecFileSync, spawn as nodeSpawn } from 'node:child_process';

export interface OpenTerminalDeps {
  spawn: (cmd: string, args: string[], options: Record<string, unknown>) => { unref(): void; on(event: string, listener: (...args: unknown[]) => void): unknown };
  execFileSync: (cmd: string, args: string[], options: Record<string, unknown>) => unknown;
}

const defaultDeps: OpenTerminalDeps = {
  spawn: (cmd, args, options) => nodeSpawn(cmd, args, options),
  execFileSync: (cmd, args, options) => nodeExecFileSync(cmd, args, options),
};

export type OpenTerminalResult = { opened: true } | { opened: false; error: string };

export function openSystemTerminal(dir: string, platform: 'darwin' | 'win32' | 'linux', deps: OpenTerminalDeps = defaultDeps): OpenTerminalResult {
  if (platform === 'darwin') {
    deps.execFileSync('open', ['-a', 'Terminal', dir], { stdio: 'ignore' });
    return { opened: true };
  }
  if (platform === 'win32') {
    const child = deps.spawn('cmd.exe', ['/K'], { cwd: dir, detached: true, stdio: 'ignore', windowsHide: false });
    child.on('error', () => {
      // cmd.exe always exists; nothing to recover if the window can't be started
    });
    child.unref();
    return { opened: true };
  }
  // xterm uses cwd to avoid passing the path through a shell
  const terminals: Array<{ cmd: string; args: string[]; useCwd?: boolean }> = [
    { cmd: 'gnome-terminal', args: ['--working-directory', dir] },
    { cmd: 'konsole', args: ['--workdir', dir] },
    { cmd: 'xfce4-terminal', args: ['--working-directory', dir] },
    { cmd: 'xterm', args: ['-e', 'bash'], useCwd: true },
  ];
  for (const { cmd, args, useCwd } of terminals) {
    try {
      deps.execFileSync(cmd, args, { stdio: 'ignore', ...(useCwd ? { cwd: dir } : {}) });
      return { opened: true };
    } catch {
      // try the next one
    }
  }
  return { opened: false, error: 'No supported terminal emulator found. Please install gnome-terminal, konsole, xfce4-terminal, or xterm.' };
}
