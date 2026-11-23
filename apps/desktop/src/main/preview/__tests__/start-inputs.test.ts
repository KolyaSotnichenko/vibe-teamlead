import { describe, expect, it } from 'vitest';

import { changedInputs, startInputs } from '../start-inputs';

const project = (files: Record<string, string>) => ({ files: Object.keys(files), read: (path: string) => files[path] ?? null });

const PLANNER: Record<string, string> = {
  'preview.json': '{"version":1,"kind":"web"}',
  'package.json': '{"scripts":{}}',
  'pnpm-lock.yaml': 'lock',
  'apps/api/package.json': '{"scripts":{"dev":"tsx watch src/index.ts"}}',
  'apps/api/.env.example': 'DATABASE_URL=postgres://u:p@localhost/x',
  'apps/api/migrations/0022_notifications.sql': 'create table notification_deliveries ()',
  'apps/api/src/app.ts': 'code',
  'docker-compose.yml': 'services: {}',
  'RUNNING.md': '# Running',
  'README.md': '# Readme',
  'node_modules/x/package.json': '{}',
};

describe('startInputs', () => {
  it('fingerprints only what decides how the project starts, not the recipe the start itself proves: manifests, lockfiles, compose, examples, migrations, RUNNING.md', () => {
    expect(Object.keys(startInputs(project(PLANNER))).sort()).toEqual([
      'RUNNING.md',
      'apps/api/.env.example',
      'apps/api/migrations/0022_notifications.sql',
      'apps/api/package.json',
      'docker-compose.yml',
      'package.json',
      'pnpm-lock.yaml',
    ]);
  });

  it('counts a migration by its name, not its text: a new one is a change, an edit to an old one is not', () => {
    const before = startInputs(project(PLANNER));
    expect(changedInputs(before, startInputs(project({ ...PLANNER, 'apps/api/migrations/0022_notifications.sql': 'edited' })))).toEqual([]);
    expect(changedInputs(before, startInputs(project({ ...PLANNER, 'apps/api/migrations/0023_email.sql': 'x' })))).toEqual(['apps/api/migrations/0023_email.sql']);
  });

  it('says what was added, changed or removed, and that everything is new when nothing was checked before', () => {
    const before = startInputs(project(PLANNER));
    const { 'RUNNING.md': _gone, ...rest } = PLANNER;
    const now = startInputs(project({ ...rest, 'apps/api/package.json': '{"scripts":{"dev":"node src/index.js"}}' }));
    expect(changedInputs(before, now)).toEqual(['RUNNING.md', 'apps/api/package.json']);
    expect(changedInputs(undefined, now)).toEqual(Object.keys(now).sort());
    expect(changedInputs(before, before)).toEqual([]);
  });

  it('keeps no file text, only short hashes', () => {
    const inputs = startInputs(project(PLANNER));
    expect(Object.values(inputs).every((value) => /^[0-9a-f]{16}$/.test(value))).toBe(true);
    expect(JSON.stringify(inputs)).not.toContain('postgres://');
  });
});
