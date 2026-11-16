import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

const bin = mkdtempSync(join(tmpdir(), 'vtl-tools-'));
function fake(name: string, script: string) {
  const path = join(bin, name);
  writeFileSync(path, `#!/bin/sh\n${script}\n`);
  chmodSync(path, 0o755);
  return path;
}
const gitleaks = fake('gitleaks', 'echo "v8.28.0"');

vi.mock('../ai/claude-code/bundled-tools', () => ({
  resolveBundledTools: () => ({ claudeCodeExecutable: '/app/claude', gitleaksBin: gitleaks }),
}));

// The real lookup adds folders of this machine: the developer's own Strix must not count
vi.mock('../ai/security/strix', async (original) => ({
  ...(await original<typeof import('../ai/security/strix')>()),
  strixPath: () => process.env.PATH ?? '',
}));

// The real lookup finds the Git for Windows a Windows machine has: a test can say it is missing
const gitBash = vi.hoisted(() => ({ missing: false }));
vi.mock('../platform/git-bash', async (original) => {
  const real = await original<typeof import('../platform/git-bash')>();
  return { ...real, findGitBash: (options: Parameters<typeof real.findGitBash>[0]) => (gitBash.missing ? null : real.findGitBash(options)) };
});

import { checkTools, findChrome, isBundledScanner } from '../tools-check';
import { isWindowsHost } from '../platform/__tests__/host';

describe('checkTools', () => {
  const originalPath = process.env.PATH;
  afterEach(() => {
    process.env.PATH = originalPath;
  });

  // The fake gitleaks is a sh script, which Windows can't spawn
  it.skipIf(isWindowsHost)('reports bundled, installed, stopped and missing tools with install hints', async () => {
    fake('docker', 'exit 1'); // installed but the daemon is not running
    process.env.PATH = `${bin}:/usr/bin:/bin`;
    const tools = Object.fromEntries((await checkTools()).map((t) => [t.id, t]));
    expect(tools['claude-code'].status).toBe('bundled');
    expect(tools.gitleaks).toMatchObject({ status: 'ready', version: 'v8.28.0', installCommand: 'brew install gitleaks' });
    expect(tools['osv-scanner'].status).toBe('missing');
    expect(tools.semgrep).toMatchObject({ status: 'missing', installCommand: 'brew install semgrep', neededFor: 'security_gates', optional: true });
    expect(tools.docker.status).toBe('not_running');
    expect(tools.strix).toMatchObject({ status: 'missing', installCommand: 'uv tool install strix-agent', optional: true });
  });

  it('gives Windows install commands, URLs and the Docker start command on Windows', async () => {
    process.env.PATH = `${bin}:/usr/bin:/bin`;
    const tools = Object.fromEntries((await checkTools('win32')).map((t) => [t.id, t]));
    expect(tools.gitleaks.installCommand).toBe('winget install --id Gitleaks.Gitleaks -e');
    expect(tools['osv-scanner'].installCommand).toBe('winget install --id Google.OSVScanner -e');
    expect(tools.semgrep.installCommand).toBe('pip install semgrep');
    expect(tools.chrome.installCommand).toBe('winget install --id Google.Chrome -e');
    expect(tools.docker).toMatchObject({
      installCommand: 'winget install --id Docker.DockerDesktop -e',
      installUrl: 'https://docs.docker.com/desktop/setup/install/windows-install/',
      startCommand: 'start "" "%ProgramFiles%\\Docker\\Docker\\Docker Desktop.exe"',
    });
  });

  it('gives Docker its macOS start command on macOS', async () => {
    process.env.PATH = `${bin}:/usr/bin:/bin`;
    const docker = (await checkTools('darwin')).find((t) => t.id === 'docker');
    expect(docker).toMatchObject({ installCommand: 'brew install --cask docker', startCommand: 'open -a Docker' });
  });

  it('has no Git for Windows row on macOS', async () => {
    process.env.PATH = `${bin}:/usr/bin:/bin`;
    expect((await checkTools('darwin')).some((t) => t.id === 'git-bash')).toBe(false);
  });

  it('on Windows, Git for Windows is a required row with its winget command', async () => {
    process.env.PATH = `${bin}:/usr/bin:/bin`;
    const before = process.env.CLAUDE_CODE_GIT_BASH_PATH;
    try {
      delete process.env.CLAUDE_CODE_GIT_BASH_PATH;
      gitBash.missing = true;
      const missing = (await checkTools('win32')).find((t) => t.id === 'git-bash');
      gitBash.missing = false;
      expect(missing).toMatchObject({
        status: 'missing',
        optional: false,
        neededFor: 'agents',
        installCommand: 'winget install --id Git.Git -e',
        installUrl: 'https://git-scm.com/download/win',
      });
      process.env.CLAUDE_CODE_GIT_BASH_PATH = gitleaks; // any file that exists
      expect((await checkTools('win32')).find((t) => t.id === 'git-bash')).toMatchObject({ status: 'ready', path: gitleaks });
    } finally {
      gitBash.missing = false;
      if (before === undefined) delete process.env.CLAUDE_CODE_GIT_BASH_PATH;
      else process.env.CLAUDE_CODE_GIT_BASH_PATH = before;
    }
  });
});

describe('isBundledScanner', () => {
  it('recognises the scanners folder with either separator', () => {
    expect(isBundledScanner('/Applications/Vibe Teamlead.app/Contents/Resources/scanners/gitleaks')).toBe(true);
    expect(isBundledScanner('C:\\Users\\me\\AppData\\Local\\Programs\\Vibe Teamlead\\resources\\scanners\\gitleaks.exe')).toBe(true);
    expect(isBundledScanner('/opt/homebrew/bin/gitleaks')).toBe(false);
    expect(isBundledScanner(undefined)).toBe(false);
  });
});

describe('findChrome on Windows', () => {
  const env = {
    ProgramFiles: 'C:\\Program Files',
    'ProgramFiles(x86)': 'C:\\Program Files (x86)',
    LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local',
  };
  const only = (path: string) => (p: string) => p === path;

  it('finds Chrome in Program Files, Program Files (x86) or the user’s LocalAppData', () => {
    for (const path of [
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Users\\me\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe',
    ]) {
      expect(findChrome('win32', env, only(path))).toBe(path);
    }
  });

  it('reports none when Chrome is not installed, and never looks for the macOS app', () => {
    const seen: string[] = [];
    expect(findChrome('win32', env, (p) => {
          seen.push(p);
          return false;
        })).toBeUndefined();
    expect(seen.some((p) => p.includes('.app'))).toBe(false);
  });
});
