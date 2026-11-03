/**
 * One-time move of the app's data from Auto Claude names to Vibe Teamlead names.
 *
 * Per project:
 * - `<project>/.auto-claude/` → `<project>/.vibe-teamlead/` (specs, worktrees,
 *   roadmap, ideation, insights, memory files). Task worktrees live inside it,
 *   so after the move `git worktree repair` re-links them, and each worktree's
 *   own copy of the data folder is renamed too.
 * - Task branches `auto-claude/<spec>` → `vibe-teamlead/<spec>` (local only;
 *   branches already pushed keep their remote name).
 * - `.gitignore` entries and the root files `.auto-claude-security.json`,
 *   `.auto-claude-status`.
 *
 * Global: `~/.auto-claude/memories` → `~/.vibe-teamlead/memories`.
 *
 * Idempotent and best-effort: anything that cannot be moved is left in place
 * and reported; nothing is deleted.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

import { LEGACY_TASK_BRANCH_PREFIX, TASK_BRANCH_PREFIX } from '../shared/constants/config';

export const DATA_DIR = '.vibe-teamlead';
export const LEGACY_DATA_DIR = '.auto-claude';
const BRANCH_PREFIX = TASK_BRANCH_PREFIX;
const LEGACY_BRANCH_PREFIX = LEGACY_TASK_BRANCH_PREFIX;

const ROOT_FILES: Array<[string, string]> = [
  ['.auto-claude-security.json', '.vibe-teamlead-security.json'],
  ['.auto-claude-status', '.vibe-teamlead-status'],
];

export interface ProjectMigrationResult {
  migrated: boolean;
  /** What was done, for the log */
  steps: string[];
  /** What could not be done (left in place) */
  problems: string[];
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000 });
}

function isGitRepo(dir: string): boolean {
  try {
    return git(dir, ['rev-parse', '--is-inside-work-tree']).trim() === 'true';
  } catch {
    return false;
  }
}

/** Rewrite `.auto-claude` entries of a .gitignore to `.vibe-teamlead`. Pure — tested directly. */
export function migrateGitignoreText(text: string): string {
  return text
    .split('\n')
    .map((line) => line.replace(/\.auto-claude(?=[/\s*-]|$)/g, DATA_DIR))
    .join('\n');
}

function migrateGitignore(dir: string, result: ProjectMigrationResult): void {
  const file = path.join(dir, '.gitignore');
  if (!existsSync(file)) return;
  const before = readFileSync(file, 'utf-8');
  const after = migrateGitignoreText(before);
  if (after !== before) {
    writeFileSync(file, after, 'utf-8');
    result.steps.push(`updated ${path.relative(dir, file) || '.gitignore'}`);
  }
}

function renameIfPossible(from: string, to: string, result: ProjectMigrationResult, label: string): boolean {
  if (!existsSync(from)) return false;
  if (existsSync(to)) {
    result.problems.push(`${label}: both ${path.basename(from)} and ${path.basename(to)} exist; kept both`);
    return false;
  }
  try {
    renameSync(from, to);
    result.steps.push(`${label}: ${path.basename(from)} → ${path.basename(to)}`);
    return true;
  } catch (error) {
    result.problems.push(`${label}: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}

/** Worktree directories under the data folder (worktrees/tasks/*, worktrees/terminal/*, …). */
function worktreeDirs(dataDir: string): string[] {
  const root = path.join(dataDir, 'worktrees');
  if (!existsSync(root)) return [];
  const dirs: string[] = [];
  for (const group of readdirSync(root)) {
    const groupDir = path.join(root, group);
    if (!statSync(groupDir).isDirectory()) continue;
    for (const name of readdirSync(groupDir)) {
      const dir = path.join(groupDir, name);
      if (existsSync(path.join(dir, '.git'))) dirs.push(dir);
    }
  }
  return dirs;
}

function renameTaskBranches(projectPath: string, result: ProjectMigrationResult): void {
  let branches: string[];
  try {
    branches = git(projectPath, ['for-each-ref', '--format=%(refname:short)', `refs/heads/${LEGACY_BRANCH_PREFIX}`])
      .split('\n')
      .map((b) => b.trim())
      .filter(Boolean);
  } catch {
    return;
  }
  for (const branch of branches) {
    const renamed = BRANCH_PREFIX + branch.slice(LEGACY_BRANCH_PREFIX.length);
    try {
      git(projectPath, ['branch', '-m', branch, renamed]);
      result.steps.push(`branch ${branch} → ${renamed}`);
    } catch (error) {
      result.problems.push(`branch ${branch}: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`);
    }
  }
}

/** Move one project's data to the Vibe Teamlead names. Safe to call on every load. */
export function migrateProjectData(projectPath: string): ProjectMigrationResult {
  const result: ProjectMigrationResult = { migrated: false, steps: [], problems: [] };
  const legacy = path.join(projectPath, LEGACY_DATA_DIR);
  const current = path.join(projectPath, DATA_DIR);

  for (const [from, to] of ROOT_FILES) renameIfPossible(path.join(projectPath, from), path.join(projectPath, to), result, 'project');

  if (existsSync(legacy) && renameIfPossible(legacy, current, result, 'project')) {
    result.migrated = true;
    const repo = isGitRepo(projectPath);
    const worktrees = worktreeDirs(current);
    if (repo && worktrees.length) {
      // The worktrees moved with the folder: re-link them to the repository
      try {
        git(projectPath, ['worktree', 'repair', ...worktrees]);
        result.steps.push(`repaired ${worktrees.length} worktree(s)`);
      } catch (error) {
        result.problems.push(`git worktree repair: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`);
      }
    }
    for (const worktree of worktrees) {
      renameIfPossible(path.join(worktree, LEGACY_DATA_DIR), path.join(worktree, DATA_DIR), result, path.basename(worktree));
      for (const [from, to] of ROOT_FILES) renameIfPossible(path.join(worktree, from), path.join(worktree, to), result, path.basename(worktree));
      migrateGitignore(worktree, result);
    }
    if (repo) renameTaskBranches(projectPath, result);
  }

  migrateGitignore(projectPath, result);
  return result;
}

/** `~/.auto-claude/memories` → `~/.vibe-teamlead/memories` (the memory database). */
export function migrateGlobalData(home = homedir()): ProjectMigrationResult {
  const result: ProjectMigrationResult = { migrated: false, steps: [], problems: [] };
  const legacy = path.join(home, LEGACY_DATA_DIR, 'memories');
  const current = path.join(home, DATA_DIR, 'memories');
  if (existsSync(legacy) && !existsSync(current)) {
    mkdirSync(path.dirname(current), { recursive: true });
    result.migrated = renameIfPossible(legacy, current, result, 'memories');
  }
  return result;
}

/** A stored project data path ('.auto-claude') in the new name. */
export function migrateDataPathSetting(value: string | undefined): string | undefined {
  if (!value) return value;
  return value === LEGACY_DATA_DIR || value === 'auto-claude' ? DATA_DIR : value.replace(/(^|\/)\.auto-claude(\/|$)/, `$1${DATA_DIR}$2`);
}
