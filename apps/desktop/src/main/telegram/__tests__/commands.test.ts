import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Task } from '../../../shared/types';
import { createQueuePause } from '../../ipc-handlers/task/task-control';
import { registerCommands, usageBetween, usageToday } from '../commands';
import { botText } from '../i18n';
import { createPairing } from '../pairing';
import { createRouter } from '../router';
import { createTelegramSettingsStore } from '../settings-store';
import { createFakeBot, OWNER, pressUpdate, textUpdate } from './fake-bot';

const t = (k: string, v?: Record<string, string | number>) => botText('en', k, v);
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tg-cmd-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const task = (id: string, status: Task['status'], over: Partial<Task> = {}) => ({ id, title: `Task ${id}`, status, ...over }) as Task;

function setup() {
  const bot = createFakeBot();
  const settings = createTelegramSettingsStore(dir);
  settings.update({ owner: OWNER });
  const router = createRouter({ api: () => bot.api, settings, pairing: createPairing(), t });
  const queuePause = createQueuePause();
  const running = ['a1', 'b1'];
  const stopTask = vi.fn();
  const tasks: Record<string, Task[]> = {
    p1: [task('a1', 'in_progress'), task('a2', 'queue'), task('a3', 'human_review', { reviewReason: 'completed' }), task('a4', 'done')],
    p2: [task('b1', 'ai_review'), task('b2', 'human_review', { reviewReason: 'qa_rejected', metadata: { archivedAt: 'x' } as never })],
  };
  registerCommands({
    api: () => bot.api,
    router,
    t,
    settings,
    projects: () => [
      { id: 'p1', name: 'Shop' },
      { id: 'p2', name: 'Blog' },
    ],
    tasks: (projectId) => tasks[projectId] ?? [],
    runningTaskIds: () => running,
    stopTask,
    queuePause,
    pendingQuestions: () => 2,
    usageToday: async () => ({ usd: 3.456, tokens: 120_000 }),
  });
  return { bot, router, settings, queuePause, stopTask };
}

describe('/status', () => {
  it('lists projects with running, queued and waiting tasks, the questions and today\'s spend', async () => {
    const { bot, router } = setup();
    await router.handleBatch([textUpdate('/status')]);
    const text = bot.last().text;
    expect(text).toMatch(/^📊 <b>Status<\/b>\n\n<b>Shop<\/b>/);
    expect(bot.chatActions).toEqual([{ chatId: 11, action: 'typing' }]);
    expect(text).toContain('Running: Task a1');
    expect(text).toContain('Queued: Task a2');
    expect(text).toContain('Waiting for you: Task a3');
    expect(text).toContain('Blog');
    expect(text).toContain('Running: Task b1');
    // archived tasks are left out
    expect(text).not.toContain('Task b2');
    expect(text).toContain('2 questions wait for an answer');
    expect(text).toContain("💰 Today's spend: <b>$3.46</b>");
  });

  it('says when the queue is paused', async () => {
    const { bot, router, queuePause } = setup();
    queuePause.set(true);
    await router.handleBatch([textUpdate('/status')]);
    expect(bot.last().text).toContain(t('status.queuePaused'));
  });
});

describe('/project', () => {
  it('offers the projects as buttons and remembers the choice', async () => {
    const { bot, router, settings } = setup();
    await router.handleBatch([textUpdate('/project')]);
    const buttons = bot.last().options?.buttons?.flat() ?? [];
    expect(buttons.map((b) => b.text)).toEqual(['Shop', 'Blog']);
    await router.handleBatch([pressUpdate(buttons[1].data, { messageId: bot.last().messageId })]);
    expect(settings.get().currentProjectId).toBe('p2');
    expect(bot.edits.at(-1)?.text).toBe(t('project.chosen', { name: 'Blog' }));
  });
});

describe('/stop_all and /resume', () => {
  it('asks first; Yes stops every running task the Stop way and pauses the queue', async () => {
    const { bot, router, stopTask, queuePause } = setup();
    await router.handleBatch([textUpdate('/stop_all')]);
    expect(stopTask).not.toHaveBeenCalled();
    const confirm = bot.last();
    expect(confirm.text).toBe(t('stopAll.confirmCount', { count: 2 }));
    expect(confirm.html).toBe(true);
    const [yes, no] = confirm.options?.buttons?.flat() ?? [];
    expect([yes.style, no.style]).toEqual(['danger', undefined]);
    await router.handleBatch([pressUpdate(yes.data, { messageId: confirm.messageId })]);
    expect(stopTask.mock.calls.map((c) => c[0])).toEqual(['a1', 'b1']);
    expect(queuePause.isPaused()).toBe(true);
    expect(bot.edits.at(-1)?.text).toBe(t('stopAll.done', { count: 2 }));
  });

  it('Cancel stops nothing, and the confirmation works once', async () => {
    const { bot, router, stopTask, queuePause } = setup();
    await router.handleBatch([textUpdate('/stop_all')]);
    const confirm = bot.last();
    const [yes, no] = confirm.options?.buttons?.flat() ?? [];
    await router.handleBatch([pressUpdate(no.data, { messageId: confirm.messageId })]);
    await router.handleBatch([pressUpdate(yes.data, { messageId: confirm.messageId })]);
    expect(stopTask).not.toHaveBeenCalled();
    expect(queuePause.isPaused()).toBe(false);
    expect(bot.edits.at(-1)?.text).toBe(t('stopAll.cancelled'));
  });

  it('/resume resumes a paused queue', async () => {
    const { bot, router, queuePause } = setup();
    await router.handleBatch([textUpdate('/resume')]);
    expect(bot.last().text).toBe(t('resume.notPaused'));
    queuePause.set(true);
    await router.handleBatch([textUpdate('/resume')]);
    expect(queuePause.isPaused()).toBe(false);
    expect(bot.last().text).toBe(t('resume.done'));
  });
});

describe('/help', () => {
  it('lists the commands', async () => {
    const { bot, router } = setup();
    await router.handleBatch([textUpdate('/help')]);
    expect(bot.last().text).toBe(t('help'));
  });
});

describe('usageToday', () => {
  it('sums the priced cost and tokens of today\'s sessions only', () => {
    const now = new Date(2026, 10, 16, 15, 0, 0).getTime();
    const today = new Date(2026, 10, 16, 9, 0, 0).toISOString();
    const yesterday = new Date(2026, 10, 15, 23, 0, 0).toISOString();
    const lines = [
      JSON.stringify({ at: today, agentType: 'coder', model: 'm', input: 100, output: 50, cacheRead: 0, cacheWrite: 0, costUsd: 1.5, billing: 'api' }),
      JSON.stringify({ at: yesterday, agentType: 'coder', model: 'm', input: 100, output: 50, cacheRead: 0, cacheWrite: 0, costUsd: 9, billing: 'api' }),
      'garbage',
    ].join('\n');
    expect(usageToday([lines], now)).toEqual({ usd: 1.5, tokens: 150 });
  });

  it('usageBetween: the sessions between two moments (the digest: since the last one)', () => {
    const line = (h: number, d: number, cost: number) => JSON.stringify({ at: new Date(2026, 10, d, h).toISOString(), agentType: 'coder', model: 'm', input: 10, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: cost, billing: 'api' });
    const ledger = [line(8, 15, 1), line(20, 15, 2), line(8, 16, 4)].join('\n');
    expect(usageBetween([ledger], new Date(2026, 10, 15, 9).getTime(), new Date(2026, 10, 16, 9).getTime())).toEqual({ usd: 6, tokens: 20 });
  });
});
