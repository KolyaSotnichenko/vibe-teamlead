import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import { TaskLogWriter, taskLogger } from '../task-log-writer';

describe('taskLogger', () => {
  it('sends a line to the live log and keeps it in task_logs.json under its phase', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'vtl-tasklog-'));
    const post = vi.fn();
    taskLogger(post, new TaskLogWriter(dir, 'spec'), 'qa')('qa_fixer session completed: 3 turns');
    expect(post).toHaveBeenCalledWith('qa_fixer session completed: 3 turns');
    const logs = JSON.parse(readFileSync(path.join(dir, 'task_logs.json'), 'utf-8'));
    expect(logs.phases.validation.entries.at(-1)).toMatchObject({ type: 'info', content: 'qa_fixer session completed: 3 turns' });
  });

  it('still posts without a log writer', () => {
    const post = vi.fn();
    taskLogger(post, null, 'qa')('line');
    expect(post).toHaveBeenCalledWith('line');
  });

  it('keeps the order: text the agent wrote comes before the line about its session', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'vtl-tasklog-'));
    const writer = new TaskLogWriter(dir, 'spec');
    writer.processEvent({ type: 'text-delta', text: 'All done.' } as never, 'qa');
    taskLogger(() => {}, writer, 'qa')('session finished');
    const entries = JSON.parse(readFileSync(path.join(dir, 'task_logs.json'), 'utf-8')).phases.validation.entries;
    expect(entries.map((e: { content: string }) => e.content)).toEqual(['All done.', 'session finished']);
  });
});
