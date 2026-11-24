/**
 * The task app's real dependencies: Docker on this computer, the worktree's files (listed through
 * git, hardened: agents can write the worktree's git config), commands through the shell with the
 * app's checks' environment (the project's own values from Settings, never the host's secrets), and
 * the dev-server manager. No Electron imports.
 */

import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

import { runProcess, runShell } from '../../platform/exec';
import { withoutGitLocation } from '../../platform/git-env';
import { needsInstall, packageManagerOf } from '../../platform/package-manager';
import { readOnlyGitArgs } from '../orchestration/reviewer-changes';
import { hostDocker } from '../verification/test-services';
import { startsDeps, verificationEnv } from '../verification/verify-task';
import type { PreviewService } from '../../../shared/types/project';
import { createTaskApp } from './task-app';

const COMMAND_TIMEOUT_MS = 10 * 60_000;
const OUTPUT = 4000;

/** The app of the task in `worktree`, started on demand and stopped with `stop`. */
export function hostTaskApp(options: { worktree: string; specDir: string; projectEnv?: Record<string, string>; saved?: PreviewService[]; signal?: AbortSignal }) {
  const { worktree } = options;
  const projectEnv = options.projectEnv ?? {};
  const label = `qa-app-${createHash('sha256').update(worktree).digest('hex').slice(0, 12)}`;
  return createTaskApp(
    { worktree, specDir: options.specDir, label, saved: options.saved, projectEnv },
    {
      // No abort signal for Docker: a stopped task's teardown runs Docker too. A stop ends a start between its steps.
      docker: hostDocker(process.env),
      listFiles: async () => {
        const listed = await runProcess('git', readOnlyGitArgs(['ls-files', '-z', '--cached', '--others', '--exclude-standard']), {
          cwd: worktree,
          env: { ...withoutGitLocation(), GIT_NO_LAZY_FETCH: '1', GIT_ALLOW_PROTOCOL: '' },
          timeoutMs: 30_000,
        });
        return listed.code === 0 ? listed.stdout.split('\0').filter(Boolean) : [];
      },
      installCommand: () => (needsInstall(worktree, '') ? `${packageManagerOf(worktree)} install` : null),
      read: (path) => {
        try {
          return readFileSync(join(worktree, path), 'utf-8');
        } catch {
          return null;
        }
      },
      runCommand: async (command, cwd, env) => {
        let output = '';
        const result = await runShell(command, {
          cwd,
          env: verificationEnv(process.env, env),
          signal: options.signal,
          timeoutMs: COMMAND_TIMEOUT_MS,
          killGroup: true,
          maxOutput: 1024,
          onLine: (line) => {
            output = `${output}${line}\n`;
            // Whole lines only: a cut through a value would leave a part the masking can't find
            if (output.length > OUTPUT * 2) output = output.slice(output.indexOf('\n', output.length - OUTPUT) + 1);
          },
        });
        return { code: result.timedOut ? 124 : result.code, output };
      },
      servers: startsDeps(process.env, projectEnv),
    },
  );
}
