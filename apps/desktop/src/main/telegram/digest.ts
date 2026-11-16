/**
 * The morning digest: once a local day, from the set time on (default 09:00), what merged since
 * the last digest, what waits for the owner, what runs or is queued, what failed, and what it
 * cost. If the app was closed at that time it comes at the next start the same day; the date it
 * was last sent is kept in telegram.json, so it never comes twice a day. The timer re-checks on
 * an interval and on wake (index.ts), so a sleeping computer does not lose it.
 */

import type { Task } from '../../shared/types';
import type { TelegramDigestSettings } from '../../shared/types/telegram';
import type { BotApi } from './bot-api';
import type { Translate } from './i18n';
import type { DigestState, TelegramSettingsStore } from './settings-store';

const DAY_MS = 24 * 60 * 60_000;
const LIST_LIMIT = 5;
const RUNNING = new Set(['in_progress', 'ai_review']);

/** The local date of a moment, YYYY-MM-DD */
export function localDate(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** True when today's digest is due: on, past the set time, not sent today. Pure. */
export function digestDue(digest: TelegramDigestSettings & Partial<DigestState>, now: number): boolean {
  if (!digest.enabled || digest.lastSentDate === localDate(now)) return false;
  const [hh, mm] = digest.time.split(':').map(Number);
  const d = new Date(now);
  return d.getHours() * 60 + d.getMinutes() >= hh * 60 + mm;
}

export interface DigestInput {
  projects: Array<{ id: string; name: string }>;
  tasks: (projectId: string) => Task[];
  /** Merged since this moment (epoch ms) */
  since: number;
  usage: { usd: number; tokens: number };
}

const names = (tasks: Task[]) => {
  const list = tasks.slice(0, LIST_LIMIT).map((task) => task.title || task.specId);
  return tasks.length > LIST_LIMIT ? `${list.join(', ')}, +${tasks.length - LIST_LIMIT}` : list.join(', ');
};

const time = (value: Date | string | undefined) => (value ? new Date(value).getTime() : 0);

/** The digest text. Pure. */
export function buildDigest(input: DigestInput, t: Translate): string {
  const blocks: string[] = [];
  for (const project of input.projects) {
    const tasks = input.tasks(project.id).filter((task) => !task.metadata?.archivedAt);
    const lines: Array<[string, Task[]]> = [
      ['digest.merged', tasks.filter((task) => task.status === 'done' && time(task.updatedAt) >= input.since)],
      ['digest.waiting', tasks.filter((task) => task.status === 'human_review' && task.reviewReason !== 'stopped' && task.reviewReason !== 'errors')],
      ['digest.running', tasks.filter((task) => RUNNING.has(task.status))],
      ['digest.queued', tasks.filter((task) => task.status === 'queue')],
      ['digest.failed', tasks.filter((task) => task.status === 'error' || (task.status === 'human_review' && task.reviewReason === 'errors'))],
    ];
    const filled = lines.filter(([, list]) => list.length).map(([key, list]) => t(key, { tasks: names(list) }));
    if (filled.length) blocks.push([t('digest.project', { name: project.name }), ...filled].join('\n'));
  }
  const spend = input.usage.usd > 0 ? t('digest.spend', { amount: input.usage.usd.toFixed(2) }) : t('digest.spendTokens', { tokens: input.usage.tokens.toLocaleString('en-US') });
  return [t('digest.title'), ...(blocks.length ? blocks : [t('digest.quiet')]), spend].join('\n\n');
}

export interface DigestDeps {
  api: () => BotApi | undefined;
  settings: TelegramSettingsStore;
  t: Translate;
  now?: () => number;
  projects: () => Array<{ id: string; name: string }>;
  tasks: (projectId: string) => Task[];
  /** Spend of the open projects between two moments */
  usageSince: (from: number, to: number) => Promise<{ usd: number; tokens: number }>;
  onError?: (error: unknown) => void;
}

export function createDigest(deps: DigestDeps) {
  const now = deps.now ?? Date.now;
  let running: Promise<void> | undefined;

  const run = async () => {
    const settings = deps.settings.get();
    const api = deps.api();
    const at = now();
    if (!settings.owner || !api || !digestDue(settings.digest, at)) return;
    const since = settings.digest.lastSentAt ?? at - DAY_MS;
    let usage = { usd: 0, tokens: 0 };
    try {
      usage = await deps.usageSince(since, at);
    } catch {
      // the spend is informational
    }
    const text = buildDigest({ projects: deps.projects(), tasks: deps.tasks, since, usage }, deps.t);
    try {
      await api.sendMessage(settings.owner.chatId, text);
    } catch (error) {
      // not sent: the next check tries again
      deps.onError?.(error);
      return;
    }
    deps.settings.update({ digest: { ...deps.settings.get().digest, lastSentDate: localDate(at), lastSentAt: at } });
  };

  return {
    /** Send today's digest when it is due (on start, on an interval, on wake). One at a time. */
    check(): Promise<void> {
      running ??= run().finally(() => {
        running = undefined;
      });
      return running;
    },
  };
}

export type Digest = ReturnType<typeof createDigest>;
