/**
 * Git reads GIT_DIR, GIT_WORK_TREE and GIT_INDEX_FILE from the environment
 * before it looks at the working directory: inherited from a hook or a
 * terminal they point a command run in a worktree at another repository.
 * Worker-side code can't use utils/git-isolation (it loads Electron), so
 * this is the Electron-free version. Pure.
 */

export const GIT_LOCATION_VARS = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE'] as const;

export function withoutGitLocation(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const clean: NodeJS.ProcessEnv = { ...env };
  for (const name of GIT_LOCATION_VARS) delete clean[name];
  return clean;
}
