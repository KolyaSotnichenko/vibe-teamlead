/**
 * Nothing secret goes to Telegram: every text the bot sends passes through here. Known key and
 * token shapes, `NAME_WITH_SECRET=value` pairs, private key blocks and the app's own secrets
 * (the bot token, the Claude key) are replaced with [redacted]. Messages and captions are HTML:
 * the redaction runs on their raw text (entities unescaped), then the text is escaped again, so
 * escaping can never split a secret. Texts are clipped to Telegram's limits without breaking a
 * tag. If Telegram can't parse a message it is sent once more as plain text; a rejected message
 * effect is dropped.
 */

import { type BotApi, type EditOptions, type InlineButton, type SendOptions, TelegramApiError } from './bot-api';
import { esc, MAX_CAPTION, MAX_MESSAGE, toPlain, truncateHtml } from './format';

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
const SECRET_ASSIGNMENT = /\b([A-Za-z0-9_]*(?:SECRET|TOKEN|PASSWORD|PASSWD|API_KEY|APIKEY|PRIVATE_KEY|ACCESS_KEY|CREDENTIAL)[A-Za-z0-9_]*)\s*[=:]\s*("[^"\n]*"|'[^'\n]*'|[^\s,;]+)/gi;

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

/** Redacts the raw text of an HTML message: each text run and each attribute value, unescaped first */
export function redactHtml(html: string, known: Array<string | undefined> = []): string {
  const clean = (escaped: string) => esc(redactSecrets(toPlain(escaped), known));
  const out = html
    .split(/(<[^>]*>)/)
    .map((part) => (part.startsWith('<') ? part.replace(/"([^"]*)"/g, (_m, value: string) => `"${clean(value)}"`) : part && clean(part)))
    .join('');
  // A secret split by tags: the message goes without its formatting rather than with the secret
  const text = toPlain(out);
  const redacted = redactSecrets(text, known);
  return redacted === text ? out : esc(redacted);
}

const PARSE_ERROR = /can't parse entities/i;

/** The client every part of the bot uses: texts, captions and button labels redacted and clipped */
export function safeApi(api: BotApi, secrets: () => Array<string | undefined>, warn?: (message: string) => void): BotApi {
  const plainClean = (text: string, max: number) => clipMessage(redactSecrets(text, secrets()), max);
  const html = (text: string, max = MAX_MESSAGE) => truncateHtml(redactHtml(text, secrets()), max);
  const cleanButtons = (rows: InlineButton[][] | undefined) => rows?.map((row) => row.map((b) => ({ ...b, text: plainClean(b.text, MAX_BUTTON) })));
  const cleanOptions = (options: SendOptions | undefined): SendOptions | undefined =>
    options ? { ...options, buttons: cleanButtons(options.buttons), placeholder: options.placeholder ? plainClean(options.placeholder, 64) : undefined } : undefined;

  /**
   * One call, retried: as plain text when Telegram can't parse the HTML (once), without the
   * effect when Telegram rejects it. Any other error goes to the caller.
   */
  const attempt = async <T>(text: string, effect: boolean, call: (text: string, plain: boolean, effect: boolean) => Promise<T>): Promise<T> => {
    let plain = false;
    let withEffect = effect;
    for (;;) {
      try {
        return await call(plain ? toPlain(text) : text, plain, withEffect);
      } catch (error) {
        if (!(error instanceof TelegramApiError) || error.kind !== 'other') throw error;
        if (!plain && PARSE_ERROR.test(error.message)) {
          plain = true;
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
    sendMessage: (chatId, text, options) => {
      const cleaned = cleanOptions(options);
      return attempt(html(text), !!options?.effect, (body, plain, effect) => {
        const { effect: _effect, ...rest } = cleaned ?? {};
        return api.sendMessage(chatId, body, { ...rest, ...(effect ? { effect: options?.effect } : {}), ...(plain ? { plain } : {}) });
      });
    },
    editMessageText: (chatId, messageId, text, options) =>
      attempt(html(text), false, (body, plain) => {
        const edit: EditOptions | undefined = options || plain ? { ...(options ? { buttons: cleanButtons(options.buttons) } : {}), ...(plain ? { plain } : {}) } : undefined;
        return api.editMessageText(chatId, messageId, body, edit);
      }),
    answerCallbackQuery: (id, text) => api.answerCallbackQuery(id, text ? plainClean(text, 200) : undefined),
    sendPhoto: (chatId, photo, caption, options) => {
      const cleaned = cleanOptions(options);
      if (!caption) return api.sendPhoto(chatId, photo, undefined, cleaned);
      return attempt(html(caption, MAX_CAPTION), false, (body, plain) => api.sendPhoto(chatId, photo, body, { ...cleaned, ...(plain ? { plain } : {}) }));
    },
    sendMediaGroup: (chatId, photos, caption) => {
      if (!caption) return api.sendMediaGroup(chatId, photos);
      return attempt(html(caption, MAX_CAPTION), false, (body, plain) => api.sendMediaGroup(chatId, photos, body, plain ? { plain } : undefined));
    },
    sendChatAction: (chatId, action) => api.sendChatAction(chatId, action),
  };
}
