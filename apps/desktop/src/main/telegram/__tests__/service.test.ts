import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { PendingAgentQuestion } from '../../../shared/types/agent-questions';
import type { TelegramStatus } from '../../../shared/types/telegram';
import { createQueuePause } from '../../ipc-handlers/task/task-control';
import { type BotApi, TelegramApiError, type TelegramUpdate } from '../bot-api';
import { createTelegramService, type TelegramServiceDeps } from '../service';
import { createTelegramSettingsStore } from '../settings-store';
import { createTokenStore } from '../token-store';
import { createFakeBot, OWNER, textUpdate } from './fake-bot';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tg-svc-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const plain = { encrypt: (s: string) => `x${s}`, decrypt: (s: string) => s.slice(1) };

/** A fake bot whose getUpdates waits like a long poll until updates are pushed or it is aborted */
function longPollBot(validToken = 'good:token') {
  const fake = createFakeBot();
  const inbox: TelegramUpdate[] = [];
  let wake: (() => void) | undefined;
  const tokens: string[] = [];
  const polls = { count: 0 };
  const createApi = (token: string): BotApi => {
    tokens.push(token);
    return {
      ...fake.api,
      getMe: async () => {
        if (token !== validToken) throw new TelegramApiError('unauthorized', 'Unauthorized');
        return { id: 1, username: 'my_bot' };
      },
      getUpdates: (_offset, signal, timeoutSeconds) => {
        polls.count++;
        if (token !== validToken) return Promise.reject(new TelegramApiError('unauthorized', 'Unauthorized'));
        if (inbox.length) return Promise.resolve(inbox.splice(0));
        if (timeoutSeconds === 0) return Promise.resolve([]);
        return new Promise((resolve, reject) => {
          wake = () => resolve(inbox.splice(0));
          signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
        });
      },
    };
  };
  return { fake, createApi, tokens, polls, push: (u: TelegramUpdate) => {
      inbox.push(u);
      wake?.();
    },
  };
}

function setup(bot = longPollBot(), extra: Partial<TelegramServiceDeps> = {}) {
  let questionListener: ((e: { type: 'asked'; question: PendingAgentQuestion }) => void) | undefined;
  const statuses: TelegramStatus[] = [];
  const settings = createTelegramSettingsStore(dir);
  const tokens = createTokenStore(dir, plain);
  const service = createTelegramService({
    tokens,
    settings,
    createApi: bot.createApi,
    language: () => 'en',
    secrets: () => ['sk-ant-secret-claude-key'],
    questions: {
      pending: () => [],
      onEvent: (l) => {
        questionListener = l as typeof questionListener;
        return () => undefined;
      },
      answer: () => ({ success: true }),
    },
    notifierSources: { onStatusChange: () => () => undefined, onAppEvent: () => () => undefined, onBaseFailures: () => () => undefined },
    task: () => ({ title: 'Add login' }),
    projectName: () => 'Shop',
    commands: {
      projects: () => [],
      tasks: () => [],
      runningTaskIds: () => [],
      stopTask: vi.fn(),
      queuePause: createQueuePause(),
      pendingQuestions: () => 0,
      usageToday: async () => ({ usd: 0, tokens: 0 }),
    },
    onStatus: (s) => void statuses.push(s),
    pollerSleep: async () => undefined,
    ...extra,
  });
  return { service, settings, tokens, statuses, bot, ask: (q: PendingAgentQuestion) => questionListener?.({ type: 'asked', question: q }) };
}

describe('telegram service', () => {
  it('reports and saves the morning digest settings; a bad time is refused', async () => {
    const { service, settings } = setup();
    await service.start();
    expect(service.status().digest).toEqual({ enabled: true, time: '09:00' });
    settings.update({ digest: { enabled: true, time: '09:00', lastSentDate: '2026-11-16' } });
    expect(service.setDigest({ enabled: false, time: '07:45' }).digest).toEqual({ enabled: false, time: '07:45' });
    // the date it was last sent stays: changing the time does not send it twice
    expect(settings.get().digest).toEqual({ enabled: false, time: '07:45', lastSentDate: '2026-11-16' });
    expect(service.setDigest({ enabled: true, time: '7pm' }).digest).toEqual({ enabled: true, time: '07:45' });
    await service.stop();
  });

  it("sends today's digest at start when the app was closed at its time, once", async () => {
    const bot = longPollBot();
    const now = new Date(2026, 10, 16, 11, 0).getTime();
    const usageSince = vi.fn(async () => ({ usd: 2, tokens: 1 }));
    const { service, settings, tokens } = setup(bot, { now: () => now, digest: { tasks: () => [], usageSince } });
    tokens.save('good:token');
    settings.update({ owner: OWNER });
    await service.start();
    await service.checkDigest();
    await service.checkDigest();
    const digests = bot.fake.sent.filter((m) => m.text.startsWith('Good morning'));
    expect(digests).toHaveLength(1);
    expect(settings.get().digest.lastSentAt).toBe(now);
    await service.stop();
  });

  it('wires review, design approval and /task: a review status gets the review message, a design its album, /task a task', async () => {
    const bot = longPollBot();
    type Listener = (taskId: string, status: never, reason?: never) => void;
    const listeners: Listener[] = [];
    const create = vi.fn(async () => ({ taskId: 'n1', title: 'Dark mode' }));
    const albums: number[] = [];
    bot.fake.api.sendMediaGroup = async (_c, photos) => {
      albums.push(photos.length);
      return [];
    };
    const { service, settings, tokens } = setup(bot, {
      notifierSources: {
        onStatusChange: (l) => {
          listeners.push(l as Listener);
          return () => undefined;
        },
        onAppEvent: () => () => undefined,
        onBaseFailures: () => () => undefined,
      },
      review: {
        details: async () => ({ criteria: { passed: 1, total: 1 } }),
        screenshots: async () => [],
        state: () => ({ status: 'human_review', reviewReason: 'completed' }),
        merge: async () => ({ kind: 'merged' }),
        sendBack: async () => ({ success: true }),
      },
      design: {
        waiting: () => ({ stage: 'design' }),
        frames: async () => [Buffer.from('a'), Buffer.from('b')],
        approve: async () => ({ success: true }),
        comment: async () => ({ success: true }),
      },
      taskActions: { create, start: async () => 'started' as const, analyseBrief: vi.fn(), createBriefTasks: vi.fn() },
      commands: {
        projects: () => [{ id: 'p1', name: 'Shop' }],
        tasks: () => [],
        runningTaskIds: () => [],
        stopTask: vi.fn(),
        queuePause: createQueuePause(),
        pendingQuestions: () => 0,
        usageToday: async () => ({ usd: 0, tokens: 0 }),
      },
    });
    tokens.save('good:token');
    settings.update({ owner: OWNER });
    await service.start();
    await vi.waitFor(() => expect(service.status().connection).toBe('connected'));
    for (const l of listeners) l('t1', 'human_review' as never, 'completed' as never);
    await vi.waitFor(() => expect(bot.fake.sent.some((m) => m.text.includes('Acceptance criteria: 1 of 1 pass'))).toBe(true));
    const review = bot.fake.sent.find((m) => m.text.includes('Acceptance criteria'));
    expect(review?.options?.buttons?.flat().map((b) => b.text)).toContain('Merge');
    for (const l of listeners) l('t2', 'human_review' as never, 'design_review' as never);
    await vi.waitFor(() => expect(bot.fake.sent.some((m) => m.text.includes('The design waits for your approval'))).toBe(true));
    expect(albums).toEqual([2]);
    bot.push(textUpdate('/task Dark mode', { from: OWNER.userId }));
    await vi.waitFor(() => expect(create).toHaveBeenCalledWith('p1', 'Dark mode'));
    await service.stop();
  });

  it('does not poll and talks to nobody without a token', async () => {
    const { service, bot } = setup();
    await service.start();
    expect(service.status().connection).toBe('not_set');
    expect(bot.tokens).toEqual([]);
    expect(bot.polls.count).toBe(0);
    await service.stop();
  });

  it('refuses a token Telegram does not accept, without saving it', async () => {
    const { service, tokens } = setup();
    await service.start();
    expect(await service.saveToken('bad:token')).toEqual({ success: false, error: 'bad_token' });
    expect(tokens.load()).toBeUndefined();
    expect(await service.saveToken('  ')).toEqual({ success: false, error: 'empty_token' });
    await service.stop();
  });

  it('saves a good token, polls, pairs with the code and unpairs', async () => {
    const { service, settings, bot } = setup();
    await service.start();
    const saved = await service.saveToken('good:token');
    expect(saved.success).toBe(true);
    expect(saved.data?.botUsername).toBe('my_bot');
    await vi.waitFor(() => expect(service.status().connection).toBe('connected'));
    const code = service.newPairingCode().pairingCode ?? '';
    expect(code).toMatch(/^[A-Z0-9]{8}$/);
    bot.push(textUpdate(`/start ${code}`, { from: OWNER.userId }));
    await vi.waitFor(() => expect(settings.get().owner?.userId).toBe(OWNER.userId));
    expect(service.status().pairingCode).toBeUndefined();
    expect(service.unpair().owner).toBeUndefined();
    await service.stop();
  });

  it('a saved token starts polling on the next start; removing it stops the loop', async () => {
    const first = setup();
    await first.service.start();
    await first.service.saveToken('good:token');
    await first.service.stop();
    const second = setup(first.bot);
    await second.service.start();
    await vi.waitFor(() => expect(second.service.status().connection).toBe('connected'));
    const status = await second.service.removeToken();
    expect(status.connection).toBe('not_set');
    expect(second.tokens.load()).toBeUndefined();
    await second.service.stop();
  });

  it('reports a token revoked later as an error and stops polling', async () => {
    const bot = longPollBot('good:token');
    const { service, tokens } = setup(bot);
    tokens.save('revoked:token');
    await service.start();
    await vi.waitFor(() => expect(service.status()).toMatchObject({ connection: 'error', error: 'bad_token' }));
    const polls = bot.polls.count;
    await new Promise((r) => setTimeout(r, 20));
    expect(bot.polls.count).toBe(polls);
    await service.stop();
  });

  it('never sends the token or the Claude key to the chat', async () => {
    const { service, settings, bot, ask } = setup();
    settings.update({ owner: OWNER });
    await service.start();
    await service.saveToken('good:token');
    ask({
      questionId: 'q',
      taskId: 't',
      agentType: 'coder',
      askedAt: 1,
      questions: [{ question: 'Use good:token or sk-ant-secret-claude-key?', header: 'Key', multiSelect: false, options: [] }],
    });
    await vi.waitFor(() => expect(bot.fake.sent.length).toBe(1));
    expect(bot.fake.sent[0].text).not.toContain('good:token');
    expect(bot.fake.sent[0].text).not.toContain('sk-ant-secret-claude-key');
    await service.stop();
  });
});
