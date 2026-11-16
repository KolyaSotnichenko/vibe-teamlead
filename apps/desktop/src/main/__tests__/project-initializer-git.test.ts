import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

vi.mock('../cli-tool-manager', () => ({ getToolPath: () => 'git' }));

import { initializeProject } from '../project-initializer';

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf-8' }).trim();

describe('initializeProject', () => {
  it('sets up git with a first commit in a new folder and keeps .vibe-teamlead out of it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vtl-init-'));
    writeFileSync(join(dir, 'README.md'), '# app\n');
    expect(initializeProject(dir)).toEqual({ success: true });
    expect(existsSync(join(dir, '.vibe-teamlead', 'specs'))).toBe(true);
    expect(git(dir, 'rev-list', '--count', 'HEAD')).toBe('1');
    expect(git(dir, 'ls-files')).not.toContain('.vibe-teamlead');
    // Ignored through the repository's own exclude file, not a .gitignore of the project
    expect(readFileSync(join(dir, '.git', 'info', 'exclude'), 'utf-8')).toContain('.vibe-teamlead/');
    expect(existsSync(join(dir, '.gitignore'))).toBe(false);
    expect(git(dir, 'status', '--porcelain')).toBe('');
  });

  // A first task's own .gitignore must not meet an uncommitted one in the project when it merges
  it('adds nothing to an existing repository: no .gitignore, no change to commit', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vtl-init-'));
    git(dir, 'init', '-q');
    writeFileSync(join(dir, 'README.md'), '# app\n');
    git(dir, 'add', '.');
    git(dir, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'init');
    expect(initializeProject(dir)).toEqual({ success: true });
    expect(existsSync(join(dir, '.gitignore'))).toBe(false);
    expect(git(dir, 'status', '--porcelain')).toBe('');
    expect(readFileSync(join(dir, '.git', 'info', 'exclude'), 'utf-8')).toContain('.vibe-teamlead/');
  });

  it("leaves a project's own .gitignore as it is", () => {
    const dir = mkdtempSync(join(tmpdir(), 'vtl-init-'));
    writeFileSync(join(dir, '.gitignore'), 'node_modules/\n');
    expect(initializeProject(dir).success).toBe(true);
    expect(readFileSync(join(dir, '.gitignore'), 'utf-8')).toBe('node_modules/\n');
    expect(git(dir, 'ls-files')).not.toContain('.vibe-teamlead');
  });

  it('is idempotent: running it again succeeds', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vtl-init-'));
    expect(initializeProject(dir).success).toBe(true);
    expect(initializeProject(dir)).toEqual({ success: true });
  });
});
