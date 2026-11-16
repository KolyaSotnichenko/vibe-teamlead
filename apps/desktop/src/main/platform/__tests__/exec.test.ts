import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import { commandFor, extraPaths, findOnPath, GitBashMissingError, killTree, runProcess, runShell, searchPath, shellCommand, UnsafeCmdArgumentError } from '../exec';

describe('runProcess', () => {
  it('returns output and exit code without throwing', async () => {
    const ok = await runProcess('sh', ['-c', 'echo hi; echo err >&2; exit 3']);
    expect(ok).toMatchObject({ code: 3, stdout: 'hi\n', stderr: 'err\n', timedOut: false, aborted: false });
    const missing = await runProcess('/nonexistent/tool', []);
    expect(missing.code).toBe(-1);
    expect(missing.error).toBeTruthy();
  });

  it('kills on timeout and on abort, and never starts when already aborted', async () => {
    expect((await runProcess('sleep', ['5'], { timeoutMs: 100 })).timedOut).toBe(true);
    const controller = new AbortController();
    const running = runProcess('sleep', ['5'], { signal: controller.signal });
    setTimeout(() => controller.abort(), 50);
    expect((await running).aborted).toBe(true);
    const pre = new AbortController();
    pre.abort();
    expect(await runProcess('sh', ['-c', 'exit 0'], { signal: pre.signal })).toMatchObject({ aborted: true, code: -1 });
  });

  it('streams whole lines and caps captured output', async () => {
    const lines: string[] = [];
    const result = await runProcess('sh', ['-c', 'printf "a\\nb"; printf "%0500d" 0'], { onLine: (l) => lines.push(l), maxOutput: 10 });
    expect(lines[0]).toBe('a');
    expect(result.stdout.length).toBe(10);
  });

  it('finds executables on PATH', () => {
    expect(findOnPath('sh')).toMatch(/[\\/]sh(\.exe)?$/i);
    expect(findOnPath('definitely-not-a-tool-xyz')).toBeUndefined();
  });
});

describe('searchPath', () => {
  it('includes the places Docker Desktop and OrbStack put the docker CLI on macOS', async () => {
    const { searchPath: search } = await import('../exec');
    const { homedir } = await import('node:os');
    const dirs = search([], 'darwin').split(':');
    expect(dirs).toContain(`${homedir()}/.docker/bin`);
    expect(dirs).toContain('/Applications/Docker.app/Contents/Resources/bin');
    expect(dirs).toContain(`${homedir()}/.orbstack/bin`);
  });
});

describe('findOnPath on Windows', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vtl-pathext-'));
  const other = mkdtempSync(join(tmpdir(), 'vtl-pathext-'));
  // Git for Windows puts an extension-less sh script for npm next to npm.cmd: not runnable on Windows
  for (const file of ['npm', 'npm.cmd', 'docker.exe', 'run.bat']) writeFileSync(join(dir, file), '');
  writeFileSync(join(other, 'docker.cmd'), '');
  const path = `${other};${dir}`;
  const env = { PATHEXT: '.COM;.EXE;.BAT;.CMD' };

  it('honours PATHEXT: .exe, .cmd and .bat, never a bare script', () => {
    expect(findOnPath('npm', path, 'win32', env)).toBe(join(dir, 'npm.cmd'));
    expect(findOnPath('run', path, 'win32', env)).toBe(join(dir, 'run.bat'));
    expect(findOnPath('docker', path, 'win32', env)).toBe(join(other, 'docker.cmd'));
    expect(findOnPath('docker.exe', path, 'win32', env)).toBe(join(dir, 'docker.exe'));
    expect(findOnPath('nothing', path, 'win32', env)).toBeUndefined();
  });

  it('uses the default PATHEXT when none is set, and splits Path on ;', () => {
    expect(findOnPath('npm', dir, 'win32', {})).toBe(join(dir, 'npm.cmd'));
  });

  it('is unchanged on macOS: the exact name only', () => {
    expect(findOnPath('npm', dir, 'darwin', env)).toBe(join(dir, 'npm'));
    expect(findOnPath('docker', dir, 'darwin', env)).toBeUndefined();
  });
});

describe('extraPaths', () => {
  it('on Windows: Docker Desktop, npm and pnpm globals, Git cmd, scoop, nvm-windows', () => {
    const env = {
      ProgramFiles: 'C:\\Program Files',
      APPDATA: 'C:\\Users\\me\\AppData\\Roaming',
      LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local',
      USERPROFILE: 'C:\\Users\\me',
      NVM_SYMLINK: 'C:\\nvm4w\\nodejs',
      CLAUDE_CODE_GIT_BASH_PATH: 'D:\\Git\\bin\\bash.exe',
    };
    const dirs = extraPaths('win32', env, (file) => file === 'D:\\Git\\bin\\bash.exe');
    expect(dirs).toEqual([
      'C:\\Program Files\\Docker\\Docker\\resources\\bin',
      'C:\\Users\\me\\AppData\\Roaming\\npm',
      'C:\\Users\\me\\AppData\\Local\\pnpm',
      'C:\\Users\\me\\.local\\bin',
      'D:\\Git\\cmd',
      'C:\\Users\\me\\scoop\\shims',
      'C:\\nvm4w\\nodejs',
    ]);
    expect(dirs.some((dir) => dir.startsWith('/'))).toBe(false);
  });

  it('on Windows leaves out what is not set', () => {
    expect(extraPaths('win32', { ProgramFiles: 'C:\\PF' }, () => false)).toEqual(['C:\\PF\\Docker\\Docker\\resources\\bin']);
  });

  it('on macOS: Homebrew and friends, no Windows folders', () => {
    const dirs = extraPaths('darwin', { APPDATA: 'C:\\x' });
    expect(dirs).toContain('/opt/homebrew/bin');
    expect(dirs.some((dir) => dir.includes('\\'))).toBe(false);
  });

  it('searchPath on Windows joins with ; and reads Path', () => {
    const joined = searchPath([], 'win32', { Path: 'C:\\Windows\\System32', ProgramFiles: 'C:\\PF' });
    expect(joined.split(';')[0]).toBe('C:\\Windows\\System32');
    expect(joined.split(';')).toContain('C:\\PF\\Docker\\Docker\\resources\\bin');
    expect(joined).not.toContain('/opt/homebrew');
  });
});

describe('shellCommand', () => {
  it('runs /bin/sh -c on macOS and Linux', () => {
    expect(shellCommand('npm test', 'darwin')).toEqual({ file: '/bin/sh', args: ['-c', 'npm test'] });
    expect(shellCommand('npm test', 'linux')).toEqual({ file: '/bin/sh', args: ['-c', 'npm test'] });
  });

  it('runs Git Bash -c on Windows', () => {
    const bash = 'C:\\Program Files\\Git\\bin\\bash.exe';
    expect(shellCommand('npm test', 'win32', { CLAUDE_CODE_GIT_BASH_PATH: bash }, (file) => file === bash)).toEqual({ file: bash, args: ['-c', 'npm test'] });
  });

  it('says clearly that Git for Windows is missing', () => {
    expect(() => shellCommand('npm test', 'win32', {}, () => false)).toThrow(GitBashMissingError);
    expect(() => shellCommand('npm test', 'win32', {}, () => false)).toThrow(/Git for Windows.*git-scm\.com/s);
  });
});

describe('commandFor', () => {
  const bash = 'C:\\Git\\bin\\bash.exe';
  const env = { CLAUDE_CODE_GIT_BASH_PATH: bash };
  const nodejs = 'C:\\Program Files\\nodejs';
  const roaming = 'C:\\Users\\me\\AppData\\Roaming\\npm';
  const real = new Set([
    bash,
    `${nodejs}\\node.exe`,
    `${nodejs}\\node_modules\\npm\\bin\\npm-cli.js`,
    `${nodejs}\\node_modules\\npm\\bin\\npx-cli.js`,
    `${roaming}\\node_modules\\pnpm\\bin\\pnpm.cjs`,
  ]);
  const exists = (file: string) => real.has(file);
  // What npm's cmd-shim writes for a global package
  const pnpmShim = '@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\n\r\nIF EXIST "%dp0%\\node.exe" (\r\n  SET "_prog=%dp0%\\node.exe"\r\n) ELSE (\r\n  SET "_prog=node"\r\n  SET PATHEXT=%PATHEXT:;.JS;=;%\r\n)\r\n\r\nendLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\pnpm\\bin\\pnpm.cjs" %*\r\n';
  const read = (file: string) => (file === `${roaming}\\pnpm.cmd` ? pnpmShim : '@echo off\r\nrun.exe %*\r\n');
  const path = { Path: `${nodejs};${roaming}` };

  it("runs npm and npx as node with npm's own script: no .cmd, so cmd.exe never parses the arguments", () => {
    expect(commandFor(`${nodejs}\\npm.cmd`, ['install', 'a&calc'], 'win32', env, exists, read)).toEqual({
      file: `${nodejs}\\node.exe`,
      args: [`${nodejs}\\node_modules\\npm\\bin\\npm-cli.js`, 'install', 'a&calc'],
    });
    expect(commandFor(`${nodejs}\\npx.cmd`, ['prisma'], 'win32', env, exists, read).args[0]).toBe(`${nodejs}\\node_modules\\npm\\bin\\npx-cli.js`);
  });

  it("runs a cmd-shim (pnpm, yarn installed with npm) as node with the script the shim names", () => {
    expect(commandFor(`${roaming}\\pnpm.cmd`, ['install', 'x|y'], 'win32', { ...env, ...path }, exists, read)).toEqual({
      file: `${nodejs}\\node.exe`,
      args: [`${roaming}\\node_modules\\pnpm\\bin\\pnpm.cjs`, 'install', 'x|y'],
    });
  });

  it('runs any other .cmd or .bat through the shell, with plain arguments only', () => {
    expect(commandFor('C:\\x\\RUN.BAT', ['install', "it's"], 'win32', env, exists, read)).toEqual({
      file: bash,
      args: ['-c', `'C:/x/RUN.BAT' 'install' 'it'\\''s'`],
    });
  });

  it('refuses an argument cmd.exe would re-parse (a&calc and friends) instead of passing it to cmd', () => {
    for (const arg of ['a&calc', 'a|b', 'a>b', 'a<b', 'a^b', '%PATH%', '!x!', 'a"b', '(a)', 'a\nb']) {
      expect(() => commandFor('C:\\x\\run.cmd', [arg], 'win32', env, exists, read)).toThrow(UnsafeCmdArgumentError);
    }
  });

  it('leaves .exe files and every other platform alone', () => {
    expect(commandFor('C:\\x\\docker.exe', ['ps', 'a&b'], 'win32', env, exists, read)).toEqual({ file: 'C:\\x\\docker.exe', args: ['ps', 'a&b'] });
    expect(commandFor('/usr/local/bin/npm.cmd', ['i'], 'darwin')).toEqual({ file: '/usr/local/bin/npm.cmd', args: ['i'] });
  });
});

describe('killTree', () => {
  it('on Windows runs taskkill /T /F on the pid, hidden', () => {
    const spawn = vi.fn(() => ({ on: vi.fn(), unref: vi.fn() }));
    const kill = vi.fn();
    expect(killTree(4242, 'SIGTERM', 'win32', { spawn: spawn as never, kill })).toBe(true);
    expect(spawn).toHaveBeenCalledWith(expect.stringMatching(/taskkill\.exe$/), ['/pid', '4242', '/T', '/F'], expect.objectContaining({ windowsHide: true }));
    expect(kill).not.toHaveBeenCalled();
  });

  it('elsewhere signals the process group', () => {
    const spawn = vi.fn();
    const kill = vi.fn();
    expect(killTree(4242, 'SIGKILL', 'darwin', { spawn: spawn as never, kill })).toBe(true);
    expect(kill).toHaveBeenCalledWith(-4242, 'SIGKILL');
    expect(spawn).not.toHaveBeenCalled();
  });

  it('is false when the group is already gone', () => {
    const kill = vi.fn(() => {
      throw new Error('ESRCH');
    });
    expect(killTree(4242, 'SIGTERM', 'linux', { spawn: vi.fn() as never, kill })).toBe(false);
  });
});

describe('runShell', () => {
  it('runs a command line through the shell of the platform', async () => {
    const result = await runShell('echo "$((1 + 2))"; exit 4', {});
    expect(result).toMatchObject({ code: 4, stdout: '3\n' });
  });

  it('on Windows without Git for Windows: exit 127 (a missing tool) and the reason, nothing started', async () => {
    const result = await runShell('npm test', {}, 'win32', {}, () => false);
    expect(result.code).toBe(127);
    expect(result.error).toMatch(/Git for Windows/);
    expect(result.stderr).toMatch(/Git for Windows/);
  });
});
