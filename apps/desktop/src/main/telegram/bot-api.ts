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

/** Telegram colours a button by its style: success green, danger red, primary blue */
export type ButtonStyle = 'success' | 'danger' | 'primary';

export interface InlineButton {
  text: string;
  /** Callback data (≤ 64 bytes): the router's short id */
  data: string;
  style?: ButtonStyle;
}

export interface SendOptions {
  /** Rows of inline buttons */
  buttons?: InlineButton[][];
  /** Ask Telegram to open a reply to this message (text answers) */
  forceReply?: boolean;
  /** A short hint shown in the reply field */
  placeholder?: string;
  /** A message effect (private chats only), e.g. 🎉 */
  effect?: string;
  /** Plain text instead of HTML (the fallback when Telegram can't parse it) */
  plain?: boolean;
}

export interface EditOptions {
  buttons?: InlineButton[][];
  plain?: boolean;
}

export type ChatAction = 'typing' | 'upload_photo';

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
  /** Long poll; `timeoutSeconds` 0 answers at once (the first call, to know the connection works) */
  getUpdates(offset: number | undefined, signal?: AbortSignal, timeoutSeconds?: number): Promise<TelegramUpdate[]>;
  /** Texts and captions are HTML (parse_mode "HTML") unless `plain` */
  sendMessage(chatId: number, text: string, options?: SendOptions): Promise<TelegramMessage>;
  /** Replaces the text; the buttons go unless new ones are given */
  editMessageText(chatId: number, messageId: number, text: string, options?: EditOptions): Promise<void>;
  answerCallbackQuery(callbackQueryId: string, text?: string): Promise<void>;
  sendPhoto(chatId: number, photo: Buffer, caption?: string, options?: SendOptions): Promise<TelegramMessage>;
  sendMediaGroup(chatId: number, photos: Buffer[], caption?: string, options?: { plain?: boolean }): Promise<TelegramMessage[]>;
  /** "typing…" in the chat while a command works (Telegram shows it ≤ 5 s) */
  sendChatAction(chatId: number, action: ChatAction): Promise<void>;
}

const API_ROOT = 'https://api.telegram.org';

function markup(options: SendOptions | undefined): Record<string, unknown> | undefined {
  if (options?.buttons) {
    return { inline_keyboard: options.buttons.map((row) => row.map((b) => ({ text: b.text, callback_data: b.data, ...(b.style ? { style: b.style } : {}) }))) };
  }
  if (options?.forceReply) {
    return { force_reply: true, ...(options.placeholder ? { input_field_placeholder: options.placeholder } : {}) };
  }
  return undefined;
}

/** HTML, no link previews */
const formatting = (plain: boolean | undefined) => ({ ...(plain ? {} : { parse_mode: 'HTML' }), link_preview_options: { is_disabled: true } });

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
    for (const file of files) {
      const jpeg = file.data[0] === 0xff && file.data[1] === 0xd8;
      form.append(file.name, new Blob([new Uint8Array(file.data)], { type: jpeg ? 'image/jpeg' : 'image/png' }), `${file.name}.${jpeg ? 'jpg' : 'png'}`);
    }
    return form;
  };

  return {
    getMe: () => send<TelegramUser>('getMe', {}),
    getUpdates: (offset, signal, timeoutSeconds = LONG_POLL_SECONDS) =>
      send<TelegramUpdate[]>('getUpdates', { ...(offset !== undefined ? { offset } : {}), timeout: timeoutSeconds, allowed_updates: [...ALLOWED_UPDATES] }, signal),
    sendMessage: (chatId, text, options) => {
      const reply_markup = markup(options);
      return send<TelegramMessage>('sendMessage', {
        chat_id: chatId,
        text,
        ...formatting(options?.plain),
        ...(options?.effect ? { message_effect_id: options.effect } : {}),
        ...(reply_markup ? { reply_markup } : {}),
      });
    },
    editMessageText: async (chatId, messageId, text, options) => {
      await send('editMessageText', {
        chat_id: chatId,
        message_id: messageId,
        text,
        ...formatting(options?.plain),
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
      if (caption && !options?.plain) fields.parse_mode = 'HTML';
      if (reply_markup) fields.reply_markup = JSON.stringify(reply_markup);
      return send<TelegramMessage>('sendPhoto', photoForm(chatId, fields, [{ name: 'photo', data: photo }]));
    },
    sendMediaGroup: (chatId, photos, caption, options) => {
      const media = photos.map((_, i) => ({
        type: 'photo',
        media: `attach://p${i}`,
        ...(i === 0 && caption ? { caption, ...(options?.plain ? {} : { parse_mode: 'HTML' }) } : {}),
      }));
      return send<TelegramMessage[]>('sendMediaGroup', photoForm(chatId, { media: JSON.stringify(media) }, photos.map((data, i) => ({ name: `p${i}`, data }))));
    },
    sendChatAction: async (chatId, action) => {
      await send('sendChatAction', { chat_id: chatId, action });
    },
  };
}
