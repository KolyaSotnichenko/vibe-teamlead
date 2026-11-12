import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { ReadinessResult } from '../../../shared/types/deploy';
import { blockerKey, readReadiness, writeReadiness } from '../readiness-store';

const result: ReadinessResult = {
  scannedAt: '2026-11-12T10:00:00.000Z',
  commit: 'abc1234',
  blockers: [{ key: 'code:localhost', kind: 'code', subject: 'localhost', title: 'Hardcoded localhost', detail: 'api.ts uses it' }],
  services: [{ kind: 'postgres', name: 'db', managed: true }],
  owner: [{ kind: 'variable', variable: 'API_KEY', message: 'Set API_KEY' }],
  workflow: { path: '.github/workflows/ci.yml', lastMainRun: { conclusion: 'success', runId: 7 } },
};

let dir: string;
const file = () => path.join(dir, '.vibe-teamlead', 'deploy', 'readiness.json');

beforeEach(() => { dir = mkdtempSync(path.join(tmpdir(), 'readiness-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe('readiness store', () => {
  it('reads back what was written', () => {
    writeReadiness(dir, result);
    expect(readReadiness(dir)).toEqual(result);
  });

  it('reads null when the file is missing', () => {
    expect(readReadiness(dir)).toBeNull();
  });

  it('reads null when the file is malformed', () => {
    mkdirSync(path.dirname(file()), { recursive: true });
    writeFileSync(file(), '{not json');
    expect(readReadiness(dir)).toBeNull();
    writeFileSync(file(), JSON.stringify({ scannedAt: 1 }));
    expect(readReadiness(dir)).toBeNull();
  });

  it('reads null when the file is a symlink', () => {
    const target = path.join(dir, 'real.json');
    writeFileSync(target, JSON.stringify(result));
    mkdirSync(path.dirname(file()), { recursive: true });
    symlinkSync(target, file());
    expect(readReadiness(dir)).toBeNull();
  });
});

describe('blockerKey', () => {
  it('is the same for the same subject written differently', () => {
    expect(blockerKey('code', 'Hardcoded localhost in API client')).toBe(blockerKey('code', 'hardcoded  LOCALHOST in api-client'));
  });

  it('is kind plus subject, lowercased, with runs of other characters as one dash', () => {
    expect(blockerKey('workflow', 'No  CI!')).toBe('workflow-no-ci-');
  });

  it('never exceeds 80 characters', () => {
    expect(blockerKey('unsupported', 'x'.repeat(500)).length).toBeLessThanOrEqual(80);
  });
});
