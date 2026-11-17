/**
 * Nothing secret goes to Telegram: every text the bot sends passes through here. Known key and
 * token shapes, `NAME_WITH_SECRET=value` pairs, private key blocks and the app's own secrets
 * (the bot token, the Claude key) are replaced with [redacted]. An HTML message is parsed
 * strictly (only supported tags with double-quoted attributes survive; anything else becomes
 * text), each raw text run and attribute value is redacted with its entities decoded, and the
 * whole message (tags, attributes, entities decoded) is checked again: a secret that markup
 * splits sends the message as redacted plain text instead. Texts are clipped to Telegram's limits
 * without breaking a tag. If Telegram can't parse a message it is sent once more as plain text;
 * a rejected message effect is dropped.
 */

import { type BotApi, type InlineButton, type MessageText, type SendOptions, TelegramApiError } from './bot-api';
import { decodeEntities, Html, MAX_CAPTION, MAX_MESSAGE, sanitizeHtml, text as textHtml, toPlain, truncateHtml } from './format';

export { MAX_MESSAGE };

const MASK = '[redacted]';
const MAX_BUTTON = 60;

const PATTERNS: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\bsk-ant-[A-Za-z0-9_-]{10,}/g,
  /\bsk-[A-Za-z0-9_-]{20,}/g,
  /\b(?:ghp|gho|ghs|ghu|ghr)_[A-Za-z0-9]{20,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bglpat-[A-Za-z0-9_-]{16,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bxox[abposr]-[A-Za-z0-9-]{10,}/g,
  /\b\d{6,12}:[A-Za-z0-9_-]{30,}\b/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
];

/** NAME=value where the name says it is secret: the value goes */
const SECRET_ASSIGNMENT = /\b([A-Za-z0-9_]*(?:SECRET|TOKEN|PASSWORD|PASSWD|API_KEY|APIKEY|PRIVATE_KEY|ACCESS_KEY|CREDENTIAL)[A-Za-z0-9_]*)\s*[=:]\s*(?!\[redacted\])("[^"\n]*"|'[^'\n]*'|[^\s,;]+)/gi;

export function redactSecrets(text: string, known: Array<string | undefined> = []): string {
  let out = text;
  for (const value of known) {
    if (value && value.length >= 6) out = out.split(value).join(MASK);
  }
  for (const pattern of PATTERNS) out = out.replace(pattern, MASK);
  out = out.replace(SECRET_ASSIGNMENT, (_m, name: string) => `${name}=${MASK}`);
  return out;
}

export function clipMessage(text: string, max = MAX_MESSAGE): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/** An HTML message redacted: supported tags only, every text run and attribute value redacted raw */
export function redactHtml(value: Html, known: Array<string | undefined> = []): Html {
  const out = sanitizeHtml(value.value, (raw) => redactSecrets(raw, known));
  // The whole message, markup included and entities decoded, and its visible text: a secret
  // split by a tag or an entity is found here, and the message goes as redacted text
  const whole = decodeEntities(out.value);
  const visible = toPlain(out);
  if (redactSecrets(whole, known) !== whole || redactSecrets(visible, known) !== visible) return textHtml(redactSecrets(visible, known));
  return out;
}

const PARSE_ERROR = /can't parse entities/i;

/** The client every part of the bot uses: texts, captions and button labels redacted and clipped */
export function safeApi(api: BotApi, secrets: () => Array<string | undefined>, warn?: (message: string) => void): BotApi {
  const plainClean = (value: string, max: number) => clipMessage(redactSecrets(value, secrets()), max);
  const clean = (value: MessageText, max = MAX_MESSAGE): MessageText =>
    value instanceof Html ? truncateHtml(redactHtml(value, secrets()), max) : plainClean(value, max);
  const cleanButtons = (rows: InlineButton[][] | undefined) => rows?.map((row) => row.map((b) => ({ ...b, text: plainClean(b.text, MAX_BUTTON) })));
  const cleanOptions = (options: SendOptions | undefined): SendOptions | undefined =>
    options ? { ...options, buttons: cleanButtons(options.buttons), placeholder: options.placeholder ? plainClean(options.placeholder, 64) : undefined } : undefined;

  /**
   * One call, retried: as plain text when Telegram can't parse the HTML (once), without the
   * effect when Telegram rejects it. Any other error goes to the caller.
   */
  const attempt = async <T>(value: MessageText, effect: boolean, call: (value: MessageText, effect: boolean) => Promise<T>): Promise<T> => {
    let current = value;
    let withEffect = effect;
    for (;;) {
      try {
        return await call(current, withEffect);
      } catch (error) {
        if (!(error instanceof TelegramApiError) || error.kind !== 'other') throw error;
        if (current instanceof Html && PARSE_ERROR.test(error.message)) {
          current = toPlain(current);
          warn?.("[Telegram] Telegram couldn't parse a message's HTML; it was sent as plain text");
          continue;
        }
        if (withEffect) {
          withEffect = false;
          continue;
        }
        throw error;
      }
    }
  };

  return {
    getMe: () => api.getMe(),
    getUpdates: (offset, signal, timeoutSeconds) => api.getUpdates(offset, signal, timeoutSeconds),
    sendMessage: (chatId, value, options) => {
      const { effect, ...rest } = cleanOptions(options) ?? {};
      return attempt(clean(value), !!effect, (body, withEffect) =>
        api.sendMessage(chatId, body, options ? { ...rest, ...(withEffect ? { effect } : {}) } : undefined),
      );
    },
    editMessageText: (chatId, messageId, value, options) =>
      attempt(clean(value), false, (body) => api.editMessageText(chatId, messageId, body, options ? { buttons: cleanButtons(options.buttons) } : undefined)),
    answerCallbackQuery: (id, value) => api.answerCallbackQuery(id, value ? plainClean(value, 200) : undefined),
    sendPhoto: (chatId, photo, caption, options) => {
      const cleaned = cleanOptions(options);
      if (!caption) return api.sendPhoto(chatId, photo, undefined, cleaned);
      return attempt(clean(caption, MAX_CAPTION), false, (body) => api.sendPhoto(chatId, photo, body, cleaned));
    },
    sendMediaGroup: (chatId, photos, caption) => {
      if (!caption) return api.sendMediaGroup(chatId, photos);
      return attempt(clean(caption, MAX_CAPTION), false, (body) => api.sendMediaGroup(chatId, photos, body));
    },
    sendChatAction: (chatId, action) => api.sendChatAction(chatId, action),
  };
}
