import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { baseFailures, baseFixTask, openBaseFix, recordBaseFix } from '../base-fix';
import type { VerificationReport } from '../verify-task';

const report = (checks: VerificationReport['checks']): VerificationReport =>
  ({ status: 'not_verified', commit: 'c1', baseCommit: 'b0f1e2d3c4', checks, tamper: [], runnerConfigChanged: [] }) as VerificationReport;

const migrations = 'FAIL apps/api/test/database/migrations.e2e-spec.ts > down removes the latest migration\nAssertionError: expected "NO" to be "YES"';

describe('a check that fails on main too', () => {
  it('is picked out only when it fails on the task and on the commit it started from', () => {
    const failures = baseFailures(report([
      { name: 'test', command: 'pnpm run test', outcome: 'failed', onBase: 'failed', tail: 'task tail', tailOnBase: migrations },
      { name: 'typecheck', command: 'pnpm run typecheck', outcome: 'passed' },
      { name: 'lint', command: 'pnpm run lint', outcome: 'failed', onBase: 'passed', tail: 'the task broke it' },
      { name: 'e2e', command: 'pnpm run e2e', outcome: 'timed_out', onBase: 'timed_out' },
    ] as never));
    expect(failures).toEqual([{ command: 'pnpm run test', tail: migrations }]);
  });

  it('becomes a task that names the command, what failed, and asks to fix main, not to skip tests', () => {
    const task = baseFixTask([{ command: 'pnpm run test', tail: migrations }], 'b0f1e2d3c4', 'main');
    expect(task.title).toBe('Fix main: `pnpm run test` fails');
    expect(task.description).toContain('`pnpm run test`');
    expect(task.description).toContain('migrations.e2e-spec.ts');
    expect(task.description).toContain('b0f1e2d');
    expect(task.description).toMatch(/don't delete, skip or weaken/i);
  });

  it('starts one task per failing command: another task finding it while that one is open does nothing', () => {
    const project = mkdtempSync(path.join(tmpdir(), 'vtl-basefix-'));
    expect(openBaseFix(project, ['pnpm run test'], () => true)).toBeNull();
    recordBaseFix(project, ['pnpm run test'], '056-fix-main');
    expect(openBaseFix(project, ['pnpm run test'], (specId) => specId === '056-fix-main')).toBe('056-fix-main');
    // Once that task is done (or deleted), a main that fails again gets a new one
    expect(openBaseFix(project, ['pnpm run test'], () => false)).toBeNull();
    expect(openBaseFix(project, ['pnpm run lint'], () => true)).toBeNull();
  });
});
