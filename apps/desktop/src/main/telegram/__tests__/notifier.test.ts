import { describe, expect, it, vi } from 'vitest';

import type { TelegramNotificationSettings } from '../../../shared/types/telegram';
import { botText } from '../i18n';
import { createNotifier, type NotifierSources } from '../notifier';
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

function setup(notifications: Partial<TelegramNotificationSettings> = {}, chatId: number | null = 5) {
  const bot = createFakeBot();
  const src = fakeSources();
  const buttonsFor = vi.fn(() => undefined);
  const notifier = createNotifier({
    api: () => bot.api,
    chatId: () => chatId ?? undefined,
    t,
    notifications: () => ({ ...DEFAULT_NOTIFICATIONS, ...notifications }),
    task: (taskId) => ({ title: `Task ${taskId}`, projectName: 'Shop' }),
    projectName: () => 'Shop',
    buttonsFor,
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
    expect(sent[0]).toContain(t('notify.review', { task: 'Task t1' }));
    expect(sent[0]).toContain('Project: Shop');
    expect(sent[1]).toContain(t('notify.reviewRejected', { task: 'Task t2' }));
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
    expect(sent[0]).toContain(t('notify.failed', { task: 'Task t1' }));
    expect(sent[1]).toContain(t('notify.errored', { task: 'Task t2' }));
    expect(sent[2]).toContain(t('notify.stuck', { task: 'Task t3' }));
  });

  it('CI failed on main, merged, regression and broken main', async () => {
    const { src, texts } = setup();
    src.app('main-run-failed', { projectId: 'p1', runId: 1, name: 'CI', url: 'https://github.com/o/r/actions/runs/1' });
    src.app('task-merged', { taskId: 't1', projectId: 'p1' });
    src.app('verification-regression', { taskId: 't2', projectId: 'p1' });
    src.base('t3', { baseCommit: 'abc' }, 'p1');
    src.base('t4', { baseCommit: 'abc' }, 'p1');
    const sent = await texts();
    expect(sent).toHaveLength(4);
    expect(sent[0]).toContain('CI failed on main in Shop: CI');
    expect(sent[0]).toContain('https://github.com/o/r/actions/runs/1');
    expect(sent[1]).toContain(t('notify.merged', { task: 'Task t1' }));
    expect(sent[2]).toContain(t('notify.regression', { task: 'Task t2' }));
    expect(sent[3]).toBe(t('notify.baseBroken', { project: 'Shop' }));
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
});
