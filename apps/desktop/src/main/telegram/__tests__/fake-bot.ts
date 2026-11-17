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
  const chatActions: Array<{ chatId: number; action: string }> = [];
  /** Every attempt to send or edit, failed ones too */
  const attempts: Array<{ method: string; text: string; options?: unknown }> = [];
  /** Return an error to make an attempt fail (as Telegram would answer) */
  let reject: ((method: string, text: string, options?: unknown) => Error | undefined) | undefined;
  const edits: Array<{ chatId: number; messageId: number; text: string; buttons?: InlineButton[][] }> = [];
  const callbackAnswers: Array<{ id: string; text?: string }> = [];
  const updates: TelegramUpdate[][] = [];
  const api: BotApi = {
    getMe: async () => ({ id: 1, is_bot: true, username: 'test_bot' }),
    getUpdates: async () => updates.shift() ?? [],
    sendMessage: async (chatId, text, options) => {
      attempts.push({ method: 'sendMessage', text, options });
      const error = reject?.('sendMessage', text, options);
      if (error) throw error;
      const message: TelegramMessage = { message_id: nextId++, date: 0, chat: { id: chatId }, text };
      sent.push({ chatId, messageId: message.message_id, text, options });
      return message;
    },
    editMessageText: async (chatId, messageId, text, options) => {
      attempts.push({ method: 'editMessageText', text, options });
      const error = reject?.('editMessageText', text, options);
      if (error) throw error;
      edits.push({ chatId, messageId, text, buttons: options?.buttons });
    },
    answerCallbackQuery: async (id, text) => {
      callbackAnswers.push({ id, text });
    },
    sendPhoto: async (chatId) => ({ message_id: nextId++, date: 0, chat: { id: chatId } }),
    sendMediaGroup: async () => [],
    sendChatAction: async (chatId, action) => {
      chatActions.push({ chatId, action });
    },
  };
  return {
    api,
    sent,
    edits,
    callbackAnswers,
    updates,
    chatActions,
    attempts,
    rejectWith(fn: typeof reject) {
      reject = fn;
    },
    last: () => sent[sent.length - 1],
  };
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
