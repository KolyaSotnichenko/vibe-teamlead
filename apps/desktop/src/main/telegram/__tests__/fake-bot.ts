/** A fake Bot API for tests: records what the bot sends; never touches the network. */
import type { BotApi, InlineButton, SendOptions, TelegramMessage, TelegramUpdate } from '../bot-api';

export interface Sent {
  chatId: number;
  messageId: number;
  text: string;
  options?: SendOptions;
}

export function createFakeBot() {
  let nextId = 100;
  const sent: Sent[] = [];
  const edits: Array<{ chatId: number; messageId: number; text: string; buttons?: InlineButton[][] }> = [];
  const callbackAnswers: Array<{ id: string; text?: string }> = [];
  const updates: TelegramUpdate[][] = [];
  const api: BotApi = {
    getMe: async () => ({ id: 1, is_bot: true, username: 'test_bot' }),
    getUpdates: async () => updates.shift() ?? [],
    sendMessage: async (chatId, text, options) => {
      const message: TelegramMessage = { message_id: nextId++, date: 0, chat: { id: chatId }, text };
      sent.push({ chatId, messageId: message.message_id, text, options });
      return message;
    },
    editMessageText: async (chatId, messageId, text, options) => {
      edits.push({ chatId, messageId, text, buttons: options?.buttons });
    },
    answerCallbackQuery: async (id, text) => {
      callbackAnswers.push({ id, text });
    },
    sendPhoto: async (chatId) => ({ message_id: nextId++, date: 0, chat: { id: chatId } }),
    sendMediaGroup: async () => [],
  };
  return { api, sent, edits, callbackAnswers, updates, last: () => sent[sent.length - 1] };
}

let updateId = 1;

export const OWNER = { userId: 11, chatId: 11 };

export function textUpdate(text: string, opts: { from?: number; chat?: number; date?: number; replyTo?: number } = {}): TelegramUpdate {
  const from = opts.from ?? OWNER.userId;
  return {
    update_id: updateId++,
    message: {
      message_id: updateId + 1000,
      date: opts.date ?? Math.floor(Date.now() / 1000),
      chat: { id: opts.chat ?? from, type: 'private' },
      from: { id: from, first_name: 'Owner', username: 'owner' },
      text,
      ...(opts.replyTo ? { reply_to_message: { message_id: opts.replyTo, date: 0, chat: { id: opts.chat ?? from } } } : {}),
    },
  };
}

export function pressUpdate(data: string, opts: { from?: number; messageId?: number } = {}): TelegramUpdate {
  const from = opts.from ?? OWNER.userId;
  return {
    update_id: updateId++,
    callback_query: {
      id: `cb${updateId}`,
      from: { id: from },
      data,
      message: { message_id: opts.messageId ?? 1, date: 0, chat: { id: from } },
    },
  };
}
