import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../env-utils', () => ({ getAugmentedEnv: () => ({ ...process.env }) }));

import { installDependencies, needsInstall, packageManagerOf, storybookUrlFromOutput } from '../storybook-service';

const dir = () => mkdtempSync(path.join(tmpdir(), 'vtl-sb-'));

describe('storybook service', () => {
  it('picks the package manager from the lockfile', () => {
    const d = dir();
    expect(packageManagerOf(d)).toBe('npm');
    writeFileSync(path.join(d, 'pnpm-lock.yaml'), '');
    expect(packageManagerOf(d)).toBe('pnpm');
  });

  it('needs an install when neither the Storybook folder nor the root has node_modules', () => {
    const d = dir();
    mkdirSync(path.join(d, 'apps', 'web'), { recursive: true });
    expect(needsInstall(d, 'apps/web')).toBe(true);
    mkdirSync(path.join(d, 'node_modules'));
    expect(needsInstall(d, 'apps/web')).toBe(false);
  });

  it('reads the local URL Storybook prints', () => {
    expect(storybookUrlFromOutput('│   Local:            http://localhost:6007/   │')).toBe('http://localhost:6007');
    expect(storybookUrlFromOutput('starting…')).toBeNull();
  });

  it('runs one install per folder and reports a failure with its output', async () => {
    const d = dir();
    writeFileSync(path.join(d, 'package.json'), JSON.stringify({ name: 'x', version: '1.0.0', dependencies: { 'definitely-not-a-real-package-vtl-xyz': '0.0.0' } }));
    const lines: string[] = [];
    const first = installDependencies(d, (l) => lines.push(l));
    expect(installDependencies(d)).toBe(first);
    await expect(first).rejects.toThrow(/npm install failed/);
    expect(lines[0]).toBe('npm install');
  }, 120_000);
});
