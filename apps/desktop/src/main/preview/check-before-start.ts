/**
 * Before a start of the project's preview: when what decides how the project starts changed
 * since the last check (start-inputs.ts), or it was never checked, the agent checks the project
 * and tries its recipe (start-fixer.ts `check`). The status the agent's last try ended in is the
 * start; null: no check was needed or could run, and the start goes on as before. A check that
 * ran is remembered whatever it found, so the same files are not paid for twice; a failure
 * afterwards goes to the agent that fixes starts as any other. No Electron imports.
 */

import { createHash } from 'node:crypto';

import type { PreviewStatus } from '../../shared/types/preview';
import type { FailedStart } from './start-fixer';
import { changedInputs, startInputs } from './start-inputs';

export interface CheckBeforeStartDeps {
  /** Moves the preview's copy to the project's main branch: the agent reads what will start */
  sync: () => Promise<void>;
  /** The copy's tracked files, with `/` */
  files: () => string[];
  /** A file of the copy; never `.env` */
  read: (path: string) => string | null;
  /** What was fingerprinted at the last check (the project's settings) */
  checked: Record<string, string> | undefined;
  /** The recipe a start would use now */
  describe: () => Promise<FailedStart | null>;
  check: (info: FailedStart, check: { changed: string[]; first: boolean }) => Promise<PreviewStatus | null>;
  remember: (inputs: Record<string, string>) => void;
}

export async function checkBeforeStart(deps: CheckBeforeStartDeps): Promise<PreviewStatus | null> {
  try {
    await deps.sync();
  } catch {
    // The start moves it again and says what went wrong
    return null;
  }
  const inputs = startInputs({ files: deps.files(), read: deps.read });
  const changed = changedInputs(deps.checked, inputs);
  if (!changed.length) return null;
  const info = await deps.describe().catch(() => null);
  if (!info) return null;
  const key = `check:${createHash('sha256').update(JSON.stringify(inputs)).digest('hex').slice(0, 16)}`;
  const status = await deps.check({ ...info, key }, { changed: deps.checked ? changed : [], first: !deps.checked });
  if (!status) return null;
  deps.remember(inputs);
  return status;
}

type Sync = (projectPath: string, mainBranch: string, git: string, worktree: string) => Promise<{ path: string; lockfileChanged: boolean; moved: boolean }>;

/**
 * A check moves the copy to main before the start does, and the start would then not see that a
 * lockfile changed: the change is carried to the next start of that copy, which installs.
 */
export function carryLockfile(sync: Sync): { forCheck: Sync; forStart: Sync } {
  const changed = new Set<string>();
  return {
    forCheck: async (...args) => {
      const result = await sync(...args);
      if (result.lockfileChanged) changed.add(args[3]);
      return result;
    },
    forStart: async (...args) => {
      const result = await sync(...args);
      const carried = changed.delete(args[3]);
      return carried ? { ...result, lockfileChanged: true } : result;
    },
  };
}
