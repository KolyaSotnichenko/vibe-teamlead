import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { migrateDataPathSetting, migrateGitignoreText, migrateGlobalData, migrateProjectData } from '../data-dir-migration';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });
}

/** A project as Auto Claude left it: data folder, a task worktree on an auto-claude/ branch. */
function legacyProject(): { dir: string; spec: string } {
  const dir = mkdtempSync(path.join(tmpdir(), 'vtl-migrate-'));
  const spec = '001-scaffold';
  git(dir, 'init', '-q', '-b', 'main');
  writeFileSync(path.join(dir, '.gitignore'), 'node_modules/\n.auto-claude/\n.auto-claude-security.json\n');
  writeFileSync(path.join(dir, 'README.md'), '# app\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'init');
  mkdirSync(path.join(dir, '.auto-claude', 'specs', spec), { recursive: true });
  writeFileSync(path.join(dir, '.auto-claude', 'specs', spec, 'spec.md'), '# Spec');
  writeFileSync(path.join(dir, '.auto-claude-security.json'), '{}');
  const worktree = path.join(dir, '.auto-claude', 'worktrees', 'tasks', spec);
  git(dir, 'worktree', 'add', '-q', '-b', `auto-claude/${spec}`, worktree);
  mkdirSync(path.join(worktree, '.auto-claude', 'specs', spec), { recursive: true });
  writeFileSync(path.join(worktree, '.auto-claude', 'specs', spec, 'qa_report.md'), 'PASSED');
  return { dir, spec };
}

describe('migrateProjectData', () => {
  it('moves the data folder, re-links the worktree and renames the task branch', () => {
    const { dir, spec } = legacyProject();
    const result = migrateProjectData(dir);

    expect(result.problems).toEqual([]);
    expect(result.migrated).toBe(true);
    expect(existsSync(path.join(dir, '.auto-claude'))).toBe(false);
    expect(readFileSync(path.join(dir, '.vibe-teamlead', 'specs', spec, 'spec.md'), 'utf-8')).toBe('# Spec');
    expect(existsSync(path.join(dir, '.vibe-teamlead-security.json'))).toBe(true);
    expect(readFileSync(path.join(dir, '.gitignore'), 'utf-8')).toBe('node_modules/\n.vibe-teamlead/\n.vibe-teamlead-security.json\n');

    // git knows the worktree at its new place, on the renamed branch
    const worktree = path.join(dir, '.vibe-teamlead', 'worktrees', 'tasks', spec);
    expect(git(dir, 'worktree', 'list', '--porcelain')).toContain(`worktree ${worktree}`);
    expect(git(worktree, 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe(`vibe-teamlead/${spec}`);
    expect(git(worktree, 'status', '--porcelain')).toBeDefined(); // the worktree works
    expect(readFileSync(path.join(worktree, '.vibe-teamlead', 'specs', spec, 'qa_report.md'), 'utf-8')).toBe('PASSED');
  });

  it('does nothing the second time, and nothing for a new project', () => {
    const { dir } = legacyProject();
    migrateProjectData(dir);
    expect(migrateProjectData(dir)).toEqual({ migrated: false, steps: [], problems: [] });
    const fresh = mkdtempSync(path.join(tmpdir(), 'vtl-fresh-'));
    expect(migrateProjectData(fresh)).toEqual({ migrated: false, steps: [], problems: [] });
  });

  it('keeps both folders when both exist, and says so', () => {
    const { dir } = legacyProject();
    mkdirSync(path.join(dir, '.vibe-teamlead'));
    const result = migrateProjectData(dir);
    expect(result.migrated).toBe(false);
    expect(existsSync(path.join(dir, '.auto-claude'))).toBe(true);
    expect(result.problems[0]).toMatch(/both/);
  });
});

describe('helpers', () => {
  it('rewrites only .auto-claude entries in .gitignore', () => {
    expect(migrateGitignoreText('.auto-claude/\n.auto-claude\n.auto-claude-status\nauto-claude-docs/\n')).toBe(
      '.vibe-teamlead/\n.vibe-teamlead\n.vibe-teamlead-status\nauto-claude-docs/\n',
    );
  });

  it('maps the stored project data path', () => {
    expect(migrateDataPathSetting('.auto-claude')).toBe('.vibe-teamlead');
    expect(migrateDataPathSetting('')).toBe('');
    expect(migrateDataPathSetting('.vibe-teamlead')).toBe('.vibe-teamlead');
  });

  it('moves ~/.auto-claude/memories', () => {
    const home = mkdtempSync(path.join(tmpdir(), 'vtl-home-'));
    mkdirSync(path.join(home, '.auto-claude', 'memories'), { recursive: true });
    writeFileSync(path.join(home, '.auto-claude', 'memories', 'graph.db'), 'x');
    expect(migrateGlobalData(home).migrated).toBe(true);
    expect(readFileSync(path.join(home, '.vibe-teamlead', 'memories', 'graph.db'), 'utf-8')).toBe('x');
  });
});
