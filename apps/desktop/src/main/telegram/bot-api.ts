/**
 * A minimal Telegram Bot API client over `fetch` (main process, any OS).
 *
 * Only what the bot uses. Errors are classified so the poller can react: a bad token (401)
 * stops it, another poller on the same token (409) and a rate limit (429, `retry_after`) wait,
 * a network error backs off. The token is part of the URL only; it never appears in an error.
 */

export type FetchLike = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: unknown; signal?: AbortSignal }) => Promise<Response>;

export interface TelegramUser {
  id: number;
  is_bot?: boolean;
  first_name?: string;
  username?: string;
}

export interface TelegramChat {
  id: number;
  type?: string;
}

export interface TelegramMessage {
  message_id: number;
  date: number;
  chat: TelegramChat;
  from?: TelegramUser;
  text?: string;
  reply_to_message?: TelegramMessage;
}

export interface TelegramCallbackQuery {
  id: string;
  from: TelegramUser;
  data?: string;
  message?: TelegramMessage;
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
}

export interface InlineButton {
  text: string;
  /** Callback data (≤ 64 bytes): the router's short id */
  data: string;
}

export interface SendOptions {
  /** Rows of inline buttons */
  buttons?: InlineButton[][];
  /** Ask Telegram to open a reply to this message (text answers) */
  forceReply?: boolean;
  /** A short hint shown in the reply field */
  placeholder?: string;
}

export type TelegramErrorKind = 'unauthorized' | 'conflict' | 'rate_limited' | 'network' | 'other';

export class TelegramApiError extends Error {
  constructor(
    readonly kind: TelegramErrorKind,
    message: string,
    readonly retryAfter?: number,
  ) {
    super(message);
    this.name = 'TelegramApiError';
  }
}

/** Seconds Telegram holds a getUpdates request open waiting for an update */
export const LONG_POLL_SECONDS = 50;
export const ALLOWED_UPDATES = ['message', 'callback_query'] as const;

export interface BotApi {
  getMe(): Promise<TelegramUser>;
  getUpdates(offset: number | undefined, signal?: AbortSignal): Promise<TelegramUpdate[]>;
  sendMessage(chatId: number, text: string, options?: SendOptions): Promise<TelegramMessage>;
  /** Replaces the text; the buttons go unless new ones are given */
  editMessageText(chatId: number, messageId: number, text: string, options?: { buttons?: InlineButton[][] }): Promise<void>;
  answerCallbackQuery(callbackQueryId: string, text?: string): Promise<void>;
  sendPhoto(chatId: number, photo: Buffer, caption?: string, options?: SendOptions): Promise<TelegramMessage>;
  sendMediaGroup(chatId: number, photos: Buffer[], caption?: string): Promise<TelegramMessage[]>;
}

const API_ROOT = 'https://api.telegram.org';

function markup(options: SendOptions | undefined): Record<string, unknown> | undefined {
  if (options?.buttons) {
    return { inline_keyboard: options.buttons.map((row) => row.map((b) => ({ text: b.text, callback_data: b.data }))) };
  }
  if (options?.forceReply) {
    return { force_reply: true, ...(options.placeholder ? { input_field_placeholder: options.placeholder } : {}) };
  }
  return undefined;
}

function classify(status: number, body: { error_code?: number; description?: string; parameters?: { retry_after?: number } } | undefined): TelegramApiError {
  const code = body?.error_code ?? status;
  const description = body?.description ?? `HTTP ${status}`;
  if (code === 401 || code === 404) return new TelegramApiError('unauthorized', description);
  if (code === 409) return new TelegramApiError('conflict', description);
  if (code === 429) return new TelegramApiError('rate_limited', description, body?.parameters?.retry_after ?? 5);
  return new TelegramApiError('other', description);
}

export function createBotApi(token: string, fetchImpl: FetchLike = fetch as FetchLike): BotApi {
  const base = `${API_ROOT}/bot${token}`;

  async function send<T>(method: string, body: unknown, signal?: AbortSignal): Promise<T> {
    let response: Response;
    const isForm = typeof FormData !== 'undefined' && body instanceof FormData;
    try {
      response = await fetchImpl(`${base}/${method}`, {
        method: 'POST',
        ...(isForm ? {} : { headers: { 'content-type': 'application/json' } }),
        body: isForm ? body : JSON.stringify(body ?? {}),
        signal,
      });
    } catch (error) {
      if ((error as { name?: string })?.name === 'AbortError') throw error;
      // The message of a fetch error can quote the URL, which holds the token
      throw new TelegramApiError('network', 'Telegram is not reachable');
    }
    let parsed: { ok?: boolean; result?: T; error_code?: number; description?: string; parameters?: { retry_after?: number } } | undefined;
    try {
      parsed = (await response.json()) as typeof parsed;
    } catch {
      parsed = undefined;
    }
    if (!response.ok || !parsed?.ok) throw classify(response.status, parsed);
    return parsed.result as T;
  }

  const photoForm = (chatId: number, fields: Record<string, string>, files: Array<{ name: string; data: Buffer }>): FormData => {
    const form = new FormData();
    form.append('chat_id', String(chatId));
    for (const [key, value] of Object.entries(fields)) form.append(key, value);
    for (const file of files) form.append(file.name, new Blob([new Uint8Array(file.data)], { type: 'image/png' }), `${file.name}.png`);
    return form;
  };

  return {
    getMe: () => send<TelegramUser>('getMe', {}),
    getUpdates: (offset, signal) =>
      send<TelegramUpdate[]>('getUpdates', { ...(offset !== undefined ? { offset } : {}), timeout: LONG_POLL_SECONDS, allowed_updates: [...ALLOWED_UPDATES] }, signal),
    sendMessage: (chatId, text, options) => {
      const reply_markup = markup(options);
      return send<TelegramMessage>('sendMessage', { chat_id: chatId, text, ...(reply_markup ? { reply_markup } : {}) });
    },
    editMessageText: async (chatId, messageId, text, options) => {
      await send('editMessageText', {
        chat_id: chatId,
        message_id: messageId,
        text,
        reply_markup: markup({ buttons: options?.buttons ?? [] }),
      });
    },
    answerCallbackQuery: async (id, text) => {
      await send('answerCallbackQuery', { callback_query_id: id, ...(text ? { text } : {}) });
    },
    sendPhoto: (chatId, photo, caption, options) => {
      const reply_markup = markup(options);
      const fields: Record<string, string> = {};
      if (caption) fields.caption = caption;
      if (reply_markup) fields.reply_markup = JSON.stringify(reply_markup);
      return send<TelegramMessage>('sendPhoto', photoForm(chatId, fields, [{ name: 'photo', data: photo }]));
    },
    sendMediaGroup: (chatId, photos, caption) => {
      const media = photos.map((_, i) => ({ type: 'photo', media: `attach://p${i}`, ...(i === 0 && caption ? { caption } : {}) }));
      return send<TelegramMessage[]>('sendMediaGroup', photoForm(chatId, { media: JSON.stringify(media) }, photos.map((data, i) => ({ name: `p${i}`, data }))));
    },
  };
}
