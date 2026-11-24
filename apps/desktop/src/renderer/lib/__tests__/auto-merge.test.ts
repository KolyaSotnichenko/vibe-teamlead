import { describe, expect, it, vi } from 'vitest';
import { createAutoMerge, type AutoMergeApi } from '../auto-merge';
import { autoMergeEnabled } from '../../hooks/useAutoMerge';

const passed = { success: true, data: { status: 'passed' } };

function setup(over: Partial<AutoMergeApi> = {}, enabled = true, reviewReason = 'completed') {
  const task = { id: 't', projectId: 'p', status: 'human_review', reviewReason };
  const mergeWorktree = vi.fn(async () => ({ success: true, data: { success: true, message: 'ok' } }));
  const onProblem = vi.fn();
  const onHeld = vi.fn();
  const onLeft = vi.fn();
  const api: AutoMergeApi = {
    getTaskMergeState: vi.fn(async () => ({ success: true, data: null })),
    getTaskSecurityQaError: vi.fn(async () => ({ success: true, data: null })),
    getTaskVerification: vi.fn(async () => passed),
    mergeWorktree,
    ...over,
  } as AutoMergeApi;
  const auto = createAutoMerge({ api, getTask: () => task as never, isEnabled: () => enabled, onProblem, onHeld, onLeft });
  return { auto, mergeWorktree, onProblem, onHeld, onLeft, task };
}

describe('merging a task by itself', () => {
  it('merges a task QA approved, the way the button does, in the project it checked', async () => {
    const { auto, mergeWorktree } = setup();
    await auto.statusChanged('t', 'ai_review', 'human_review');
    expect(mergeWorktree).toHaveBeenCalledWith('t', { auto: true, projectId: 'p' });
  });

  it('does nothing while the switch is off, the default', async () => {
    const { auto, mergeWorktree } = setup({}, false);
    await auto.statusChanged('t', 'ai_review', 'human_review');
    expect(mergeWorktree).not.toHaveBeenCalled();
  });

  it.each(['errors', 'qa_rejected', 'plan_review', 'stopped'])('leaves a task that QA did not approve to you: %s', async (reason) => {
    const { auto, mergeWorktree } = setup({}, true, reason);
    await auto.statusChanged('t', 'ai_review', 'human_review');
    expect(mergeWorktree).not.toHaveBeenCalled();
  });

  it.each([
    ['the checks found a regression', { getTaskVerification: async () => ({ success: true, data: { status: 'regression' } }) }],
    ["the checks couldn't say", { getTaskVerification: async () => ({ success: true, data: { status: 'not_verified' } }) }],
    ['the project has no checks', { getTaskVerification: async () => ({ success: true, data: { status: 'not_configured' } }) }],
    ["only the task's own checks ran (main had none)", { getTaskVerification: async () => ({ success: true, data: { status: 'passed', source: 'task' } }) }],
    ['nothing says the checks ran', { getTaskVerification: async () => ({ success: true, data: null }) }],
    ['the pentest did not finish', { getTaskSecurityQaError: async () => ({ success: true, data: { reason: 'crashed' } }) }],
    ['a merge already waits for review', { getTaskMergeState: async () => ({ success: true, data: { state: 'review' } }) }],
    ['the last merge failed', { getTaskMergeState: async () => ({ success: true, data: { state: 'failed', reason: 'x' } }) }],
    ['it is merging already', { getTaskMergeState: async () => ({ success: true, data: { state: 'merging' } }) }],
    ['a question could not be answered', { getTaskVerification: async () => ({ success: false, error: 'x' }) }],
  ])('leaves it to you when %s', async (_name, over) => {
    const { auto, mergeWorktree } = setup(over as never);
    await auto.statusChanged('t', 'ai_review', 'human_review');
    expect(mergeWorktree).not.toHaveBeenCalled();
  });

  it('only on arriving: turning the switch on merges nothing that already waits', async () => {
    const { auto, mergeWorktree } = setup();
    await auto.statusChanged('t', 'human_review', 'human_review');
    await auto.statusChanged('t', 'in_progress', 'ai_review');
    expect(mergeWorktree).not.toHaveBeenCalled();
  });

  it('tries once per arrival, so a failure cannot loop', async () => {
    const { auto, mergeWorktree } = setup();
    await Promise.all([auto.statusChanged('t', 'ai_review', 'human_review'), auto.statusChanged('t', 'ai_review', 'human_review')]);
    expect(mergeWorktree).toHaveBeenCalledTimes(1);

    await auto.statusChanged('t', 'human_review', 'ai_review');
    await auto.statusChanged('t', 'ai_review', 'human_review');
    expect(mergeWorktree).toHaveBeenCalledTimes(2);
  });

  it('says why when the merge is refused', async () => {
    const { auto, onProblem } = setup({ mergeWorktree: vi.fn(async () => ({ success: true, data: { success: false, message: 'your changes are in the way' } })) as never });
    await auto.statusChanged('t', 'ai_review', 'human_review');
    expect(onProblem).toHaveBeenCalledWith('t', 'your changes are in the way');
  });

  it('stays quiet when the merge waits for your review: the card says so', async () => {
    const { auto, onProblem } = setup({ mergeWorktree: vi.fn(async () => ({ success: true, data: { success: true, needsReview: true } })) as never });
    await auto.statusChanged('t', 'ai_review', 'human_review');
    expect(onProblem).not.toHaveBeenCalled();
  });

  it('says so when the merge throws, and does not crash', async () => {
    const { auto, onProblem } = setup({ mergeWorktree: vi.fn(async () => { throw new Error('boom'); }) as never });
    await expect(auto.statusChanged('t', 'ai_review', 'human_review')).resolves.toBeUndefined();
    expect(onProblem).toHaveBeenCalledWith('t', 'boom');
  });
});

describe('a task held for screens QA could not show', () => {
  it('hands the owner the screens to check, and is not reported as a failed merge', async () => {
    const screens = [{ file: 'screens/busy.html', width: 1280, title: 'Sign-in · busy', reason: 'answers instantly' }];
    const onScreens = vi.fn();
    const task = { id: 't', projectId: 'p', status: 'human_review', reviewReason: 'completed' };
    const onProblem = vi.fn();
    const api = {
      getTaskMergeState: vi.fn(async () => ({ success: true, data: null })),
      getTaskSecurityQaError: vi.fn(async () => ({ success: true, data: null })),
      getTaskVerification: vi.fn(async () => passed),
      mergeWorktree: vi.fn(async () => ({ success: true, data: { success: false, message: 'waits', heldForScreens: screens } })),
    } as unknown as AutoMergeApi;
    const auto = createAutoMerge({ api, getTask: () => task as never, isEnabled: () => true, onProblem, onScreens });
    await auto.statusChanged('t', 'ai_review', 'human_review');
    expect(onScreens).toHaveBeenCalledWith('t', screens);
    expect(onProblem).not.toHaveBeenCalled();
  });
});

describe('a UI task held for the preview', () => {
  it('is marked as waiting for the owner, not reported as a failed merge', async () => {
    const { auto, onProblem, onHeld } = setup({
      mergeWorktree: vi.fn(async () => ({ success: true, data: { success: false, message: 'waits for your preview', heldForPreview: true } })) as never,
    });
    await auto.statusChanged('t', 'ai_review', 'human_review');
    expect(onHeld).toHaveBeenCalledWith('t');
    expect(onProblem).not.toHaveBeenCalled();
  });

  it('loses the mark when it leaves review: it is held again only if it comes back and still changes UI', async () => {
    const { auto, onLeft } = setup();
    await auto.statusChanged('t', 'human_review', 'in_progress');
    expect(onLeft).toHaveBeenCalledWith('t');
  });
});

describe('deploy tasks with the project switch off', () => {
  const projectOff = { id: 'p', settings: { autoMerge: false } } as never;
  const reviewed = (sourceType: string, specId = 's-1') =>
    ({ id: 't', projectId: 'p', specId, status: 'human_review', reviewReason: 'completed', metadata: { sourceType } }) as never;

  function merger(task: unknown, isDeployTask: (projectId: string, specId: string) => Promise<boolean>) {
    const mergeWorktree = vi.fn(async () => ({ success: true, data: { success: true, message: 'ok' } }));
    const api = {
      getTaskMergeState: vi.fn(async () => ({ success: true, data: null })),
      getTaskSecurityQaError: vi.fn(async () => ({ success: true, data: null })),
      getTaskVerification: vi.fn(async () => passed),
      mergeWorktree,
    } as unknown as AutoMergeApi;
    const auto = createAutoMerge({
      api,
      getTask: () => task as never,
      isEnabled: (t) => autoMergeEnabled(projectOff, t, isDeployTask),
      onProblem: vi.fn(),
    });
    return { auto, mergeWorktree };
  }

  it('merges a deploy task the ledger created, once QA approved it', async () => {
    const { auto, mergeWorktree } = merger(reviewed('deploy'), async () => true);
    await auto.statusChanged('t', 'ai_review', 'human_review');
    expect(mergeWorktree).toHaveBeenCalledWith('t', { auto: true, projectId: 'p' });
  });

  it('does not merge a deploy-marked task the ledger does not hold', async () => {
    const { auto, mergeWorktree } = merger(reviewed('deploy'), async () => false);
    await auto.statusChanged('t', 'ai_review', 'human_review');
    expect(mergeWorktree).not.toHaveBeenCalled();
  });

  it('leaves a manual task to you while the project switch is off', async () => {
    const { auto, mergeWorktree } = merger(reviewed('manual'), async () => true);
    await auto.statusChanged('t', 'ai_review', 'human_review');
    expect(mergeWorktree).not.toHaveBeenCalled();
  });

  it('merges once when two arrivals race the ledger check', async () => {
    const { auto, mergeWorktree } = merger(reviewed('deploy'), async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return true;
    });
    await Promise.all([auto.statusChanged('t', 'ai_review', 'human_review'), auto.statusChanged('t', 'ai_review', 'human_review')]);
    expect(mergeWorktree).toHaveBeenCalledTimes(1);
  });
});

// Turning the switch on: tasks that already wait are offered, and merged only on the owner's yes
describe('tasks that already wait when auto-merge is turned on', () => {
  const waiting = (id: string, reviewReason = 'completed') => ({ id, projectId: 'p', status: 'human_review', reviewReason }) as never;

  it('lists only those QA approved whose checks are clean', async () => {
    const getTaskVerification = vi.fn(async (taskId: string) => (taskId === 'b' ? { success: true, data: { status: 'regression' } } : passed));
    const { auto } = setup({ getTaskVerification } as never);
    const found = await auto.mergeable([waiting('a'), waiting('b'), waiting('c', 'qa_rejected'), { id: 'd', projectId: 'p', status: 'in_progress' } as never]);
    expect(found.map((task) => (task as { id: string }).id)).toEqual(['a']);
  });

  it('merges them one at a time, the way the button does, and not again when they arrive', async () => {
    const { auto, mergeWorktree } = setup();
    await auto.mergeNow([waiting('a'), waiting('b')]);
    expect(mergeWorktree.mock.calls).toEqual([['a', { auto: true, projectId: 'p' }], ['b', { auto: true, projectId: 'p' }]]);
    await auto.statusChanged('a', 'ai_review', 'human_review');
    expect(mergeWorktree).toHaveBeenCalledTimes(2);
  });

  it('says why one could not be merged, and goes on with the rest', async () => {
    const mergeWorktree = vi.fn(async (taskId: string) => (taskId === 'a' ? { success: false, error: 'conflict' } : { success: true, data: { success: true, message: 'ok' } }));
    const { auto, onProblem } = setup({ mergeWorktree } as never);
    await auto.mergeNow([waiting('a'), waiting('b')]);
    expect(onProblem).toHaveBeenCalledWith('a', 'conflict');
    expect(mergeWorktree).toHaveBeenCalledTimes(2);
  });
});

