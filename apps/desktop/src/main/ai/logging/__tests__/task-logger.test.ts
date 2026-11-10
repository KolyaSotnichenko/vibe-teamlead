import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import { TaskLogWriter, logRunFailure, taskLogger } from '../task-log-writer';

describe('the design log', () => {
  it("keeps the designer's work in its own phase, between planning and coding", () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'vtl-tasklog-'));
    const writer = new TaskLogWriter(dir, 'spec');
    writer.startPhase('design', 'Designing the screens');
    writer.processEvent({ type: 'text-delta', text: 'Drawing the roadmap wireframes.' } as never, 'design');
    taskLogger(() => {}, writer, 'design')('Design: the wireframes are ready for the owner');
    writer.endPhase('design', true);
    const logs = JSON.parse(readFileSync(path.join(dir, 'task_logs.json'), 'utf-8'));
    expect(logs.phases.design.status).toBe('completed');
    expect(logs.phases.design.entries.map((e: { content: string }) => e.content)).toEqual([
      'Designing the screens',
      'Drawing the roadmap wireframes.',
      'Design: the wireframes are ready for the owner',
      expect.any(String),
    ]);
    expect(logs.phases.planning.entries).toEqual([]);
  });

  it('adds the phase to a log file written before it existed', async () => {
    const { writeFileSync } = await import('node:fs');
    const dir = mkdtempSync(path.join(tmpdir(), 'vtl-tasklog-'));
    const empty = { status: 'pending', started_at: null, completed_at: null, entries: [] };
    writeFileSync(path.join(dir, 'task_logs.json'), JSON.stringify({ spec_id: 's', created_at: 'x', updated_at: 'x', phases: { planning: { phase: 'planning', ...empty }, coding: { phase: 'coding', ...empty }, validation: { phase: 'validation', ...empty } } }));
    const writer = new TaskLogWriter(dir, 's');
    taskLogger(() => {}, writer, 'design')('Design: drawing the wireframes');
    expect(JSON.parse(readFileSync(path.join(dir, 'task_logs.json'), 'utf-8')).phases.design.entries).toHaveLength(1);
  });
});

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

describe('logRunFailure', () => {
  it('keeps the reason in task_logs.json, even when no session or phase ever started', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'vtl-tasklog-'));
    const post = vi.fn();
    logRunFailure(post, new TaskLogWriter(dir, 'spec'), 'Implementation plan is invalid');
    expect(post).toHaveBeenCalledWith('Run failed: Implementation plan is invalid');
    const logs = JSON.parse(readFileSync(path.join(dir, 'task_logs.json'), 'utf-8'));
    expect(logs.phases.planning.entries.at(-1)).toMatchObject({ type: 'error', content: 'Run failed: Implementation plan is invalid' });
  });

  it('says nothing when there is no reason to give', () => {
    const post = vi.fn();
    logRunFailure(post, null, undefined);
    expect(post).not.toHaveBeenCalled();
  });
});
