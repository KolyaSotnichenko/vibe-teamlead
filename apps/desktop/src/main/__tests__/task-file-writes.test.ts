import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * F-009: a task's plan, metadata and requirements are read by the file watcher and the task
 * list while they are written. Written in place, a reader could see half a file, and a crash
 * mid-write left a broken plan. They go through safe-write.ts (a new file renamed into place).
 */
const WRITERS = [
  'ipc-handlers/task/crud-handlers.ts',
  'ipc-handlers/insights-handlers.ts',
  'ipc-handlers/linear-handlers.ts',
  'ipc-handlers/ideation/task-converter.ts',
  'ipc-handlers/github/spec-utils.ts',
];

const TASK_FILE = /plan|metadata|requirements/i;

describe('task files (plan, metadata, requirements)', () => {
  it.each(WRITERS)('%s never writes one in place', (file) => {
    const source = readFileSync(join(__dirname, '..', file), 'utf-8');
    const inPlace = source
      .split('\n')
      .map((line, i) => ({ line: line.trim(), at: i + 1 }))
      .filter(({ line }) => /\bwriteFileSync\(/.test(line) && TASK_FILE.test(line));
    expect(inPlace).toEqual([]);
  });
});
