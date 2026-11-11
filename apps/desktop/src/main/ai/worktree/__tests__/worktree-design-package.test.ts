import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createOrGetWorktree } from '../worktree-manager';

let project: string;

const write = (rel: string, text: string) => {
  const file = path.join(project, ...rel.split('/'));
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
};
const inWorktree = (wt: string, rel: string) => path.join(wt, ...rel.split('/'));

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  project = realpathSync(mkdtempSync(path.join(tmpdir(), 'wt-design-')));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: project, stdio: 'pipe' });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 't@example.com');
  git('config', 'user.name', 'T');
  writeFileSync(path.join(project, '.gitignore'), '.vibe-teamlead/\n');
  writeFileSync(path.join(project, 'README.md'), '# P\n');
  git('add', '.');
  git('commit', '-q', '-m', 'init');
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(project, { recursive: true, force: true });
});

describe('createOrGetWorktree and the design package', () => {
  it('copies the package, its meta and the app design system into a new worktree, and nothing else', async () => {
    write('.vibe-teamlead/design/package/mhp/components/bundle.css', '.mhp-button{}');
    write('.vibe-teamlead/design/package-meta.json', '{"name":"MHP"}');
    write('.vibe-teamlead/design-system.md', '# System\n');
    write('.vibe-teamlead/design-tokens.json', '{"colors":[]}');
    write('.vibe-teamlead/design/references/r1.png', 'png');
    write('.vibe-teamlead/design/system-meta.json', '{}');

    const { worktreePath } = await createOrGetWorktree(project, '001-task', 'main', true, false);

    expect(readFileSync(inWorktree(worktreePath, '.vibe-teamlead/design/package/mhp/components/bundle.css'), 'utf-8')).toBe('.mhp-button{}');
    expect(readFileSync(inWorktree(worktreePath, '.vibe-teamlead/design/package-meta.json'), 'utf-8')).toBe('{"name":"MHP"}');
    expect(readFileSync(inWorktree(worktreePath, '.vibe-teamlead/design-system.md'), 'utf-8')).toBe('# System\n');
    expect(readFileSync(inWorktree(worktreePath, '.vibe-teamlead/design-tokens.json'), 'utf-8')).toBe('{"colors":[]}');
    expect(existsSync(inWorktree(worktreePath, '.vibe-teamlead/design/references'))).toBe(false);
    expect(existsSync(inWorktree(worktreePath, '.vibe-teamlead/design/system-meta.json'))).toBe(false);
  });

  it('refreshes the package when the worktree is reused', async () => {
    write('.vibe-teamlead/design/package/old/README.md', 'old');
    write('.vibe-teamlead/design/package-meta.json', '{"name":"Old"}');
    const first = await createOrGetWorktree(project, '002-task', 'main', true, false);
    expect(existsSync(inWorktree(first.worktreePath, '.vibe-teamlead/design/package/old/README.md'))).toBe(true);

    rmSync(path.join(project, '.vibe-teamlead/design/package'), { recursive: true, force: true });
    write('.vibe-teamlead/design/package/new/README.md', 'new');
    write('.vibe-teamlead/design/package-meta.json', '{"name":"New"}');
    write('.vibe-teamlead/design-system.md', '# New system\n');

    const again = await createOrGetWorktree(project, '002-task', 'main', true, false);
    expect(again.worktreePath).toBe(first.worktreePath);
    expect(existsSync(inWorktree(again.worktreePath, '.vibe-teamlead/design/package/old'))).toBe(false);
    expect(readFileSync(inWorktree(again.worktreePath, '.vibe-teamlead/design/package/new/README.md'), 'utf-8')).toBe('new');
    expect(readFileSync(inWorktree(again.worktreePath, '.vibe-teamlead/design/package-meta.json'), 'utf-8')).toBe('{"name":"New"}');
    expect(readFileSync(inWorktree(again.worktreePath, '.vibe-teamlead/design-system.md'), 'utf-8')).toBe('# New system\n');
  });

  it('a project without a package gets no design files in the worktree', async () => {
    const { worktreePath } = await createOrGetWorktree(project, '003-task', 'main', true, false);
    expect(existsSync(inWorktree(worktreePath, '.vibe-teamlead/design'))).toBe(false);
    expect(existsSync(inWorktree(worktreePath, '.vibe-teamlead/design-system.md'))).toBe(false);
  });
});
