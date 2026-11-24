import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
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

describe('update_qa_status with a design', () => {
  const since = Date.now() - 60_000;
  const visual = (browser = true) => ({ frames: [{ file: 'screens/board.html', width: 1280 }], since, browser });

  function setupWithDesign(context: Partial<ToolContext>) {
    const specDir = mkdtempSync(path.join(tmpdir(), 'vtl-qastatus-design-'));
    writeFileSync(path.join(specDir, 'implementation_plan.json'), JSON.stringify({ phases: [] }));
    return {
      specDir,
      run: (status: string, agentType = 'qa_reviewer') =>
        updateQaStatusTool.config.execute({ status } as never, { specDir, agentType, ...context } as unknown as ToolContext),
      signoff: () => (JSON.parse(readFileSync(path.join(specDir, 'implementation_plan.json'), 'utf-8')) as { qa_signoff?: { status?: string } }).qa_signoff,
    };
  }

  it('refuses an approval that does not show the design in the running app, and says what is missing', async () => {
    const t = setupWithDesign({ visualEvidence: visual() });
    const output = String(await t.run('approved'));
    expect(output).toMatch(/^Error: approval not recorded/);
    expect(output).toContain('design_compare.json');
    expect(t.signoff()).toBeUndefined();
  });

  it('records the approval once every frame has a fresh screenshot', async () => {
    const t = setupWithDesign({ visualEvidence: visual() });
    mkdirSync(path.join(t.specDir, 'qa-browser'));
    writeFileSync(path.join(t.specDir, 'qa-browser', 'board.png'), 'png');
    writeFileSync(
      path.join(t.specDir, 'design_compare.json'),
      JSON.stringify({ screens: [{ file: 'screens/board.html', width: 1280, built: 'qa-browser/board.png', differences: [] }] }),
    );
    expect(String(await t.run('approved'))).not.toMatch(/^Error/);
    expect(t.signoff()?.status).toBe('approved');
  });

  it('asks nothing of a rejection, or of a session without a design', async () => {
    const rejected = setupWithDesign({ visualEvidence: visual() });
    expect(String(await rejected.run('rejected'))).not.toMatch(/^Error/);
    const noDesign = setupWithDesign({});
    expect(String(await noDesign.run('approved'))).not.toMatch(/^Error/);
  });
});

describe('QA prompts', () => {
  const prompt = (name: string) => readFileSync(path.resolve(__dirname, '../../../../../../prompts', `${name}.md`), 'utf-8');

  it.each(['qa_reviewer', 'qa_fixer'])('%s records its verdict with the tool, not by editing the plan', (name) => {
    expect(prompt(name)).toContain('mcp__vibe-teamlead__update_qa_status');
    expect(prompt(name)).not.toContain('"qa_signoff": {');
  });

  it('QA does not load the plan and progress notes at the start of every session', () => {
    for (const name of ['qa_reviewer', 'qa_fixer']) {
      expect(prompt(name)).not.toContain('cat implementation_plan.json');
      expect(prompt(name)).not.toContain('cat build-progress.txt');
    }
    expect(prompt('qa_fixer')).not.toContain('cat spec.md');
  });

  it('the coder reads with the Read tool, not cat, and only the end of the progress notes', () => {
    const coder = prompt('coder');
    expect(coder).not.toContain('cat "$SPEC_DIR/implementation_plan.json"');
    expect(coder).not.toContain('cat "$SPEC_DIR/spec.md"');
    expect(coder).not.toContain('cat "$SPEC_DIR/build-progress.txt"');
    expect(coder).not.toContain('cat [path/to/file]');
    expect(coder).toContain('in one message');
  });

  it.each(['qa_reviewer', 'qa_fixer', 'coder'])('%s starts servers with the tool, not init.sh', (name) => {
    expect(prompt(name)).toContain('mcp__vibe-teamlead__start_dev_server');
    expect(prompt(name)).not.toContain('./init.sh');
  });

  it('the reviewer does not name browser tools the session may not have', () => {
    expect(prompt('qa_reviewer')).not.toContain('mcp__playwright__browser_navigate');
  });

  it('the reviewer no longer writes a fix request: that file is what the user asks', () => {
    expect(prompt('qa_reviewer')).not.toContain('QA_FIX_REQUEST');
    expect(prompt('qa_fixer')).not.toContain('cat QA_FIX_REQUEST.md');
  });
});
