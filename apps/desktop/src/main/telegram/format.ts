/**
 * Telegram HTML (parse_mode "HTML"): every message the bot sends is HTML. Text from tasks,
 * agents and logs goes through `esc()` (redaction happens on the raw text first, in safeApi);
 * the i18n strings are trusted HTML and their values are escaped by `htmlText()`. Only the tags
 * Telegram supports are produced here. Truncation keeps the tags whole and closes them.
 */

import type { BotVars, Translate } from './i18n';

/** Telegram's limits, counted after parsing (tags don't count, an entity is one character) */
export const MAX_MESSAGE = 4096;
export const MAX_CAPTION = 1024;

export function esc(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export const b = (text: string) => `<b>${esc(text)}</b>`;
export const i = (text: string) => `<i>${esc(text)}</i>`;
export const code = (text: string) => `<code>${esc(text)}</code>`;

export function pre(text: string, lang?: string): string {
  const language = lang?.replace(/[^\w+-]/g, '');
  return language ? `<pre><code class="language-${language}">${esc(text)}</code></pre>` : `<pre>${esc(text)}</pre>`;
}

/** A text link; a URL that is not http(s) gives the text alone */
export function link(url: string, text: string): string {
  if (!/^https?:\/\/[^\s]+$/i.test(url)) return esc(text);
  return `<a href="${esc(url)}">${esc(text)}</a>`;
}

export function quote(text: string, options: { expandable?: boolean } = {}): string {
  return `<blockquote${options.expandable ? ' expandable' : ''}>${esc(text)}</blockquote>`;
}

/** HTML that is already safe (built here or from an i18n string), for `htmlText` values */
export class SafeHtml {
  constructor(readonly html: string) {}
}
export const raw = (html: string) => new SafeHtml(html);

export type HtmlVars = Record<string, string | number | SafeHtml>;
export type HtmlTranslate = (key: string, vars?: HtmlVars) => string;

/** A translator for message HTML: the string is trusted, every value escaped unless raw() */
export function htmlText(t: Translate): HtmlTranslate {
  return (key, vars = {}) => {
    const safe: BotVars = {};
    for (const [name, value] of Object.entries(vars)) safe[name] = value instanceof SafeHtml ? value.html : typeof value === 'number' ? value : esc(value);
    return t(key, safe);
  };
}

const TOKEN = /<[^>]*>|&(?:#\d+|#x[0-9a-f]+|[a-z]+);|[\s\S]/giu;
const TAG_NAME = /^<\s*(\/)?\s*([a-z][\w-]*)/i;

/** Characters Telegram counts (UTF-16 units of the parsed text) */
export function visibleLength(html: string): number {
  let length = 0;
  for (const [token] of html.matchAll(TOKEN)) {
    if (token.startsWith('<') && token.length > 1) continue;
    length += token.startsWith('&') && token.length > 1 ? 1 : token.length;
  }
  return length;
}

/** At most `max` visible characters, "…" when cut; never inside a tag, an entity or a surrogate pair */
export function truncateHtml(html: string, max = MAX_MESSAGE): string {
  if (visibleLength(html) <= max) return html;
  const budget = max - 1;
  const open: string[] = [];
  let out = '';
  let used = 0;
  for (const [token] of html.matchAll(TOKEN)) {
    if (token.startsWith('<') && token.length > 1) {
      const match = token.match(TAG_NAME);
      if (match?.[1]) {
        const at = open.lastIndexOf(match[2].toLowerCase());
        if (at >= 0) open.splice(at);
      } else if (match) open.push(match[2].toLowerCase());
      out += token;
      continue;
    }
    const size = token.startsWith('&') && token.length > 1 ? 1 : token.length;
    if (used + size > budget) break;
    out += token;
    used += size;
  }
  return `${out}…${open
    .reverse()
    .map((name) => `</${name}>`)
    .join('')}`;
}

const ENTITIES: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };

/** The text without tags, entities unescaped (the fallback when Telegram can't parse the HTML) */
export function toPlain(html: string): string {
  return html.replace(/<[^>]*>/g, '').replace(/&(#\d+|#x[0-9a-f]+|[a-z]+);/gi, (match, name: string) => {
    if (name[0] === '#') {
      const value = name[1] === 'x' || name[1] === 'X' ? Number.parseInt(name.slice(2), 16) : Number.parseInt(name.slice(1), 10);
      return Number.isFinite(value) && value >= 0 && value <= 0x10ffff ? String.fromCodePoint(value) : match;
    }
    return ENTITIES[name.toLowerCase()] ?? match;
  });
}
