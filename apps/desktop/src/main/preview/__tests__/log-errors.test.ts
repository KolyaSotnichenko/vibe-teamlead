import { describe, expect, it } from 'vitest';

import { errorInLog } from '../log-errors';

describe('errorInLog', () => {
  it.each([
    ['a table Postgres does not have', 'ERROR (23382): stale sending recovery failed\n      "message": "relation \\"notification_deliveries\\" does not exist",', 'relation "notification_deliveries" does not exist'],
    ['a column Postgres does not have', 'error: column "archived_at" of relation "tasks" does not exist', 'column "archived_at" of relation "tasks" does not exist'],
    ['a table MySQL does not have', "Error: ER_NO_SUCH_TABLE: Table 'app.users' doesn't exist", "ER_NO_SUCH_TABLE: Table 'app.users' doesn't exist"],
    ['a table SQLite does not have', 'SqliteError: no such table: sessions', 'no such table: sessions'],
    ['a database that is not there', 'error: database "planner" does not exist', 'database "planner" does not exist'],
    ['a wrong database password', 'error: password authentication failed for user "app"', 'password authentication failed for user "app"'],
    ['a module that is not installed', "Error: Cannot find module 'zod'\nRequire stack:", "Cannot find module 'zod'"],
    ['an ES module that is not there', "Error [ERR_MODULE_NOT_FOUND]: Cannot find package '@acme/shared' imported from /app/src/index.ts", "Cannot find package '@acme/shared'"],
    ['an import Vite cannot resolve', '[vite] Internal server error: Failed to resolve import "./missing" from "src/App.tsx". Does the file exist?', 'Failed to resolve import "./missing"'],
    ['a promise nobody caught', 'node:internal/process/promises:394\n    triggerUncaughtException(err, true /* fromPromise */);\n[UnhandledPromiseRejection: This error originated either by throwing inside of an async function]', 'UnhandledPromiseRejection'],
  ])('finds %s', (_what, log, line) => {
    expect(errorInLog(log)).toContain(line);
  });

  it('gives one short line, without terminal colours', () => {
    const found = errorInLog(`\u001b[31merror: relation "x" does not exist ${'y'.repeat(500)}\u001b[39m`);
    expect(found).toMatch(/^relation "x" does not exist/);
    expect(found?.length).toBeLessThanOrEqual(200);
    expect(found).not.toContain('\u001b');
  });

  it('says nothing about a log that only reports, warns, or retries', () => {
    expect(errorInLog('[15:35:34.038] INFO (23382): Server listening at http://127.0.0.1:3000\nGET /api 404 1ms\nWarning: React version not specified')).toBeNull();
    expect(errorInLog('Waiting for the database: connect ECONNREFUSED 127.0.0.1:5432, retrying in 1s')).toBeNull();
    expect(errorInLog('✓ 12 tests passed: "relation does not exist" handled')).toBeNull();
    expect(errorInLog('')).toBeNull();
  });
});
