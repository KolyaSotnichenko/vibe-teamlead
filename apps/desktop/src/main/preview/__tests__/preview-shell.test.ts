import { describe, expect, it, vi } from 'vitest';

// A preview's commands (migrations, seeds) run through the platform shell: Git Bash on Windows
const runShell = vi.hoisted(() => vi.fn(async () => ({ code: 0, stdout: 'ok\n', stderr: '', timedOut: false, aborted: false })));
vi.mock('../../platform/exec', async (original) => ({ ...(await original<typeof import('../../platform/exec')>()), runShell }));

import { defaultPreviewDeps } from '../preview-session';

describe('preview commands', () => {
  it('run through runShell, as one group, with the preview environment', async () => {
    const result = await defaultPreviewDeps().runCommand('npx prisma migrate deploy', '/tmp/p', { DATABASE_URL: 'x' }, undefined as never);
    expect(result).toEqual({ code: 0, output: 'ok\n' });
    expect(runShell).toHaveBeenCalledWith('npx prisma migrate deploy', expect.objectContaining({ cwd: '/tmp/p', killGroup: true, env: expect.objectContaining({ DATABASE_URL: 'x' }) }));
  });
});
