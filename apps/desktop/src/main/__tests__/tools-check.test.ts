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

import { checkTools, isBundledScanner } from '../tools-check';

describe('checkTools', () => {
  const originalPath = process.env.PATH;
  afterEach(() => {
    process.env.PATH = originalPath;
  });

  it('reports bundled, installed, stopped and missing tools with install hints', async () => {
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

  it('has no Git for Windows row on macOS', async () => {
    process.env.PATH = `${bin}:/usr/bin:/bin`;
    expect((await checkTools('darwin')).some((t) => t.id === 'git-bash')).toBe(false);
  });

  it('on Windows, Git for Windows is a required row with its winget command', async () => {
    process.env.PATH = `${bin}:/usr/bin:/bin`;
    const before = process.env.CLAUDE_CODE_GIT_BASH_PATH;
    try {
      delete process.env.CLAUDE_CODE_GIT_BASH_PATH;
      const missing = (await checkTools('win32')).find((t) => t.id === 'git-bash');
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
