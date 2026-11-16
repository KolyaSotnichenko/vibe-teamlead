import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { BriefProposal } from '../../../shared/types';
import { botText } from '../i18n';
import { createPairing } from '../pairing';
import { createRouter } from '../router';
import { createTelegramSettingsStore } from '../settings-store';
import { LONG_TEXT, registerTaskCommands, type TaskActions, titleFromText } from '../tasks';
import { createFakeBot, OWNER, pressUpdate, textUpdate } from './fake-bot';

const t = (k: string, v?: Record<string, string | number>) => botText('en', k, v);
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tg-tasks-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const settle = () => new Promise((r) => setTimeout(r, 0));
const proposal = {
  briefId: 'b1',
  title: 'Shop',
  summary: 'An online shop.',
  epics: [{ key: 'E1' }, { key: 'E2' }],
  tasks: [{ key: 'T1', title: 'Catalog' }, { key: 'T2', title: 'Cart' }, { key: 'T3', title: 'Checkout' }],
  assumptions: [],
  openQuestions: [{ question: 'Which payments?', tasks: ['T3'] }],
} as unknown as BriefProposal;

function setup(projects = [{ id: 'p1', name: 'Shop' }], over: Partial<TaskActions> = {}) {
  const bot = createFakeBot();
  const settings = createTelegramSettingsStore(dir);
  settings.update({ owner: OWNER });
  const router = createRouter({ api: () => bot.api, settings, pairing: createPairing(), t });
  const actions: TaskActions = {
    create: vi.fn(async (_p: string, text: string) => ({ taskId: 'id1', title: text.slice(0, 20) })),
    start: vi.fn(async () => undefined),
    analyseBrief: vi.fn(async () => proposal),
    createBriefTasks: vi.fn(async () => ({ success: true, count: 3 })),
    ...over,
  };
  registerTaskCommands({ api: () => bot.api, router, t, settings, projects: () => projects, actions });
  const press = async (label: string, message = bot.last()) => {
    const lastEdit = [...bot.edits].reverse().find((e) => e.messageId === message.messageId);
    const rows = lastEdit ? lastEdit.buttons : message.options?.buttons;
    const button = (rows ?? []).flat().find((b) => b.text === label);
    if (!button) throw new Error(`no button ${label}`);
    await router.handleBatch([pressUpdate(button.data, { messageId: message.messageId })]);
    await settle();
  };
  const say = async (text: string) => {
    await router.handleBatch([textUpdate(text)]);
    await settle();
  };
  return { bot, router, settings, actions, press, say };
}

describe('/task', () => {
  it('creates a task in the current project in Planning, with Start', async () => {
    const { bot, actions, say, press, settings } = setup([{ id: 'p1', name: 'Shop' }, { id: 'p2', name: 'Blog' }]);
    settings.update({ currentProjectId: 'p2' });
    await say('/task Add a dark mode');
    expect(actions.create).toHaveBeenCalledWith('p2', 'Add a dark mode');
    const reply = bot.last();
    expect(reply.text).toContain(t('task.created', { project: 'Blog', title: 'Add a dark mode' }));
    await press(t('task.start'), reply);
    expect(actions.start).toHaveBeenCalledWith('id1', 'p2');
    expect(bot.edits.at(-1)?.text).toContain(t('task.started', { title: 'Add a dark mode' }));
  });

  it('one open project is the current one; several without a choice ask for /project', async () => {
    const one = setup();
    await one.say('/task Fix the footer');
    expect(one.actions.create).toHaveBeenCalledWith('p1', 'Fix the footer');
    const many = setup([{ id: 'p1', name: 'Shop' }, { id: 'p2', name: 'Blog' }]);
    await many.say('/task Fix the footer');
    expect(many.actions.create).not.toHaveBeenCalled();
    expect(many.bot.last().text).toBe(t('task.chooseProject'));
  });

  it('without text says how to use it', async () => {
    const { bot, say } = setup();
    await say('/task');
    expect(bot.last().text).toBe(t('task.usage'));
  });

  it('says why a task could not be created', async () => {
    const { bot, say } = setup(undefined, { create: vi.fn(async () => Promise.reject(new Error('disk full'))) });
    await say('/task Something');
    expect(bot.last().text).toBe(t('task.createFailed', { reason: 'disk full' }));
  });
});

describe('a plain message', () => {
  it('offers to create a task from it', async () => {
    const { bot, actions, say, press } = setup();
    await say('The login page is slow');
    expect(bot.last().text).toBe(t('task.offer'));
    expect(bot.last().options?.buttons?.flat().map((b) => b.text)).toEqual([t('task.createFromText')]);
    await press(t('task.createFromText'));
    expect(actions.create).toHaveBeenCalledWith('p1', 'The login page is slow');
  });

  it('long text also offers to analyse it as a brief; the proposal comes back with Create N tasks / Discard', async () => {
    const { bot, actions, say, press } = setup();
    const brief = 'x'.repeat(LONG_TEXT + 1);
    await say(brief);
    expect(bot.last().options?.buttons?.flat().map((b) => b.text)).toEqual([t('task.createFromText'), t('task.analyse')]);
    await press(t('task.analyse'));
    expect(actions.analyseBrief).toHaveBeenCalledWith('p1', brief);
    const summary = bot.last();
    expect(summary.text).toContain('Shop');
    expect(summary.text).toContain(t('brief.counts', { epics: 2, tasks: 3, questions: 1 }));
    expect(summary.text).toContain('• Catalog');
    expect(summary.options?.buttons?.flat().map((b) => b.text)).toEqual([t('brief.create', { count: 3 }), t('brief.discard')]);
    await press(t('brief.create', { count: 3 }), summary);
    expect(actions.createBriefTasks).toHaveBeenCalledWith('p1', 'b1', proposal.tasks);
    expect(bot.edits.at(-1)?.text).toContain(t('brief.created', { count: 3 }));
  });

  it('/task with long text asks too, and Discard drops a proposal', async () => {
    const { bot, actions, say, press } = setup();
    await say(`/task ${'y'.repeat(LONG_TEXT + 1)}`);
    expect(actions.create).not.toHaveBeenCalled();
    await press(t('task.analyse'));
    await press(t('brief.discard'));
    expect(actions.createBriefTasks).not.toHaveBeenCalled();
    expect(bot.edits.at(-1)?.text).toContain(t('brief.discarded'));
  });

  it('a failed analysis says why', async () => {
    const { bot, say, press } = setup(undefined, { analyseBrief: vi.fn(async () => Promise.reject(new Error('No API key'))) });
    await say('z'.repeat(LONG_TEXT + 1));
    await press(t('task.analyse'));
    expect(bot.last().text).toBe(t('brief.failed', { reason: 'No API key' }));
  });
});

describe('titleFromText', () => {
  it('a short first line is the title; otherwise the app writes one, as for an empty title in the window', () => {
    expect(titleFromText('  Add a dark mode \nwith a switch')).toBe('Add a dark mode');
    expect(titleFromText('x'.repeat(81))).toBe('');
  });
});
