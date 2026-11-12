/**
 * The GitHub Actions secrets a project's workflows read (`${{ secrets.NAME }}` in
 * `.github/workflows/*.yml|*.yaml`): the only names the readiness check may ask the owner for.
 * Names only; the files are read as text, small ones only, and never throw.
 */
import { lstat, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

/** Workflow files read, at most */
export const MAX_WORKFLOW_FILES = 50;
/** A larger file is skipped */
export const MAX_WORKFLOW_BYTES = 256 * 1024;

const SECRET_REF = /\bsecrets\.([A-Za-z_][A-Za-z0-9_]*)/g;

/** The secret names a workflow's text reads: upper case (GitHub stores them so), once, without GitHub's own (`GITHUB_*`). Pure. */
export function secretsInWorkflow(text: string): string[] {
  const names = new Set<string>();
  for (const match of text.matchAll(SECRET_REF)) {
    const name = match[1].toUpperCase();
    if (!name.startsWith('GITHUB_')) names.add(name);
  }
  return [...names];
}

/** The secret names the project's workflows read; none when there are no workflows or on any failure. */
export async function workflowSecretNames(projectPath: string): Promise<string[]> {
  const folder = path.join(projectPath, '.github', 'workflows');
  let entries: string[];
  try {
    entries = (await readdir(folder)).filter((name) => /\.ya?ml$/i.test(name)).sort().slice(0, MAX_WORKFLOW_FILES);
  } catch {
    return [];
  }
  const names = new Set<string>();
  for (const entry of entries) {
    try {
      const file = path.join(folder, entry);
      // Regular files only (a symlink could point anywhere), and small ones
      const info = await lstat(file);
      if (!info.isFile() || info.size > MAX_WORKFLOW_BYTES) continue;
      for (const name of secretsInWorkflow(await readFile(file, 'utf-8'))) names.add(name);
    } catch {
      // an unreadable file reads nothing
    }
  }
  return [...names];
}
