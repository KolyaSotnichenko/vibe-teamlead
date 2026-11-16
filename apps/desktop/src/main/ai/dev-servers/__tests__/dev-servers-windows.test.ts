import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

const killTree = vi.hoisted(() => vi.fn(() => true));
vi.mock('../../../platform/exec', async (original) => ({ ...(await original<typeof import('../../../platform/exec')>()), killTree }));

import { cleanUpLeftovers, devServerProcess, stopServerProcess } from '../dev-servers';

const START = '2026-11-16T10:00:00.0000000Z';

describe('dev server processes on Windows (no process groups, ps or lsof)', () => {
  it('stops a server with killTree (taskkill /T /F), never a negative pid', () => {
    const kill = vi.spyOn(process, 'kill');
    devServerProcess('win32').signal(4242, 'SIGTERM');
    expect(killTree).toHaveBeenCalledWith(4242, 'SIGTERM', 'win32');
    expect(kill).not.toHaveBeenCalled();
    kill.mockRestore();
  });

  it('checks the process itself, and has no start time to record', () => {
    const win = devServerProcess('win32');
    expect(win.alive(process.pid)).toBe(true);
    expect(win.alive(2 ** 22 + 12345)).toBe(false);
    expect(win.startedAt(process.pid)).toBe('');
  });

  it('a server whose process already exited is not killed: its pid may belong to another process now', async () => {
    killTree.mockClear();
    const win = devServerProcess('win32');
    await stopServerProcess({ pid: process.pid, child: { exitCode: 0, signalCode: null } as never }, win);
    await stopServerProcess({ pid: process.pid, child: { exitCode: null, signalCode: 'SIGTERM' } as never }, win);
    expect(killTree).not.toHaveBeenCalled();
  });

  it('a running server is killed with taskkill', async () => {
    killTree.mockClear();
    let running = true;
    const win = { ...devServerProcess('win32'), alive: () => running };
    killTree.mockImplementationOnce(() => {
      running = false;
      return true;
    });
    await stopServerProcess({ pid: 4242, child: { exitCode: null, signalCode: null } as never }, win);
    expect(killTree).toHaveBeenCalledWith(4242, 'SIGTERM', 'win32');
  });

  describe('leftovers of an earlier run', () => {
    const leftovers = (entries: unknown[]) => {
      const specDir = mkdtempSync(path.join(tmpdir(), 'vtl-dev-win-'));
      mkdirSync(path.join(specDir, 'dev-servers'), { recursive: true });
      writeFileSync(path.join(specDir, 'dev-servers', 'servers.json'), JSON.stringify(entries));
      return specDir;
    };

    it('never kills one on Windows, even listed with its real start time: an agent can write the list, and there is no lsof to check the folder', () => {
      killTree.mockClear();
      const log = vi.fn();
      const specDir = leftovers([{ pid: 4242, startedAt: START }, { pid: 4343, startedAt: 'x' }]);
      cleanUpLeftovers(specDir, 'win32', log);
      expect(killTree).not.toHaveBeenCalled();
      expect(log).toHaveBeenCalledTimes(2);
      expect(log.mock.calls.join('\n')).toMatch(/4242.*left running/);
      expect(readFileSync(path.join(specDir, 'dev-servers', 'servers.json'), 'utf-8')).toBe('[]');
    });
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
