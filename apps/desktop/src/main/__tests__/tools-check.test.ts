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

import { checkTools } from '../tools-check';

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
    expect(tools.docker.status).toBe('not_running');
    expect(tools.strix).toMatchObject({ status: 'missing', installCommand: 'uv tool install strix-agent', optional: true });
  });
});
