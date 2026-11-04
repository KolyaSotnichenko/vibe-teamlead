import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it } from 'vitest';
import { TaskLogWriter } from '../../logging/task-log-writer';
import type { StreamEvent } from '../../session/types';
import { SessionAccumulator } from '../event-mapper';
import { helperSubagents, helpersPromptSection } from '../subagents';

const msg = (m: unknown) => m as SDKMessage;

describe('helper subagents', () => {
  it('gives the coder an explorer, a test runner and a reviewer, none of which can edit files', () => {
    const agents = helperSubagents('coder', { enabled: true, model: '' });
    expect(Object.keys(agents)).toEqual(['explorer', 'test_runner', 'reviewer']);
    for (const a of Object.values(agents)) {
      expect(a.tools).not.toContain('Write');
      expect(a.tools).not.toContain('Edit');
      expect(a.model).toBe('inherit');
    }
    expect(agents.explorer.tools).not.toContain('Bash');
  });

  it('uses the chosen model, and gives nothing when turned off or for agents without helpers', () => {
    expect(helperSubagents('qa_reviewer', { enabled: true, model: 'glm-5.3-flash' }).explorer.model).toBe('glm-5.3-flash');
    expect(helperSubagents('coder', { enabled: false, model: '' })).toEqual({});
    expect(helperSubagents('spec_writer', { enabled: true, model: '' })).toEqual({});
    expect(helpersPromptSection({})).toBe('');
    expect(helpersPromptSection(helperSubagents('planner', { enabled: true, model: '' }))).toContain('`explorer`');
  });
});

describe('subagent activity in the logs', () => {
  it("reports a subagent's tool calls under its Agent call, tagged with its name, without its text", () => {
    const events: StreamEvent[] = [];
    const acc = new SessionAccumulator((e) => events.push(e));
    acc.handle(msg({
      type: 'assistant', parent_tool_use_id: null,
      message: { id: 'm1', content: [{ type: 'tool_use', id: 'a1', name: 'Agent', input: { subagent_type: 'explorer', description: 'Find invoice export', prompt: '...' } }] },
    }));
    acc.handle(msg({
      type: 'assistant', parent_tool_use_id: 'a1',
      message: { id: 's1', content: [{ type: 'text', text: 'Searching' }, { type: 'tool_use', id: 'g1', name: 'Grep', input: { pattern: 'exportCsv' } }] },
    }));
    acc.handle(msg({ type: 'user', parent_tool_use_id: 'a1', message: { content: [{ type: 'tool_result', tool_use_id: 'g1', content: 'src/x.ts' }] } }));
    acc.handle(msg({ type: 'user', parent_tool_use_id: null, message: { content: [{ type: 'tool_result', tool_use_id: 'a1', content: 'report' }] } }));

    const calls = events.filter((e) => e.type === 'tool-call');
    expect(calls).toHaveLength(2);
    expect(calls[1]).toMatchObject({ toolName: 'Grep', parentToolCallId: 'a1' });
    expect(acc.messages).toEqual([]); // the subagent's "Searching" is not the agent's text
    expect(acc.stepsExecuted).toBe(1);

    const dir = mkdtempSync(path.join(tmpdir(), 'vtl-sublog-'));
    const writer = new TaskLogWriter(dir, '001');
    for (const e of events) writer.processEvent(e, 'coding');
    writer.flush();
    const entries = JSON.parse(readFileSync(path.join(dir, 'task_logs.json'), 'utf-8')).phases.coding.entries;
    const agentStart = entries.find((e: { tool_name?: string; type: string }) => e.tool_name === 'Agent' && e.type === 'tool_start');
    const grep = entries.filter((e: { tool_name?: string }) => e.tool_name === 'Grep');
    expect(agentStart.tool_input).toBe('explorer · Find invoice export');
    expect(agentStart.subagent).toBeUndefined();
    expect(grep.map((e: { subagent?: string }) => e.subagent)).toEqual(['explorer', 'explorer']);
    expect(grep[0].tool_use_id).toBe('g1');
  });
});
