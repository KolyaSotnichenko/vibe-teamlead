/**
 * Telegram HTML (parse_mode "HTML"). Only an `Html` value is sent as HTML; a plain string is
 * sent as plain text, so text from tasks, agents and logs can never inject markup by accident.
 * `Html` is made only here: by the helpers (which escape what they are given), by the `html`
 * template (its values escaped), by `htmlText` (i18n strings, values escaped) and by
 * `sanitizeHtml`, a strict parser that keeps only the tags Telegram supports, with their
 * documented attributes double-quoted, and turns anything else into escaped text.
 */

import type { BotVars, Translate } from './i18n';

/** Telegram's limits, counted after parsing (tags don't count, an entity is one character) */
export const MAX_MESSAGE = 4096;
export const MAX_CAPTION = 1024;

const MINT = Symbol('html');

/** Telegram HTML that is safe to send */
export class Html {
  readonly value: string;
  constructor(value: string, key: symbol) {
    if (key !== MINT) throw new Error('Html is made only by the format helpers');
    this.value = value;
  }
  toString(): string {
    return this.value;
  }
}

const mint = (value: string) => new Html(value, MINT);

export const isHtml = (value: unknown): value is Html => value instanceof Html;

export function esc(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

type Content = string | number | Html;
const part = (value: Content): string => (value instanceof Html ? value.value : esc(String(value)));

/** A template whose literal parts are trusted markup and whose values are escaped (unless Html) */
export function html(strings: TemplateStringsArray, ...values: Content[]): Html {
  let out = strings[0];
  values.forEach((value, index) => {
    out += part(value) + strings[index + 1];
  });
  return mint(out);
}

export const text = (value: string | number) => mint(esc(String(value)));
export const joinHtml = (parts: Html[], separator = '\n') => mint(parts.map((p) => p.value).join(esc(separator)));

export const b = (value: Content) => mint(`<b>${part(value)}</b>`);
export const i = (value: Content) => mint(`<i>${part(value)}</i>`);
export const code = (value: string) => mint(`<code>${esc(value)}</code>`);

export function pre(value: string, lang?: string): Html {
  const language = lang?.replace(/[^\w+-]/g, '');
  return mint(language ? `<pre><code class="language-${language}">${esc(value)}</code></pre>` : `<pre>${esc(value)}</pre>`);
}

const HTTP_URL = /^https?:\/\/[^\s"<>]+$/i;

/** A text link; a URL that is not http(s) gives the text alone */
export function link(url: string, label: Content): Html {
  if (!HTTP_URL.test(url)) return mint(part(label));
  return mint(`<a href="${esc(url)}">${part(label)}</a>`);
}

export function quote(content: Content, options: { expandable?: boolean } = {}): Html {
  return mint(`<blockquote${options.expandable ? ' expandable' : ''}>${part(content)}</blockquote>`);
}

export type HtmlVars = Record<string, Content>;
export type HtmlTranslate = (key: string, vars?: HtmlVars) => Html;

/** A translator for messages: the i18n string is markup (checked by sanitizeHtml), every value escaped unless Html */
export function htmlText(t: Translate): HtmlTranslate {
  return (key, vars = {}) => {
    const safe: BotVars = {};
    for (const [name, value] of Object.entries(vars)) safe[name] = typeof value === 'number' ? value : part(value);
    return sanitizeHtml(t(key, safe));
  };
}

// ---- strict parsing ------------------------------------------------------------------------

const ENTITIES: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };

/** Entities decoded (any text: tags are left as they are) */
export function decodeEntities(value: string): string {
  return value.replace(/&(#\d+|#x[0-9a-f]+|[a-z]+);/gi, (match, name: string) => {
    if (name[0] === '#') {
      const n = name[1] === 'x' || name[1] === 'X' ? Number.parseInt(name.slice(2), 16) : Number.parseInt(name.slice(1), 10);
      return Number.isFinite(n) && n >= 0 && n <= 0x10ffff ? String.fromCodePoint(n) : match;
    }
    return ENTITIES[name.toLowerCase()] ?? match;
  });
}

const SIMPLE = new Set(['b', 'strong', 'i', 'em', 'u', 'ins', 's', 'strike', 'del', 'tg-spoiler', 'code', 'pre', 'blockquote', 'a']);

type Token = { kind: 'text'; raw: string } | { kind: 'open'; name: string; attr?: { name: string; raw: string } } | { kind: 'close'; name: string };

/** One supported opening tag, exactly as Telegram documents it; anything else is undefined */
function openTag(tag: string): Token | undefined {
  let m = tag.match(/^<(b|strong|i|em|u|ins|s|strike|del|tg-spoiler|code|pre|blockquote)>$/);
  if (m) return { kind: 'open', name: m[1] };
  m = tag.match(/^<a href="([^"<>]*)">$/);
  if (m) return { kind: 'open', name: 'a', attr: { name: 'href', raw: decodeEntities(m[1]) } };
  m = tag.match(/^<code class="(language-[\w+-]+)">$/);
  if (m) return { kind: 'open', name: 'code', attr: { name: 'class', raw: m[1] } };
  if (tag === '<blockquote expandable>') return { kind: 'open', name: 'blockquote', attr: { name: 'expandable', raw: '' } };
  return undefined;
}

/** Supported, balanced tags; everything else (unknown tags, other attributes, stray `<`) is text */
function tokenize(value: string): Token[] {
  const tokens: Token[] = [];
  const open: string[] = [];
  const pushText = (raw: string) => {
    const last = tokens[tokens.length - 1];
    if (last?.kind === 'text') last.raw += raw;
    else tokens.push({ kind: 'text', raw });
  };
  for (const piece of value.split(/(<[^<>]*>)/)) {
    if (!piece) continue;
    if (!piece.startsWith('<') || !piece.endsWith('>')) {
      pushText(decodeEntities(piece));
      continue;
    }
    const close = piece.match(/^<\/([a-z-]+)>$/);
    if (close && SIMPLE.has(close[1]) && open[open.length - 1] === close[1]) {
      open.pop();
      tokens.push({ kind: 'close', name: close[1] });
      continue;
    }
    const tag = close ? undefined : openTag(piece);
    if (tag && tag.kind === 'open') {
      open.push(tag.name);
      tokens.push(tag);
      continue;
    }
    pushText(decodeEntities(piece));
  }
  for (const name of open.reverse()) tokens.push({ kind: 'close', name });
  return tokens;
}

function serialize(tokens: Token[]): string {
  return tokens
    .map((token) => {
      if (token.kind === 'text') return esc(token.raw);
      if (token.kind === 'close') return `</${token.name}>`;
      if (!token.attr) return `<${token.name}>`;
      if (token.attr.name === 'expandable') return '<blockquote expandable>';
      return `<${token.name} ${token.attr.name}="${esc(token.attr.raw)}">`;
    })
    .join('');
}

/**
 * Keeps only supported tags (balanced, documented attributes, double-quoted); everything else
 * becomes escaped text. `transform` sees each raw text run and attribute value (redaction). A
 * link whose href is no longer an http(s) URL after it keeps its text only.
 */
export function sanitizeHtml(value: string, transform: (raw: string) => string = (raw) => raw): Html {
  const tokens = tokenize(value).map((token): Token => {
    if (token.kind === 'text') return { kind: 'text', raw: transform(token.raw) };
    if (token.kind === 'open' && token.attr && token.attr.name !== 'expandable') return { ...token, attr: { ...token.attr, raw: transform(token.attr.raw) } };
    return token;
  });
  // Links: only http(s) (after the transform too); otherwise the tag pair goes, the text stays
  const out: Token[] = [];
  const dropped: boolean[] = [];
  for (const token of tokens) {
    if (token.kind === 'open' && token.name === 'a') {
      const ok = !!token.attr && HTTP_URL.test(token.attr.raw);
      dropped.push(!ok);
      if (ok) out.push(token);
    } else if (token.kind === 'close' && token.name === 'a') {
      if (!dropped.pop()) out.push(token);
    } else out.push(token);
  }
  return mint(serialize(out));
}

/** The text without tags, entities decoded (the plain-text fallback) */
export function toPlain(value: Html | string): string {
  const source = value instanceof Html ? value.value : value;
  return decodeEntities(source.replace(/<[^>]*>/g, ''));
}

const TOKEN = /<[^>]*>|&(?:#\d+|#x[0-9a-f]+|[a-z]+);|[\s\S]/giu;
const TAG_NAME = /^<\s*(\/)?\s*([a-z][\w-]*)/i;

/** Characters Telegram counts (UTF-16 units of the parsed text) */
export function visibleLength(value: Html | string): number {
  let length = 0;
  for (const [token] of String(value).matchAll(TOKEN)) {
    if (token.startsWith('<') && token.length > 1) continue;
    length += token.startsWith('&') && token.length > 1 ? 1 : token.length;
  }
  return length;
}

/** At most `max` visible characters, "…" when cut; never inside a tag, an entity or a surrogate pair */
export function truncateHtml(value: Html, max = MAX_MESSAGE): Html {
  if (visibleLength(value) <= max) return value;
  const budget = max - 1;
  const open: string[] = [];
  let out = '';
  let used = 0;
  for (const [token] of value.value.matchAll(TOKEN)) {
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
  return mint(
    `${out}…${open
      .reverse()
      .map((name) => `</${name}>`)
      .join('')}`,
  );
}
