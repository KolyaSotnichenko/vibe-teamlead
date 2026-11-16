/**
 * The Telegram bot of this app: token, pairing, the poll loop and the parts that talk
 * (router, question flow, notifier, commands), started and stopped together. Off until a token
 * is saved; nothing talks to Telegram without one. Electron-free: the main-process wiring
 * (index.ts) passes the real event sources and functions, tests pass fakes.
 */

import type { AgentAnswers, PendingAgentQuestion } from '../../shared/types/agent-questions';
import type { Task } from '../../shared/types';
import type { TelegramDigestSettings, TelegramErrorReason, TelegramNotificationSettings, TelegramResult, TelegramStatus } from '../../shared/types/telegram';
import { type BotApi, TelegramApiError } from './bot-api';
import { registerCommands, type CommandDeps } from './commands';
import { createDigest } from './digest';
import { translatorFor } from './i18n';
import { createNotifier, type NotifierSources } from './notifier';
import { createPairing, type Pairing } from './pairing';
import { createPoller, type Poller, type PollerState } from './poller';
import { createQuestionFlow } from './questions';
import { safeApi } from './redact';
import { createRouter, type Router } from './router';
import type { TelegramSettingsStore } from './settings-store';
import type { TokenStore } from './token-store';

export interface QuestionSource {
  pending: () => PendingAgentQuestion[];
  onEvent: (
    listener: (
      event: { type: 'asked'; question: PendingAgentQuestion } | { type: 'resolved'; question: PendingAgentQuestion; how: 'answered' | 'dismissed' | 'cancelled' | 'dropped' },
    ) => void,
  ) => () => void;
  answer: (questionId: string, answers: AgentAnswers | null) => { success: boolean; error?: string };
}

export interface TelegramServiceDeps {
  tokens: TokenStore;
  settings: TelegramSettingsStore;
  createApi: (token: string) => BotApi;
  language: () => string;
  /** Values that must never reach the chat besides the bot token (the Claude key) */
  secrets?: () => Array<string | undefined>;
  questions: QuestionSource;
  notifierSources: NotifierSources;
  task: (taskId: string, projectId?: string) => { title: string; projectName?: string; projectId?: string } | undefined;
  projectName: (projectId: string) => string | undefined;
  commands: Omit<CommandDeps, 'api' | 'router' | 't' | 'settings'>;
  /** The morning digest's sources (off without them) */
  digest?: {
    tasks: (projectId: string) => Task[];
    usageSince: (from: number, to: number) => Promise<{ usd: number; tokens: number }>;
  };
  /** How often the digest timer looks at the clock (a sleeping computer misses ticks; wake calls checkDigest) */
  digestCheckMs?: number;
  onStatus?: (status: TelegramStatus) => void;
  log?: { warn: (...args: unknown[]) => void };
  now?: () => number;
  pollerSleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

const reasonOf = (error: unknown): TelegramErrorReason => {
  if (!(error instanceof TelegramApiError)) return 'unknown';
  return ({ unauthorized: 'bad_token', conflict: 'conflict', rate_limited: 'rate_limited', network: 'network', other: 'unknown' } as const)[error.kind];
};

export function createTelegramService(deps: TelegramServiceDeps) {
  const t = translatorFor(deps.language);
  const pairing: Pairing = createPairing({ now: deps.now });
  let token: string | undefined;
  let api: BotApi | undefined;
  let poller: Poller | undefined;
  let pollerState: PollerState | undefined;
  let botUsername: string | undefined;
  const offs: Array<() => void> = [];

  const secrets = () => [token, ...(deps.secrets?.() ?? [])];
  const currentApi = () => api;
  const warn = (error: unknown) => deps.log?.warn('[Telegram]', error instanceof Error ? error.message : String(error));

  const status = (): TelegramStatus => {
    const settings = deps.settings.get();
    const code = pairing.current();
    const connection = !token ? 'not_set' : (pollerState?.connection ?? 'connecting');
    return {
      connection,
      ...(token && pollerState?.error && connection === 'error' ? { error: pollerState.error } : {}),
      ...(botUsername ? { botUsername } : {}),
      ...(settings.owner ? { owner: settings.owner } : {}),
      ...(token && code ? { pairingCode: code.code, pairingExpiresAt: code.expiresAt } : {}),
      notifications: settings.notifications,
      digest: { enabled: settings.digest.enabled, time: settings.digest.time },
    };
  };
  const broadcast = () => deps.onStatus?.(status());

  const router: Router = createRouter({
    api: currentApi,
    settings: deps.settings,
    pairing,
    t,
    now: deps.now,
    onPaired: broadcast,
    onError: warn,
  });

  const questions = createQuestionFlow({
    api: currentApi,
    router,
    chatId: () => deps.settings.get().owner?.chatId,
    t,
    answer: deps.questions.answer,
    taskTitle: (taskId, projectId) => deps.task(taskId, projectId)?.title ?? taskId,
    enabled: () => deps.settings.get().notifications.agentQuestion,
  });

  const notifier = createNotifier({
    api: currentApi,
    chatId: () => deps.settings.get().owner?.chatId,
    t,
    notifications: () => deps.settings.get().notifications,
    task: deps.task,
    projectName: deps.projectName,
    onError: warn,
  });

  registerCommands({ ...deps.commands, api: currentApi, router, t, settings: deps.settings });

  const digest = deps.digest
    ? createDigest({ api: currentApi, settings: deps.settings, t, now: deps.now, projects: deps.commands.projects, tasks: deps.digest.tasks, usageSince: deps.digest.usageSince, onError: warn })
    : undefined;
  let digestTimer: ReturnType<typeof setInterval> | undefined;
  const checkDigest = () => (api && digest ? digest.check().catch(warn) : Promise.resolve());

  const stopPolling = async () => {
    const running = poller;
    poller = undefined;
    await running?.stop();
  };

  const startPolling = async () => {
    await stopPolling();
    if (!token) return;
    api = safeApi(deps.createApi(token), secrets);
    pollerState = { connection: 'connecting' };
    const own = createPoller({
      api,
      now: deps.now,
      sleep: deps.pollerSleep,
      onBatch: (updates, info) => router.handleBatch(updates, info),
      onState: (state) => {
        if (poller !== own) return;
        pollerState = state;
        broadcast();
      },
    });
    poller = own;
    await own.start();
    // The bot's name for Settings (the poller reports a bad token itself)
    api
      .getMe()
      .then((me) => {
        botUsername = me.username;
        broadcast();
      })
      .catch(() => undefined);
  };

  return {
    /** Load the saved token and listen to the app; polls only when a token is saved */
    async start(): Promise<void> {
      token = deps.tokens.load();
      offs.push(
        deps.questions.onEvent((event) => {
          if (!api) return;
          if (event.type === 'asked') void questions.asked(event.question).catch(warn);
          else questions.resolved(event.question, event.how);
        }),
      );
      notifier.start(deps.notifierSources);
      await startPolling();
      broadcast();
      if (digest) {
        digestTimer = setInterval(() => void checkDigest(), deps.digestCheckMs ?? 60_000);
        digestTimer.unref?.();
        // Not sent at its time because the app was closed: now, the same day
        void checkDigest();
      }
    },
    async stop(): Promise<void> {
      if (digestTimer) clearInterval(digestTimer);
      digestTimer = undefined;
      for (const off of offs.splice(0)) off();
      notifier.stop();
      await stopPolling();
    },
    status,
    async testToken(candidate: string): Promise<TelegramResult<{ username?: string }>> {
      const value = candidate.trim();
      if (!value) return { success: false, error: 'empty_token' };
      try {
        const me = await deps.createApi(value).getMe();
        return { success: true, data: { username: me.username } };
      } catch (error) {
        return { success: false, error: reasonOf(error) };
      }
    },
    async saveToken(candidate: string): Promise<TelegramResult<TelegramStatus>> {
      const value = candidate.trim();
      if (!value) return { success: false, error: 'empty_token' };
      let username: string | undefined;
      try {
        username = (await deps.createApi(value).getMe()).username;
      } catch (error) {
        return { success: false, error: reasonOf(error) };
      }
      const changed = value !== token;
      deps.tokens.save(value);
      token = value;
      botUsername = username;
      if (changed) {
        // Another bot: buttons and asks of the old one mean nothing here
        router.reset();
        questions.reset();
      }
      await startPolling();
      broadcast();
      return { success: true, data: status() };
    },
    async removeToken(): Promise<TelegramStatus> {
      await stopPolling();
      deps.tokens.clear();
      token = undefined;
      api = undefined;
      botUsername = undefined;
      pollerState = undefined;
      pairing.clear();
      router.reset();
      questions.reset();
      broadcast();
      return status();
    },
    newPairingCode(): TelegramStatus {
      if (token) pairing.issue();
      broadcast();
      return status();
    },
    unpair(): TelegramStatus {
      deps.settings.update({ owner: undefined });
      router.reset();
      questions.reset();
      broadcast();
      return status();
    },
    setDigest(value: TelegramDigestSettings): TelegramStatus {
      const current = deps.settings.get().digest;
      const time = typeof value.time === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(value.time) ? value.time : current.time;
      deps.settings.update({ digest: { ...current, enabled: value.enabled === true, time } });
      broadcast();
      void checkDigest();
      return status();
    },
    /** Look at the digest now (the computer woke up) */
    checkDigest,
    setNotifications(notifications: TelegramNotificationSettings): TelegramStatus {
      deps.settings.update({ notifications });
      broadcast();
      return status();
    },
  };
}

export type TelegramService = ReturnType<typeof createTelegramService>;
