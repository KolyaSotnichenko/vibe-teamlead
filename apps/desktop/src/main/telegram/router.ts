/**
 * Routes updates from Telegram: pairing (`/start <code>`), commands, button presses and text
 * replies (force-reply). Only the paired owner's private chat is served; everything from anyone
 * else is ignored without a reply.
 *
 * Buttons carry a short random id; the action lives here, in memory, for 12 hours (and dies
 * with the app, so a press from before a restart is "expired"). Commands and presses older than
 * 15 minutes are dropped, and the owner is told once what was skipped: a stale "Stop all" never
 * fires. Telegram gives no time for a press, so presses are taken as stale when they come in the
 * first batch after the bot could not read the chat for over 15 minutes.
 *
 * Stage 2 adds commands, buttons and a plain-text handler; the router itself stays the same.
 */

import { randomBytes } from 'node:crypto';

import type { BotApi, InlineButton, TelegramCallbackQuery, TelegramMessage, TelegramUpdate } from './bot-api';
import type { Translate } from './i18n';
import type { Pairing } from './pairing';
import type { TelegramSettingsStore } from './settings-store';

export const STALE_MS = 15 * 60_000;
export const BUTTON_TTL_MS = 12 * 60 * 60_000;

export interface CommandContext {
  chatId: number;
  args: string;
  message: TelegramMessage;
}

export interface PressContext {
  chatId: number;
  messageId?: number;
  callbackId: string;
}

export interface ReplyContext {
  chatId: number;
  message: TelegramMessage;
}

/** A press handler may return a short text Telegram shows as a toast */
export type ButtonAction = (ctx: PressContext) => Promise<string | void> | string | void;
export type CommandHandler = (ctx: CommandContext) => Promise<void> | void;
export type ReplyHandler = (text: string, ctx: ReplyContext) => Promise<void> | void;

export interface RouterDeps {
  /** The current client (it changes with the token) */
  api: () => BotApi | undefined;
  settings: TelegramSettingsStore;
  pairing: Pairing;
  t: Translate;
  now?: () => number;
  onPaired?: () => void;
  onError?: (error: unknown) => void;
}

export interface Router {
  handleBatch(updates: TelegramUpdate[], options?: { offlineForMs?: number }): Promise<void>;
  command(name: string, handler: CommandHandler): void;
  /** A button whose press runs the action; `group` lets related buttons be forgotten together */
  button(text: string, action: ButtonAction, group?: string): InlineButton;
  forgetGroup(group: string): void;
  /** The next reply to this bot message goes to the handler (once) */
  awaitReply(messageId: number, handler: ReplyHandler): void;
  /** Plain text that is no command and no reply (stage 2: a new task from a message) */
  onText(handler: ((text: string, ctx: ReplyContext) => Promise<boolean> | boolean) | undefined): void;
  /** Forget every button and pending reply (unpair, token change) */
  reset(): void;
}

interface ButtonEntry {
  action: ButtonAction;
  createdAt: number;
  group?: string;
}

export function createRouter(deps: RouterDeps): Router {
  const now = deps.now ?? Date.now;
  const commands = new Map<string, CommandHandler>();
  const buttons = new Map<string, ButtonEntry>();
  const replies = new Map<number, { handler: ReplyHandler; createdAt: number }>();
  let textHandler: ((text: string, ctx: ReplyContext) => Promise<boolean> | boolean) | undefined;

  const isOwnerMessage = (message: TelegramMessage): boolean => {
    const owner = deps.settings.get().owner;
    return !!owner && message.from?.id === owner.userId && message.chat.id === owner.chatId && message.chat.type !== 'group' && message.chat.type !== 'supergroup' && message.chat.type !== 'channel';
  };

  const send = async (chatId: number, text: string) => {
    await deps.api()?.sendMessage(chatId, text);
  };

  const prune = () => {
    const limit = now() - BUTTON_TTL_MS;
    for (const [id, entry] of buttons) if (entry.createdAt < limit) buttons.delete(id);
    for (const [id, entry] of replies) if (entry.createdAt < limit) replies.delete(id);
  };

  const parseCommand = (text: string): { name: string; args: string } | undefined => {
    const match = text.match(/^\/([a-zA-Z0-9_]+)(?:@\S+)?(?:\s+([\s\S]*))?$/);
    return match ? { name: match[1].toLowerCase(), args: (match[2] ?? '').trim() } : undefined;
  };

  /** True when the message paired its sender */
  const tryPairing = async (message: TelegramMessage): Promise<boolean> => {
    const command = message.text ? parseCommand(message.text) : undefined;
    if (command?.name !== 'start' || !command.args || !message.from) return false;
    if (message.chat.id !== message.from.id) return false;
    if (!deps.pairing.consume(command.args)) return false;
    const name = message.from.username ? `@${message.from.username}` : message.from.first_name;
    deps.settings.update({ owner: { userId: message.from.id, chatId: message.chat.id, ...(name ? { name } : {}) } });
    buttons.clear();
    replies.clear();
    await send(message.chat.id, deps.t('paired'));
    deps.onPaired?.();
    return true;
  };

  const handleMessage = async (message: TelegramMessage, skipped: string[]) => {
    if (await tryPairing(message)) return;
    if (!isOwnerMessage(message) || !message.text) return;
    const chatId = message.chat.id;
    const replyTo = message.reply_to_message?.message_id;
    if (replyTo !== undefined && replies.has(replyTo)) {
      const entry = replies.get(replyTo);
      replies.delete(replyTo);
      await entry?.handler(message.text, { chatId, message });
      return;
    }
    const command = parseCommand(message.text);
    if (command) {
      if (now() - message.date * 1000 > STALE_MS) {
        skipped.push(`/${command.name}`);
        return;
      }
      const handler = commands.get(command.name);
      if (handler) await handler({ chatId, args: command.args, message });
      else if (command.name !== 'start') await send(chatId, deps.t('unknown'));
      else await send(chatId, deps.t('help'));
      return;
    }
    if (textHandler && (await textHandler(message.text, { chatId, message }))) return;
    await send(chatId, deps.t('unknown'));
  };

  const handlePress = async (query: TelegramCallbackQuery, stale: boolean, skippedPresses: { count: number }) => {
    const owner = deps.settings.get().owner;
    if (!owner || query.from.id !== owner.userId) return;
    const api = deps.api();
    if (stale) {
      skippedPresses.count++;
      await api?.answerCallbackQuery(query.id, deps.t('expired'));
      return;
    }
    const entry = query.data ? buttons.get(query.data) : undefined;
    if (!entry || now() - entry.createdAt > BUTTON_TTL_MS) {
      if (query.data) buttons.delete(query.data);
      await api?.answerCallbackQuery(query.id, deps.t('expired'));
      return;
    }
    let toast: string | void = undefined;
    try {
      toast = await entry.action({ chatId: query.message?.chat.id ?? owner.chatId, messageId: query.message?.message_id, callbackId: query.id });
    } finally {
      await api?.answerCallbackQuery(query.id, toast || undefined);
    }
  };

  return {
    async handleBatch(updates, options = {}) {
      prune();
      const skipped: string[] = [];
      const skippedPresses = { count: 0 };
      const stalePresses = (options.offlineForMs ?? 0) > STALE_MS;
      for (const update of updates) {
        try {
          if (update.message) await handleMessage(update.message, skipped);
          else if (update.callback_query) await handlePress(update.callback_query, stalePresses, skippedPresses);
        } catch (error) {
          deps.onError?.(error);
        }
      }
      const owner = deps.settings.get().owner;
      if (owner && (skipped.length || skippedPresses.count)) {
        const items = [...skipped, ...(skippedPresses.count ? [deps.t('skippedPress', { count: skippedPresses.count })] : [])];
        try {
          await send(owner.chatId, deps.t('skipped', { items: items.join(', ') }));
        } catch (error) {
          deps.onError?.(error);
        }
      }
    },
    command(name, handler) {
      commands.set(name.toLowerCase(), handler);
    },
    button(text, action, group) {
      prune();
      let id = randomBytes(9).toString('base64url');
      while (buttons.has(id)) id = randomBytes(9).toString('base64url');
      buttons.set(id, { action, createdAt: now(), group });
      return { text, data: id };
    },
    forgetGroup(group) {
      for (const [id, entry] of buttons) if (entry.group === group) buttons.delete(id);
    },
    awaitReply(messageId, handler) {
      replies.set(messageId, { handler, createdAt: now() });
    },
    onText(handler) {
      textHandler = handler;
    },
    reset() {
      buttons.clear();
      replies.clear();
    },
  };
}
