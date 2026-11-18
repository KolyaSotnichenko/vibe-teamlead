import { describe, expect, it, vi } from 'vitest';

import type { TelegramNotificationSettings } from '../../../shared/types/telegram';
import { botText } from '../i18n';
import { createNotifier, type NotifierDeps, type NotifierSources } from '../notifier';
import { DEFAULT_NOTIFICATIONS } from '../settings-store';
import { createFakeBot } from './fake-bot';

const t = (k: string, v?: Record<string, string | number>) => botText('en', k, v);

function fakeSources() {
  type StatusListener = Parameters<NotifierSources['onStatusChange']>[0];
  const status: StatusListener[] = [];
  const app = new Map<string, Array<(p: never) => void>>();
  const base: Array<Parameters<NotifierSources['onBaseFailures']>[0]> = [];
  const sources: NotifierSources = {
    onStatusChange: (l) => {
      status.push(l);
      return () => undefined;
    },
    onAppEvent: ((type: string, l: (p: never) => void) => {
      app.set(type, [...(app.get(type) ?? []), l]);
      return () => undefined;
    }) as NotifierSources['onAppEvent'],
    onBaseFailures: (l) => {
      base.push(l);
      return () => undefined;
    },
  };
  return {
    sources,
    status: (...args: Parameters<StatusListener>) => status.forEach((l) => l(...args)),
    app: (type: string, payload: unknown) => (app.get(type) ?? []).forEach((l) => l(payload as never)),
    base: (...args: Parameters<(typeof base)[number]>) => base.forEach((l) => l(...args)),
  };
}

function setup(notifications: Partial<TelegramNotificationSettings> = {}, chatId: number | null = 5, deliver?: NotifierDeps['deliver']) {
  const bot = createFakeBot();
  const src = fakeSources();
  const buttonsFor = vi.fn(() => undefined);
  const notifier = createNotifier({
    api: () => bot.api,
    chatId: () => chatId ?? undefined,
    t,
    notifications: () => ({ ...DEFAULT_NOTIFICATIONS, ...notifications }),
    task: (taskId) => ({ title: taskId === 'evil' ? '<b>x</b> & <a href=javascript:alert(1)>y</a>' : `Task ${taskId}`, specId: `001-${taskId}`, projectName: 'Shop' }),
    projectName: () => 'Shop',
    buttonsFor,
    deliver,
  });
  notifier.start(src.sources);
  const texts = async () => {
    await notifier.idle();
    return bot.sent.map((s) => s.text);
  };
  return { bot, src, notifier, texts, buttonsFor };
}

describe('notifier', () => {
  it('task waits for review: QA approved or not', async () => {
    const { src, texts } = setup();
    src.status('t1', 'human_review', 'completed');
    src.status('t2', 'human_review', 'qa_rejected');
    const sent = await texts();
    expect(sent[0]).toBe('👀 <b>Waits for your review</b> · Shop\n<b>Task t1</b> · <code>001-t1</code>\n✅ QA approved it');
    expect(sent[1]).toContain('⚠️ QA did not approve it');
  });

  it('an architecture-only task that is ready says so, as its own message (not a review with Merge)', async () => {
    const deliver = vi.fn(async () => false);
    const { src, texts } = setup({}, 5, deliver as never);
    src.status('t1', 'human_review', 'architecture_ready');
    const sent = await texts();
    expect(sent[0]).toBe('🏗 <b>Architecture ready</b> · Shop\n<b>Task t1</b> · <code>001-t1</code>\nThe diagrams and decisions are in the task\'s Architecture tab. Look them over in the app and mark the task done.');
    expect(deliver).toHaveBeenCalledWith(expect.objectContaining({ kind: 'reviewWaiting', reviewReason: 'architecture_ready' }), 5);
  });

  it('a design the designer could not make asks the owner to decide', async () => {
    const { src, texts } = setup();
    src.status('t1', 'human_review', 'design_failed');
    const sent = await texts();
    expect(sent[0]).toBe("🎨 <b>The design couldn't be made</b> · Shop\n<b>Task t1</b> · <code>001-t1</code>\nThe designer stopped. Try the design again, or build without it: here, or on the task's Design tab in the app.");
  });

  it('a hostile task title stays inert', async () => {
    const { src, bot, texts } = setup();
    src.status('evil', 'error');
    const sent = await texts();
    expect(bot.sent[0].html).toBe(true);
    expect(sent[0]).toContain('<b>&lt;b&gt;x&lt;/b&gt; &amp; &lt;a href=javascript:alert(1)&gt;y&lt;/a&gt;</b>');
  });

  it('says a state once, and again after the task moved on', async () => {
    const { src, texts } = setup();
    src.status('t1', 'human_review', 'completed');
    src.status('t1', 'human_review', 'completed');
    src.status('t1', 'in_progress');
    src.status('t1', 'human_review', 'completed');
    expect(await texts()).toHaveLength(2);
  });

  it('failed, errored and stuck tasks', async () => {
    const { src, texts } = setup();
    src.status('t1', 'human_review', 'errors');
    src.status('t2', 'error');
    src.app('task-stuck', { taskId: 't3', projectId: 'p1' });
    const sent = await texts();
    expect(sent[0]).toMatch(/^❌ <b>Task failed<\/b> · Shop\n<b>Task t1<\/b>/);
    expect(sent[1]).toMatch(/^❌ <b>Task stopped with an error<\/b>/);
    expect(sent[2]).toMatch(/^⚠️ <b>Task got stuck and was stopped<\/b> · Shop\n<b>Task t3<\/b>/);
  });

  it('CI failed on main, merged, regression and broken main', async () => {
    const { src, texts } = setup();
    src.app('main-run-failed', {
      projectId: 'p1',
      runId: 1,
      name: 'CI',
      url: 'https://github.com/o/r/actions/runs/1',
      failedJobs: ['test', 'lint'],
      logTail: 'Error: expected <div> & got null',
    });
    src.app('task-merged', { taskId: 't1', projectId: 'p1' });
    src.app('verification-regression', { taskId: 't2', projectId: 'p1' });
    src.base('t3', { baseCommit: 'abc' }, 'p1');
    src.base('t4', { baseCommit: 'abc' }, 'p1');
    const sent = await texts();
    expect(sent).toHaveLength(4);
    expect(sent[0]).toBe(
      '🔴 <b>CI failed on main</b> · Shop\nFailed jobs: <code>test</code>, <code>lint</code>\n' +
        '<blockquote expandable>Error: expected &lt;div&gt; &amp; got null</blockquote>\n🔗 <a href="https://github.com/o/r/actions/runs/1">CI</a>',
    );
    expect(sent[1]).toMatch(/^✅ <b>Merged<\/b> · Shop\n<b>Task t1<\/b>/);
    expect(sent[2]).toMatch(/^⚠️ <b>App checks found a regression<\/b>[\s\S]*\nThe merge was stopped\.$/);
    expect(sent[3]).toBe('⚠️ <b>App checks fail on main</b> · Shop\nA task to fix main was started.');
  });

  it('a merge comes with the 🎉 effect; other notifications without one', async () => {
    const { src, bot, texts } = setup();
    src.app('task-merged', { taskId: 't1', projectId: 'p1' });
    src.status('t2', 'error');
    await texts();
    expect(bot.sent[0].options?.effect).toBe('5046509860389126442');
    expect(bot.sent[1].options).toBeUndefined();
  });

  it('respects each switch', async () => {
    const { src, texts } = setup({ reviewWaiting: false, taskFailed: false, ciFailed: false, taskMerged: false, regression: false });
    src.status('t1', 'human_review', 'completed');
    src.status('t2', 'error');
    src.app('main-run-failed', { projectId: 'p1', runId: 1, name: 'CI', url: 'u' });
    src.app('task-merged', { taskId: 't1', projectId: 'p1' });
    src.app('verification-regression', { taskId: 't2', projectId: 'p1' });
    expect(await texts()).toEqual([]);
  });

  it('sends nothing without a paired chat', async () => {
    const { src, texts } = setup({}, null);
    src.status('t1', 'human_review', 'completed');
    expect(await texts()).toEqual([]);
  });

  it('asks stage 2 for buttons per notification', async () => {
    const { src, texts, buttonsFor } = setup();
    src.status('t1', 'human_review', 'completed');
    await texts();
    expect(buttonsFor).toHaveBeenCalledWith(expect.objectContaining({ kind: 'reviewWaiting', taskId: 't1' }));
  });

  it('ignores plan and design reviews and stops by the user', async () => {
    const { src, texts } = setup();
    src.status('t1', 'human_review', 'plan_review');
    src.status('t2', 'human_review', 'design_review');
    src.status('t3', 'human_review', 'stopped');
    expect(await texts()).toEqual([]);
  });

  it('a deliverer can take a notification over (the review message), with the title and the reason', async () => {
    const deliver = vi.fn(async (n: { kind: string }) => n.kind === 'reviewWaiting');
    const { src, texts } = setup({}, 5, deliver as never);
    src.status('t1', 'human_review', 'qa_rejected');
    src.app('task-merged', { taskId: 't2', projectId: 'p1' });
    expect(await texts()).toEqual([expect.stringContaining('<b>Task t2</b>')]);
    expect(deliver).toHaveBeenCalledWith(expect.objectContaining({ kind: 'reviewWaiting', taskId: 't1', title: 'Task t1', reviewReason: 'qa_rejected' }), 5);
  });
});

describe('isReviewMessage', () => {
  it('is the review message (with Merge) only for tasks QA reviewed, not an architecture-only task', async () => {
    const { isReviewMessage } = await import('../review');
    expect(isReviewMessage({ kind: 'reviewWaiting', taskId: 't1', reviewReason: 'completed' })).toBe(true);
    expect(isReviewMessage({ kind: 'reviewWaiting', taskId: 't1', reviewReason: 'qa_rejected' })).toBe(true);
    expect(isReviewMessage({ kind: 'reviewWaiting', taskId: 't1', reviewReason: 'architecture_ready' })).toBe(false);
    expect(isReviewMessage({ kind: 'taskFailed', taskId: 't1' })).toBe(false);
  });
});
