/**
 * What decides how a project starts, as short hashes by file: the package manifests
 * and lockfiles, the compose files, the example settings, `RUNNING.md`, and the migrations by
 * name. The agent checks the project before a start when any of them changed since it last did.
 * No file text is kept. Pure.
 */

import { createHash } from 'node:crypto';

import type { ProjectFiles } from '../ai/verification/detect-checks';

const SKIPPED = /(^|\/)(node_modules|\.git|\.vibe-teamlead|dist|build|vendor|\.venv)\//;

/** Files whose text decides the start */
// Not preview.json: the start itself proves a recipe, and the agent's own recipe goes into main
// as one, which would ask for a check of the check
const BY_TEXT = [
  /(^|\/)RUNNING\.md$/,
  /(^|\/)package\.json$/,
  /(^|\/)(pnpm-lock\.yaml|yarn\.lock|package-lock\.json|bun\.lockb?)$/,
  /(^|\/)(pyproject\.toml|requirements[^/]*\.txt|Pipfile(\.lock)?|uv\.lock|poetry\.lock|Gemfile(\.lock)?|go\.mod|composer\.json|Cargo\.toml)$/,
  /(^|\/)(docker-)?compose[^/]*\.ya?ml$/,
  /(^|\/)\.env\.example$/,
  /(^|\/)prisma\/schema\.prisma$/,
];

/** Migrations: a new one changes what a start needs, an edit to an old one does not */
const BY_NAME = /(^|\/)(migrations?|alembic\/versions|db\/migrate)\/.+$/;

/** At most this many files are fingerprinted: a monorepo's thousands of manifests say no more */
const MAX_FILES = 2000;

const hash = (text: string) => createHash('sha256').update(text).digest('hex').slice(0, 16);

export function startInputs({ files, read }: ProjectFiles): Record<string, string> {
  const inputs: Record<string, string> = {};
  for (const file of files.filter((f) => !SKIPPED.test(f)).sort()) {
    if (Object.keys(inputs).length >= MAX_FILES) break;
    if (BY_NAME.test(file)) inputs[file] = hash(file);
    else if (BY_TEXT.some((pattern) => pattern.test(file))) inputs[file] = hash((read(file) ?? '').replace(/\r\n/g, '\n'));
  }
  return inputs;
}

/** The files added, changed or removed since `before`, sorted; every file when nothing was checked before */
export function changedInputs(before: Record<string, string> | undefined, now: Record<string, string>): string[] {
  if (!before) return Object.keys(now).sort();
  const names = new Set([...Object.keys(before), ...Object.keys(now)]);
  return [...names].filter((name) => before[name] !== now[name]).sort();
}
