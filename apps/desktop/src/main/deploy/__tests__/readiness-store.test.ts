import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { ReadinessResult } from '../../../shared/types/deploy';
import { assignKnownKeys, blockerKey, readReadiness, sameBlocker, writeReadiness } from '../readiness-store';

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

describe('sameBlocker (threshold: half the words of subject and title together)', () => {
  const migrations = { key: 'code-api-migrations', kind: 'code' as const, subject: 'api migrations', title: 'Prisma migrations never run on deploy' };

  it('matches the same title under a new subject', () => {
    expect(sameBlocker({ kind: 'code', subject: 'database migrations', title: 'Prisma migrations never run on deploy' }, migrations)).toBe(true);
  });

  it('does not match two different problems that share a word', () => {
    expect(sameBlocker({ kind: 'code', subject: 'api base url', title: 'Web API base URL is hardcoded' }, migrations)).toBe(false);
    expect(sameBlocker({ kind: 'code', subject: 'api rate limit', title: 'Rate limiting stores counters in memory' }, migrations)).toBe(false);
  });

  it('uses the words of the key when a known blocker has no subject', () => {
    expect(sameBlocker({ kind: 'code', subject: 'api migrations', title: 'Something else entirely' }, { key: 'code-api-migrations', kind: 'code', title: 'Old' })).toBe(true);
  });

  it('keeps apart blockers whose subjects differ by the thing they name, even with alike titles', () => {
    const pairs: Array<[string, string, string, string]> = [
      ['ci playwright browser install', 'Browsers are not installed for Playwright', 'ci vitest browser install', 'Browsers are not installed for Vitest'],
      ['ci postgres service container', 'CI has no Postgres service container', 'ci redis service container', 'CI has no Redis service container'],
      ['api localhost url', 'The web app calls a localhost API', 'websocket localhost url', 'The web app opens a localhost websocket'],
    ];
    for (const [s1, t1, s2, t2] of pairs) {
      const kind = s1.startsWith('ci') ? ('workflow' as const) : ('code' as const);
      expect(sameBlocker({ kind, subject: s1, title: t1 }, { key: blockerKey(kind, s2), kind, subject: s2, title: t2 })).toBe(false);
    }
  });

  it('needs a shared word in the subjects beyond the kind word and "ci"', () => {
    expect(
      sameBlocker(
        { kind: 'workflow', subject: 'ci browsers', title: 'Workflow lacks a step on the runner' },
        { key: 'workflow-ci-database', kind: 'workflow', subject: 'ci database', title: 'Workflow lacks a step on the runner' },
      ),
    ).toBe(false);
  });
});

describe('assignKnownKeys', () => {
  const known = [
    { key: 'code-api-migrations', kind: 'code' as const, subject: 'api migrations', title: 'Prisma migrations never run on deploy' },
    { key: 'code-transactional-email', kind: 'code' as const, title: 'Only a console email provider exists' },
    { key: 'code-logo-upload-storage', kind: 'code' as const, subject: 'logo upload storage', title: 'Logo uploads write to local disk' },
  ];

  it('takes a sameAs that is a known key of the same kind; ignores one that is not', () => {
    expect(
      assignKnownKeys(
        [
          { kind: 'code', subject: 'email provider', title: 'No real email transport', sameAs: 'code-transactional-email' },
          { kind: 'code', subject: 'logo storage adapter', title: 'Uploads use the local filesystem', sameAs: 'code-logo-upload-storage' },
          { kind: 'workflow', subject: 'x', title: 'y', sameAs: 'code-api-migrations' },
          { kind: 'code', subject: 'z', title: 'w', sameAs: 'code-made-up' },
        ],
        known,
      ),
    ).toEqual(['code-transactional-email', 'code-logo-upload-storage', undefined, undefined]);
  });

  it('a subject equal to the key, or to the kind and the key, takes the key', () => {
    expect(
      assignKnownKeys(
        [
          { kind: 'code', subject: 'code-transactional-email', title: 'x' },
          { kind: 'code', subject: 'api migrations', title: 'y' },
        ],
        known,
      ),
    ).toEqual(['code-transactional-email', 'code-api-migrations']);
  });

  it('gives each known key to the best match whatever the order', () => {
    const close = { kind: 'code' as const, subject: 'database migrations', title: 'Prisma migrations never run on deploy' };
    const looser = { kind: 'code' as const, subject: 'migrations', title: 'Prisma migrations run on deploy too late' };
    expect(assignKnownKeys([looser, close], known)).toEqual([undefined, 'code-api-migrations']);
    expect(assignKnownKeys([close, looser], known)).toEqual(['code-api-migrations', undefined]);
  });
});
