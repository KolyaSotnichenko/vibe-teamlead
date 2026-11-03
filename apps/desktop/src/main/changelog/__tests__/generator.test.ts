/**
 * ChangelogGenerator runs on Claude Code (runClaudeTask), not a subprocess.
 */
import { describe, expect, it, vi } from 'vitest';
import type { ChangelogGenerationRequest, TaskSpecContent } from '../../../shared/types';

const { runClaudeTask } = vi.hoisted(() => ({ runClaudeTask: vi.fn() }));
vi.mock('../../ai/claude-code/task', () => ({ runClaudeTask }));
vi.mock('../../ipc-handlers/feature-settings-helper', () => ({
  getFeatureSettings: vi.fn(() => ({ model: 'haiku', thinkingLevel: 'low' })),
}));

const request: ChangelogGenerationRequest = {
  projectId: 'p',
  sourceMode: 'tasks',
  taskIds: ['task-1'],
  version: '1.0.0',
  date: '2026-11-03',
  format: 'keep-a-changelog',
  audience: 'technical',
};
const specs: TaskSpecContent[] = [{ taskId: 'task-1', specId: '001-test', spec: '# Test\nA spec' }];

async function makeGenerator() {
  const { ChangelogGenerator } = await import('../generator');
  return new ChangelogGenerator();
}

describe('ChangelogGenerator', () => {

  it('generates with the utility model and emits the result', async () => {
    runClaudeTask.mockImplementation(async () => ({ text: '## [1.0.0] - 2026-11-03\n\n### Added\n- Test' }));
    const generator = await makeGenerator();
    const complete = vi.fn();
    generator.on('generation-complete', complete);

    await generator.generate('p', '/tmp/p', request, specs);

    expect(runClaudeTask).toHaveBeenCalledWith(expect.objectContaining({ model: 'haiku', thinkingLevel: 'low', maxTurns: 1 }));
    expect(complete).toHaveBeenCalledWith('p', expect.objectContaining({ success: true, version: '1.0.0', tasksIncluded: 1 }));
    expect(complete.mock.calls[0][1].changelog).toContain('### Added');
  });

  it('reports a failure as an error event', async () => {
    runClaudeTask.mockImplementation(async () => {
      throw new Error('Claude Code exited');
    });
    const generator = await makeGenerator();
    const errors: string[] = [];
    generator.on('generation-error', (_id: string, error: string) => errors.push(error));

    await generator.generate('p', '/tmp/p', request, specs);
    expect(errors).toEqual(['Claude Code exited']);
  });

  it('cancel aborts the session and suppresses its result', async () => {
    let signal: AbortSignal | undefined;
    runClaudeTask.mockImplementation((options: { abortSignal: AbortSignal }) => {
      signal = options.abortSignal;
      return new Promise((_resolve, reject) => options.abortSignal.addEventListener('abort', () => reject(new Error('aborted'))));
    });
    const generator = await makeGenerator();
    const errors = vi.fn();
    generator.on('generation-error', errors);

    const running = generator.generate('p', '/tmp/p', request, specs);
    await vi.waitFor(() => expect(signal).toBeDefined());
    expect(generator.cancel('p')).toBe(true);
    await running;
    expect(signal?.aborted).toBe(true);
    expect(errors).not.toHaveBeenCalled();
    expect(generator.cancel('p')).toBe(false);
  });

  it('errors without specs', async () => {
    const generator = await makeGenerator();
    const errors = vi.fn();
    generator.on('generation-error', errors);
    await generator.generate('p', '/tmp/p', request, []);
    expect(errors).toHaveBeenCalledWith('p', 'No specs provided for changelog generation');
    expect(runClaudeTask).not.toHaveBeenCalled();
  });
});
