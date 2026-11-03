import { describe, expect, it } from 'vitest';

import { findOnPath, runProcess } from '../exec';

describe('runProcess', () => {
  it('returns output and exit code without throwing', async () => {
    const ok = await runProcess('sh', ['-c', 'echo hi; echo err >&2; exit 3']);
    expect(ok).toMatchObject({ code: 3, stdout: 'hi\n', stderr: 'err\n', timedOut: false, aborted: false });
    const missing = await runProcess('/nonexistent/tool', []);
    expect(missing.code).toBe(-1);
    expect(missing.error).toBeTruthy();
  });

  it('kills on timeout and on abort, and never starts when already aborted', async () => {
    expect((await runProcess('sleep', ['5'], { timeoutMs: 100 })).timedOut).toBe(true);
    const controller = new AbortController();
    const running = runProcess('sleep', ['5'], { signal: controller.signal });
    setTimeout(() => controller.abort(), 50);
    expect((await running).aborted).toBe(true);
    const pre = new AbortController();
    pre.abort();
    expect(await runProcess('sh', ['-c', 'exit 0'], { signal: pre.signal })).toMatchObject({ aborted: true, code: -1 });
  });

  it('streams whole lines and caps captured output', async () => {
    const lines: string[] = [];
    const result = await runProcess('sh', ['-c', 'printf "a\\nb"; printf "%0500d" 0'], { onLine: (l) => lines.push(l), maxOutput: 10 });
    expect(lines[0]).toBe('a');
    expect(result.stdout.length).toBe(10);
  });

  it('finds executables on PATH', () => {
    expect(findOnPath('sh')).toMatch(/\/sh$/);
    expect(findOnPath('definitely-not-a-tool-xyz')).toBeUndefined();
  });
});

describe('searchPath', () => {
  it('includes the places Docker Desktop and OrbStack put the docker CLI', async () => {
    const { searchPath: search } = await import('../exec');
    const { homedir } = await import('node:os');
    const dirs = search().split(':');
    expect(dirs).toContain(`${homedir()}/.docker/bin`);
    expect(dirs).toContain('/Applications/Docker.app/Contents/Resources/bin');
    expect(dirs).toContain(`${homedir()}/.orbstack/bin`);
  });
});
