import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

vi.mock('../cli-tool-manager', () => ({ getToolPath: () => 'git' }));

import { initializeProject } from '../project-initializer';

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf-8' }).trim();

describe('initializeProject', () => {
  it('sets up git with a first commit in a new folder and keeps .auto-claude out of it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vtl-init-'));
    writeFileSync(join(dir, 'README.md'), '# app\n');
    expect(initializeProject(dir)).toEqual({ success: true });
    expect(existsSync(join(dir, '.auto-claude', 'specs'))).toBe(true);
    expect(git(dir, 'rev-list', '--count', 'HEAD')).toBe('1');
    expect(git(dir, 'ls-files')).not.toContain('.auto-claude');
    expect(readFileSync(join(dir, '.gitignore'), 'utf-8')).toContain('.auto-claude/');
  });

  it('is idempotent: running it again succeeds', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vtl-init-'));
    expect(initializeProject(dir).success).toBe(true);
    expect(initializeProject(dir)).toEqual({ success: true });
  });
});
