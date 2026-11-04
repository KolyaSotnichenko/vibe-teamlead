import { describe, expect, it } from 'vitest';
import type { TaskLogEntry } from '../../../../shared/types';
import { pairToolEntries } from '../TaskLogs';

const at = (n: number) => new Date(Date.UTC(2026, 10, 3, 12, 0, n)).toISOString();
const start = (tool: string, n: number, input = ''): TaskLogEntry =>
  ({ type: 'tool_start', tool_name: tool, tool_input: input, content: '', timestamp: at(n), phase: 'coding' }) as TaskLogEntry;
const end = (tool: string, n: number, detail?: string): TaskLogEntry =>
  ({ type: 'tool_end', tool_name: tool, content: '', detail, timestamp: at(n), phase: 'coding' }) as TaskLogEntry;
const text = (n: number): TaskLogEntry => ({ type: 'text', content: 'hi', timestamp: at(n), phase: 'coding' }) as TaskLogEntry;

describe('pairToolEntries', () => {
  it('folds each tool_end into its tool_start, one row per call', () => {
    const items = pairToolEntries([start('Bash', 1, 'ls'), end('Bash', 2, 'out'), text(3)]);
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({ kind: 'tool', start: { tool_input: 'ls' }, end: { detail: 'out' } });
    expect(items[1]).toMatchObject({ kind: 'entry', entry: { type: 'text' } });
  });

  it('matches parallel calls of the same tool in order, and of different tools by name', () => {
    const items = pairToolEntries([start('Read', 1, 'a'), start('Read', 2, 'b'), start('Grep', 3, 'g'), end('Grep', 4, 'G'), end('Read', 5, 'A'), end('Read', 6, 'B')]);
    expect(items.map((i) => (i.kind === 'tool' ? `${i.start.tool_input}:${i.end?.detail}` : 'x'))).toEqual(['a:A', 'b:B', 'g:G']);
  });

  it('keeps a call that has not finished, and an end with no start', () => {
    const items = pairToolEntries([end('Edit', 1, 'orphan'), start('Bash', 2, 'sleep')]);
    expect(items[0]).toMatchObject({ kind: 'entry', entry: { type: 'tool_end' } });
    expect(items[1]).toMatchObject({ kind: 'tool', start: { tool_input: 'sleep' } });
    expect(items[1].kind === 'tool' && items[1].end).toBeUndefined();
  });

  it('pairs calls by id when they have one (subagents run calls in parallel)', () => {
    const a = { ...start('Read', 1, 'a.ts'), tool_use_id: 'x' } as TaskLogEntry;
    const b = { ...start('Read', 2, 'b.ts'), tool_use_id: 'y', subagent: 'explorer' } as TaskLogEntry;
    const items = pairToolEntries([a, b, { ...end('Read', 3, 'B'), tool_use_id: 'y' } as TaskLogEntry, { ...end('Read', 4, 'A'), tool_use_id: 'x' } as TaskLogEntry]);
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({ start: { tool_input: 'a.ts' }, end: { detail: 'A' } });
    expect(items[1]).toMatchObject({ start: { tool_input: 'b.ts', subagent: 'explorer' }, end: { detail: 'B' } });
  });
});

