/**
 * Nothing secret goes to Telegram: every text the bot sends passes through here. Known key and
 * token shapes, `NAME_WITH_SECRET=value` pairs, private key blocks and the app's own secrets
 * (the bot token, the Claude key) are replaced with [redacted]. Texts are clipped to Telegram's
 * limit.
 */

import type { BotApi, InlineButton, SendOptions } from './bot-api';

const MASK = '[redacted]';
/** Telegram's limit for a message text */
export const MAX_MESSAGE = 4096;
const MAX_CAPTION = 1024;
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

/** The client every part of the bot uses: texts, captions and button labels redacted and clipped */
export function safeApi(api: BotApi, secrets: () => Array<string | undefined>): BotApi {
  const clean = (text: string, max = MAX_MESSAGE) => clipMessage(redactSecrets(text, secrets()), max);
  const cleanButtons = (rows: InlineButton[][] | undefined) => rows?.map((row) => row.map((b) => ({ ...b, text: clean(b.text, MAX_BUTTON) })));
  const cleanOptions = (options: SendOptions | undefined): SendOptions | undefined =>
    options ? { ...options, buttons: cleanButtons(options.buttons), placeholder: options.placeholder ? clean(options.placeholder, 64) : undefined } : undefined;
  return {
    getMe: () => api.getMe(),
    getUpdates: (offset, signal) => api.getUpdates(offset, signal),
    sendMessage: (chatId, text, options) => api.sendMessage(chatId, clean(text), cleanOptions(options)),
    editMessageText: (chatId, messageId, text, options) => api.editMessageText(chatId, messageId, clean(text), options ? { buttons: cleanButtons(options.buttons) } : undefined),
    answerCallbackQuery: (id, text) => api.answerCallbackQuery(id, text ? clean(text, 200) : undefined),
    sendPhoto: (chatId, photo, caption, options) => api.sendPhoto(chatId, photo, caption ? clean(caption, MAX_CAPTION) : undefined, cleanOptions(options)),
    sendMediaGroup: (chatId, photos, caption) => api.sendMediaGroup(chatId, photos, caption ? clean(caption, MAX_CAPTION) : undefined),
  };
}
