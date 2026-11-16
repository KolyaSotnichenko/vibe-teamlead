import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

const killTree = vi.hoisted(() => vi.fn(() => true));
vi.mock('../../../platform/exec', async (original) => ({ ...(await original<typeof import('../../../platform/exec')>()), killTree }));

import { cleanUpLeftovers, devServerProcess } from '../dev-servers';

describe('dev server processes on Windows (no process groups, ps or lsof)', () => {
  const win = devServerProcess('win32');

  it('stops a server with killTree (taskkill /T /F), never a negative pid', () => {
    const kill = vi.spyOn(process, 'kill');
    win.signal(4242, 'SIGTERM');
    expect(killTree).toHaveBeenCalledWith(4242, 'SIGTERM', 'win32');
    expect(kill).not.toHaveBeenCalled();
    kill.mockRestore();
  });

  it('checks the process itself, and has no start time to record', () => {
    expect(win.alive(process.pid)).toBe(true);
    expect(win.alive(2 ** 22 + 12345)).toBe(false);
    expect(win.startedAt(process.pid)).toBe('');
  });

  it('leaves listed leftovers alone: without ps or lsof it cannot tell they are the same process', async () => {
    const specDir = mkdtempSync(path.join(tmpdir(), 'vtl-dev-win-'));
    const left = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { cwd: specDir, stdio: 'ignore' });
    mkdirSync(path.join(specDir, 'dev-servers'), { recursive: true });
    const list = path.join(specDir, 'dev-servers', 'servers.json');
    writeFileSync(list, JSON.stringify([{ pid: left.pid, startedAt: 'x' }]));
    killTree.mockClear();
    cleanUpLeftovers(specDir, 'win32');
    expect(killTree).not.toHaveBeenCalled();
    expect(left.exitCode).toBeNull();
    expect(readFileSync(list, 'utf-8')).toBe('[]');
    left.kill('SIGKILL');
  });
});

describe('dev server processes on macOS', () => {
  it('signal the process group, as before', () => {
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
    devServerProcess('darwin').signal(4242, 'SIGKILL');
    expect(kill).toHaveBeenCalledWith(-4242, 'SIGKILL');
    kill.mockRestore();
  });
});
