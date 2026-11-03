import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { beforeEach, describe, expect, it } from 'vitest';

import { ensureCodegraphIndex, resetCodegraphIndexCache } from '../codegraph';

function fakeCodegraph(script: string): { bin: string; calls: string } {
  const dir = mkdtempSync(join(tmpdir(), 'vtl-cgbin-'));
  const calls = join(dir, 'calls');
  const bin = join(dir, 'codegraph');
  writeFileSync(bin, `#!/bin/sh\necho run >> "${calls}"\n${script}\n`);
  chmodSync(bin, 0o755);
  return { bin, calls };
}

const count = (file: string) => {
  try {
    return readFileSync(file, 'utf-8').trim().split('\n').length;
  } catch {
    return 0;
  }
};

describe('CodeGraph indexing', () => {
  beforeEach(() => resetCodegraphIndexCache());

  it('indexes once and shares the result between sessions', async () => {
    const { bin, calls } = fakeCodegraph('mkdir -p "$3/.codegraph"; exit 0');
    const project = mkdtempSync(join(tmpdir(), 'vtl-cgp-'));
    const [a, b] = await Promise.all([
      ensureCodegraphIndex(bin, project, { wait: true }),
      ensureCodegraphIndex(bin, project, { wait: true }),
    ]);
    expect([a, b]).toEqual([true, true]);
    expect(count(calls)).toBe(1);
  });

  it('remembers a failure instead of retrying every session', async () => {
    const { bin, calls } = fakeCodegraph('exit 3');
    const project = mkdtempSync(join(tmpdir(), 'vtl-cgp-'));
    expect(await ensureCodegraphIndex(bin, project, { wait: true })).toBe(false);
    expect(await ensureCodegraphIndex(bin, project, { wait: true })).toBe(false);
    expect(count(calls)).toBe(1);
  });

  it('does not block main-process tasks and stops waiting on abort', async () => {
    const { bin } = fakeCodegraph('sleep 5; exit 0');
    const project = mkdtempSync(join(tmpdir(), 'vtl-cgp-'));
    const started = Date.now();
    expect(await ensureCodegraphIndex(bin, project, { wait: false })).toBe(false);
    const controller = new AbortController();
    const waiting = ensureCodegraphIndex(bin, project, { wait: true, signal: controller.signal });
    controller.abort();
    expect(await waiting).toBe(false);
    expect(Date.now() - started).toBeLessThan(2000);
  });
});
