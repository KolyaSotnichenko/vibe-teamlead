import { describe, expect, it } from 'vitest';

import { insightsLogLine, promptMemoryLogLine } from '../memory-log';

describe('what the task log says about project memory', () => {
  it('how many memories went into a prompt, or that none matched, or why it could not look', () => {
    expect(promptMemoryLogLine({ ok: true, text: '## Project memory\n\nhints\n\n- [gotcha] a\n- [pattern] b' })).toBe('Project memory: 2 in the prompt');
    expect(promptMemoryLogLine({ ok: true, text: '' })).toBe('Project memory: nothing relevant yet');
    expect(promptMemoryLogLine({ ok: false, error: 'Embedding provider unreachable' })).toBe("Project memory: couldn't look it up (Embedding provider unreachable)");
  });

  it('what came of the lessons of a subtask: saved, nothing new, or why not', () => {
    expect(insightsLogLine('1-2', {}, { ok: true, text: '3' })).toBe('Project memory: saved 3 lessons from subtask 1-2');
    expect(insightsLogLine('1-2', {}, { ok: true, text: '1' })).toBe('Project memory: saved 1 lesson from subtask 1-2');
    expect(insightsLogLine('1-2', {}, { ok: true, text: '0' })).toBe('Project memory: subtask 1-2 left nothing new to remember');
    expect(insightsLogLine('1-2', { failure: 'model not found' })).toBe("Project memory: couldn't take lessons from subtask 1-2 (model not found)");
    expect(insightsLogLine('1-2', {}, { ok: false, error: 'No project for this task' })).toBe("Project memory: couldn't save subtask 1-2's lessons (No project for this task)");
  });
});
