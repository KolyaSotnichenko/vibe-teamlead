import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import { QASignoffSchema } from '../../../schema/qa-signoff';
import type { ToolContext } from '../../types';
import { updateQaStatusTool } from '../update-qa-status';
import { createElementCheck, elementRefusal, frameInventories, type FramePage } from '../../../design/element-check';

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
    writeFileSync(path.join(t.specDir, 'qa-browser', 'board.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]));
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

describe('update_qa_status: the app looks for each element of the mockup on the built page', () => {
  const since = Date.now() - 60_000;
  const frame = { file: 'screens/board.html', width: 1280 };
  const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

  function setupElements(options: { pages?: FramePage[] | ((call: number) => FramePage[]); capture?: 'fails' | 'throws'; app?: 'fails'; mockup?: 'missing'; differences?: Array<{ severity: string; text: string }> } = {}) {
    const specDir = mkdtempSync(path.join(tmpdir(), 'vtl-qastatus-elements-'));
    writeFileSync(path.join(specDir, 'implementation_plan.json'), JSON.stringify({ phases: [] }));
    mkdirSync(path.join(specDir, 'design', 'screens'), { recursive: true });
    writeFileSync(
      path.join(specDir, 'design', 'screens', 'board.html'),
      '<main><button>Додати задачу</button><label for="who">Виконавці</label><select id="who"></select><a href="task-card.html">Запросити прайс</a><a href="task-card.html">Купити насіння</a><a href="task-card.html">Зібрати урожай</a></main>',
    );
    if (options.mockup === 'missing') rmSync(path.join(specDir, 'design', 'screens', 'board.html'));
    mkdirSync(path.join(specDir, 'qa-browser'));
    writeFileSync(path.join(specDir, 'qa-browser', 'board.png'), PNG);
    const writeCompare = (differences = options.differences ?? []) =>
      writeFileSync(path.join(specDir, 'design_compare.json'), JSON.stringify({ screens: [{ ...frame, built: 'qa-browser/board.png', differences }] }));
    writeCompare();
    writeFileSync(path.join(specDir, 'screens.json'), JSON.stringify({ screens: [{ id: 'screens/board.html', width: 1280, path: '/board', steps: [] }] }));
    const log = vi.fn();
    let calls = 0;
    const capture = vi.fn(async () => {
      calls++;
      if (options.capture === 'fails') return { error: 'the main process did not answer' };
      if (options.capture === 'throws') throw new Error('boom');
      const pages = options.pages ?? [{ ...frame, elements: [{ kind: 'button', names: ['Додати задачу'] }] }];
      return typeof pages === 'function' ? pages(calls) : pages;
    });
    const check = createElementCheck({
      specDir,
      startApp: async () => (options.app === 'fails' ? { ok: false as const, reason: 'Docker is not running' } : { ok: true as const, url: 'http://localhost:5173' }),
      capture,
      commit: async () => 'abc123',
      log,
      // Read before any review, as the worker does
      inventories: frameInventories(specDir, [frame]),
    });
    const checkElements = async () => {
      const outcome = await check.check([frame]);
      return outcome ? elementRefusal(outcome) : undefined;
    };
    const context = { specDir, agentType: 'qa_reviewer', visualEvidence: { frames: [frame], since, browser: true }, checkElements } as unknown as ToolContext;
    return {
      specDir,
      log,
      capture,
      check,
      writeCompare,
      approve: async () => String(await updateQaStatusTool.config.execute({ status: 'approved' } as never, context)),
      signoff: () => (JSON.parse(readFileSync(path.join(specDir, 'implementation_plan.json'), 'utf-8')) as { qa_signoff?: { status?: string } }).qa_signoff,
      compare: () => JSON.parse(readFileSync(path.join(specDir, 'design_compare.json'), 'utf-8')) as { screens: Array<{ notShown?: string; built?: string }> },
    };
  }

  it('refuses the approval with the elements the app did not find, and says what to do', async () => {
    const t = setupElements();
    const output = await t.approve();
    expect(output).toMatch(/^Error: approval not recorded/);
    expect(output).toContain('screens/board.html at 1280 px: field «Виконавці»');
    expect(output).not.toContain('Додати задачу');
    // Sample rows of the mockup are never asked for
    expect(output).not.toContain('Запросити прайс');
    expect(output).toMatch(/minor difference/);
    expect(t.signoff()).toBeUndefined();
    expect(t.log).toHaveBeenCalledWith(expect.stringMatching(/opened 1 .*frame.*looked for 2 element.*1 not found.*0 of them accounted for/));
  });

  it('records the approval once the reviewer names the element in a minor difference, without opening the app again', async () => {
    const t = setupElements();
    await t.approve();
    t.writeCompare([{ severity: 'minor', text: 'Поле «Виконавці» — дані-приклад макета: план не має виконавців' }]);
    expect(await t.approve()).not.toMatch(/^Error/);
    expect(t.signoff()?.status).toBe('approved');
    expect(t.capture).toHaveBeenCalledTimes(1);
    expect(t.log).toHaveBeenLastCalledWith(expect.stringMatching(/1 not found.*1 of them accounted for/));
  });

  // A check that could not run is not a check that passed: the owner looks before the merge
  it('when the check cannot run, the approval is recorded and every frame goes to the owner as not shown', async () => {
    for (const [options, why] of [[{ capture: 'fails' }, /the main process did not answer/], [{ app: 'fails' }, /Docker is not running/], [{ capture: 'throws' }, /boom/]] as const) {
      const t = setupElements(options);
      expect(await t.approve()).not.toMatch(/^Error/);
      expect(t.signoff()?.status).toBe('approved');
      expect(t.log).toHaveBeenCalledWith(expect.stringMatching(/did not run/));
      expect(t.log).toHaveBeenCalledWith(expect.stringMatching(why));
      expect(t.compare().screens[0].notShown).toMatch(/the app could not look at it itself/);
      expect(t.compare().screens[0].notShown).toMatch(why);
      // The QA loop's own check holds the merge for the owner
      expect((await t.check.check([frame]))?.notShown).toEqual([{ ...frame, reason: expect.stringMatching(why) }]);
    }
  });

  // The reviewer can write in the spec folder, the mockups included
  it('looks for the elements the mockup had before the review: emptying the mockup changes nothing', async () => {
    const t = setupElements();
    writeFileSync(path.join(t.specDir, 'design', 'screens', 'board.html'), '<main></main>');
    const output = await t.approve();
    expect(output).toMatch(/^Error: approval not recorded/);
    expect(output).toContain('field «Виконавці»');
  });

  it('a frame whose mockup could not be read goes to the owner: nothing was looked for', async () => {
    const t = setupElements({ mockup: 'missing' });
    expect(await t.approve()).not.toMatch(/^Error/);
    expect(t.compare().screens[0].notShown).toMatch(/the app could not look at it itself: its mockup could not be read/);
    expect((await t.check.check([frame]))?.notShown).toHaveLength(1);
  });

  // What comes back from the page and the capture is not always text
  it('an error that is not text does not break the check', async () => {
    const t = setupElements({ pages: [{ ...frame, error: { toString: () => { throw new Error('x'); } } as never }] });
    const output = await t.approve();
    expect(output).toMatch(/^Error: approval not recorded/);
    expect(output).toContain('could not be opened by its recipe');
    expect(elementRefusal({ unaccounted: [], unreachable: [{ ...frame, error: 42 as never }] })).toContain('could not be opened');
  });

  it('a frame the app cannot open: first the recipe is fixed, then it goes to the owner as not shown', async () => {
    const t = setupElements({ pages: [{ ...frame, error: 'not found: "#board"' }] });
    const first = await t.approve();
    expect(first).toMatch(/^Error: approval not recorded/);
    expect(first).toContain('screens.json');
    expect(first).toContain('not found: "#board"');
    expect(t.signoff()).toBeUndefined();
    // The reviewer changed the recipe; the app still cannot open the frame
    writeFileSync(path.join(t.specDir, 'screens.json'), JSON.stringify({ screens: [{ id: 'screens/board.html', width: 1280, path: '/boards', steps: [] }] }));
    expect(await t.approve()).not.toMatch(/^Error/);
    expect(t.signoff()?.status).toBe('approved');
    expect(t.compare().screens[0].notShown).toMatch(/the app could not open it by the recorded steps: not found: "#board"/);
    expect(t.compare().screens[0].built).toBe('qa-browser/board.png');
    // The QA loop's own check carries it to the owner too
    expect((await t.check.check([frame]))?.notShown).toEqual([{ ...frame, reason: expect.stringContaining('could not open it') }]);
  });

  it('a frame the app opens again later is checked like any other, and no longer goes to the owner', async () => {
    const reached = [{ ...frame, elements: [{ kind: 'button', names: ['Додати задачу'] }, { kind: 'field', names: ['Виконавці'] }] }];
    const t = setupElements({ pages: (call) => (call <= 2 ? [{ ...frame, error: 'not found: "#board"' }] : reached) });
    const recipe = (at: string) => writeFileSync(path.join(t.specDir, 'screens.json'), JSON.stringify({ screens: [{ id: 'screens/board.html', width: 1280, path: at, steps: [] }] }));
    expect(await t.approve()).toMatch(/^Error/);
    recipe('/boards');
    expect(await t.approve()).not.toMatch(/^Error/);
    expect(t.compare().screens[0].notShown).toBeDefined();
    recipe('/board/1');
    expect(await t.check.check([frame])).toEqual({ unaccounted: [], unreachable: [], notShown: [] });
    expect(t.compare().screens[0].notShown).toBeUndefined();
  });

  it('skips a frame the reviewer could not show: the owner looks at it already', async () => {
    const t = setupElements();
    writeFileSync(path.join(t.specDir, 'design_compare.json'), JSON.stringify({ screens: [{ ...frame, notShown: 'needs a second account', differences: [] }] }));
    expect(await t.check.check([frame])).toBeUndefined();
    expect(t.capture).not.toHaveBeenCalled();
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
