import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { QASignoffSchema } from '../../../schema/qa-signoff';
import type { ToolContext } from '../../types';
import { updateQaStatusTool } from '../update-qa-status';

function setup(plan: Record<string, unknown> = {}) {
  const specDir = mkdtempSync(path.join(tmpdir(), 'vtl-qastatus-'));
  const file = path.join(specDir, 'implementation_plan.json');
  writeFileSync(file, JSON.stringify(plan));
  return {
    run: (input: { status: string; issues?: string }, agentType = 'qa_reviewer') =>
      updateQaStatusTool.config.execute(input as never, { specDir, agentType } as unknown as ToolContext),
    plan: () => JSON.parse(readFileSync(file, 'utf-8')) as { qa_signoff?: Record<string, unknown> },
  };
}

describe('update_qa_status', () => {
  it('keeps a readable signoff when an agent left a non-number qa_session in the plan', async () => {
    const t = setup({ qa_signoff: { status: 'rejected', qa_session: '003-some-spec' } });
    const output = await t.run({ status: 'rejected', issues: '[]' });
    expect(output).not.toContain('NaN');
    expect(t.plan().qa_signoff?.qa_session).toBe(1);
    expect(QASignoffSchema.safeParse(t.plan().qa_signoff).success).toBe(true);
  });

  it('tells the agent when the signoff is invalid and leaves the plan alone', async () => {
    const t = setup({ phases: [] });
    const output = await t.run({ status: 'rejected', issues: '[1]' });
    expect(output).toMatch(/^Error:/);
    expect(t.plan().qa_signoff).toBeUndefined();
  });

  it('does not let the fixer approve', async () => {
    const t = setup({ phases: [] });
    const output = await t.run({ status: 'approved' }, 'qa_fixer');
    expect(output).toMatch(/^Error:/);
    expect(t.plan().qa_signoff).toBeUndefined();
  });

  it('lets the reviewer approve and the fixer report its fixes', async () => {
    const t = setup({ phases: [] });
    await t.run({ status: 'fixes_applied' }, 'qa_fixer');
    expect(t.plan().qa_signoff?.status).toBe('fixes_applied');
    await t.run({ status: 'approved' });
    expect(t.plan().qa_signoff?.status).toBe('approved');
  });
});

describe('QA prompts', () => {
  const prompt = (name: string) => readFileSync(path.resolve(__dirname, '../../../../../../prompts', `${name}.md`), 'utf-8');

  it.each(['qa_reviewer', 'qa_fixer'])('%s records its verdict with the tool, not by editing the plan', (name) => {
    expect(prompt(name)).toContain('mcp__vibe-teamlead__update_qa_status');
    expect(prompt(name)).not.toContain('"qa_signoff": {');
  });

  it('the reviewer no longer writes a fix request: that file is what the user asks', () => {
    expect(prompt('qa_reviewer')).not.toContain('QA_FIX_REQUEST');
    expect(prompt('qa_fixer')).not.toContain('cat QA_FIX_REQUEST.md');
  });
});
