/**
 * Whether a QA session needs browser tools. The Playwright / Chrome DevTools
 * servers put twenty-odd tool schemas in every turn and start a browser, and
 * the reviewer's own rule (Phase 4.0) is that visual verification applies only
 * when the task changed UI files. So the servers start only then; when the
 * changed files can't be listed, they stay on as before.
 */

import { runProcess } from '../../platform/exec';
import { isUiFile } from '../design/design-lint';
import { isAppDataPath, resolveBaseRef } from '../security/gates';

/** Does any changed file need a browser to verify? Pure. */
export const taskTouchesUi = (changedFiles: string[]): boolean => changedFiles.some(isUiFile);

/** true / false from the changed files; undefined when they can't be listed. */
export async function uiChangedSince(listChanged: () => Promise<string[] | undefined>): Promise<boolean | undefined> {
  const files = await listChanged();
  return files === undefined ? undefined : taskTouchesUi(files);
}

/** Files changed since the task's base: committed, uncommitted and untracked; undefined when git can't say. */
export async function changedFilesSinceBase(projectDir: string): Promise<string[] | undefined> {
  const base = await resolveBaseRef(projectDir);
  if (!base) return undefined;
  const git = (args: string[]) => runProcess('git', args, { cwd: projectDir, timeoutMs: 60_000 });
  const [diff, untracked] = await Promise.all([
    git(['diff', '--name-only', '--diff-filter=ACMR', base]),
    git(['ls-files', '--others', '--exclude-standard']),
  ]);
  if (diff.code !== 0 || untracked.code !== 0) return undefined;
  return `${diff.stdout}\n${untracked.stdout}`
    .split('\n')
    .map((f) => f.trim())
    .filter((f) => f && !isAppDataPath(f));
}
