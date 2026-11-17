import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { PendingAgentQuestion } from '../../../shared/types/agent-questions';
import { botText } from '../i18n';
import { createPairing } from '../pairing';
import { createQuestionFlow } from '../questions';
import { createRouter } from '../router';
import { createTelegramSettingsStore } from '../settings-store';
import { createFakeBot, OWNER, pressUpdate, textUpdate } from './fake-bot';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tg-q-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const t = (k: string, v?: Record<string, string | number>) => botText('en', k, v);

function pending(over: Partial<PendingAgentQuestion> = {}): PendingAgentQuestion {
  return {
    questionId: 'q1',
    taskId: 't1',
    projectId: 'p1',
    agentType: 'coder',
    askedAt: 1,
    questions: [
      {
        question: 'Which database?',
        header: 'DB',
        multiSelect: false,
        options: [
          { label: 'SQLite', description: 'Simple' },
          { label: 'Postgres (Recommended)', description: 'Scales' },
        ],
      },
    ],
    ...over,
  };
}

function setup(enabled = true) {
  const bot = createFakeBot();
  const settings = createTelegramSettingsStore(dir);
  settings.update({ owner: OWNER });
  const router = createRouter({ api: () => bot.api, settings, pairing: createPairing(), t });
  let waiting = true;
  const answer = vi.fn((_id: string, _answers: Record<string, string> | null) => (waiting ? { success: true } : { success: false, error: 'gone' }));
  const flow = createQuestionFlow({
    api: () => bot.api,
    router,
    chatId: () => settings.get().owner?.chatId,
    t,
    answer,
    taskTitle: () => 'Add login',
    enabled: () => enabled,
  });
  const buttonsOf = (index = bot.sent.length - 1) => bot.sent[index].options?.buttons ?? [];
  return { bot, router, flow, answer, buttonsOf, setWaiting: (w: boolean) => (waiting = w) };
}

describe('agent questions in Telegram', () => {
  it('sends the question with its options as buttons, the recommended one first and marked, and Other…', async () => {
    const { bot, flow, buttonsOf } = setup();
    await flow.asked(pending());
    expect(bot.sent).toHaveLength(1);
    expect(bot.sent[0].html).toBe(true);
    expect(bot.sent[0].text).toBe(
      '❓ <b>Agent asks</b> · Add login\n\n<b>Which database?</b>\n' +
        '<blockquote expandable><b>Postgres (Recommended)</b>: Scales\n<b>SQLite</b>: Simple</blockquote>',
    );
    expect(buttonsOf().map((row) => [row[0].text, row[0].style])).toEqual([
      ['★ Postgres (Recommended)', 'primary'],
      ['SQLite', undefined],
      ['Other…', undefined],
    ]);
  });

  it('a press answers through the shared path and edits the message', async () => {
    const { bot, router, flow, answer, buttonsOf } = setup();
    await flow.asked(pending());
    const sqlite = buttonsOf()[1][0];
    await router.handleBatch([pressUpdate(sqlite.data, { messageId: bot.sent[0].messageId })]);
    expect(answer).toHaveBeenCalledWith('q1', { 'Which database?': 'SQLite' });
    expect(bot.edits[0]).toMatchObject({ messageId: bot.sent[0].messageId, text: expect.stringContaining('✅ Answered: <b>SQLite</b>') });
    expect(bot.last().text).toBe(t('question.answeredHere'));
  });

  it('Other… asks for a text reply (force-reply) and sends it as the answer', async () => {
    const { bot, router, flow, answer, buttonsOf } = setup();
    await flow.asked(pending());
    const other = buttonsOf()[2][0];
    await router.handleBatch([pressUpdate(other.data)]);
    const prompt = bot.last();
    expect(prompt.options?.forceReply).toBe(true);
    expect(prompt.text).toContain('Which database?');
    await router.handleBatch([textUpdate('MySQL, please', { replyTo: prompt.messageId })]);
    expect(answer).toHaveBeenCalledWith('q1', { 'Which database?': 'MySQL, please' });
  });

  it('several questions come one by one and are sent back together', async () => {
    const { bot, router, flow, answer, buttonsOf } = setup();
    const two = pending({
      questions: [
        { question: 'Which database?', header: 'DB', multiSelect: false, options: [{ label: 'SQLite', description: '' }] },
        { question: 'Which auth?', header: 'Auth', multiSelect: false, options: [{ label: 'Email', description: '' }] },
      ],
    });
    await flow.asked(two);
    expect(bot.sent).toHaveLength(1);
    expect(bot.sent[0].text).toContain('Question 1 of 2');
    await router.handleBatch([pressUpdate(buttonsOf(0)[0][0].data)]);
    expect(answer).not.toHaveBeenCalled();
    expect(bot.sent[1].text).toContain('Question 2 of 2');
    await router.handleBatch([pressUpdate(buttonsOf(1)[0][0].data)]);
    expect(answer).toHaveBeenCalledWith('q1', { 'Which database?': 'SQLite', 'Which auth?': 'Email' });
  });

  it('multi-select: toggles, then Done sends the chosen labels', async () => {
    const { bot, router, flow, answer, buttonsOf } = setup();
    await flow.asked(
      pending({
        questions: [
          {
            question: 'Which sign-ins?',
            header: 'Auth',
            multiSelect: true,
            options: [
              { label: 'Email', description: '' },
              { label: 'GitHub', description: '' },
            ],
          },
        ],
      }),
    );
    const email = buttonsOf()[0][0];
    await router.handleBatch([pressUpdate(email.data, { messageId: bot.sent[0].messageId })]);
    expect(bot.edits.at(-1)?.buttons?.[0][0].text).toBe('✓ Email');
    // The message got new buttons; the old ones no longer work
    await router.handleBatch([pressUpdate(email.data, { messageId: bot.sent[0].messageId })]);
    expect(bot.callbackAnswers.at(-1)?.text).toBe(t('expired'));
    const github = bot.edits.at(-1)?.buttons?.[1][0] ?? { data: '' };
    await router.handleBatch([pressUpdate(github.data, { messageId: bot.sent[0].messageId })]);
    const done = bot.edits.at(-1)?.buttons?.flat().find((b) => b.text === 'Done');
    expect(done).toBeDefined();
    await router.handleBatch([pressUpdate(done?.data ?? '', { messageId: bot.sent[0].messageId })]);
    expect(answer).toHaveBeenCalledWith('q1', { 'Which sign-ins?': 'Email, GitHub' });
  });

  it('answered on the computer first: the chat message says so and its buttons stop working', async () => {
    const { bot, router, flow, answer, buttonsOf } = setup();
    await flow.asked(pending());
    const button = buttonsOf()[0][0];
    flow.resolved(pending(), 'answered');
    await vi.waitFor(() => expect(bot.edits.at(-1)?.text).toContain(t('question.answeredOnComputer')));
    await router.handleBatch([pressUpdate(button.data)]);
    expect(answer).not.toHaveBeenCalled();
  });

  it('the agent stopped waiting: the message says so', async () => {
    const { bot, flow } = setup();
    await flow.asked(pending());
    flow.resolved(pending(), 'dropped');
    await vi.waitFor(() => expect(bot.edits.at(-1)?.text).toContain(t('question.dismissed')));
  });

  it('refuses politely when the question no longer waits', async () => {
    const { bot, router, flow, buttonsOf, setWaiting } = setup();
    await flow.asked(pending());
    setWaiting(false);
    await router.handleBatch([pressUpdate(buttonsOf()[1][0].data)]);
    expect(bot.last().text).toBe(t('question.noLongerWaiting'));
  });

  it('sends nothing when the switch is off or nobody is paired', async () => {
    const { bot, flow } = setup(false);
    await flow.asked(pending());
    expect(bot.sent).toEqual([]);
  });
});
