import { describe, expect, it } from 'vitest';

import en from '../../../shared/i18n/locales/en/telegram.json';
import uk from '../../../shared/i18n/locales/uk/telegram.json';
import { botText } from '../i18n';

describe('bot i18n', () => {
  it('reads bot.* keys of the telegram namespace in the given language', () => {
    expect(botText('en', 'question.other')).toBe('Other…');
    expect(botText('uk', 'question.other')).toBe('Інше…');
  });

  it('interpolates and picks plural forms by language rules', () => {
    expect(botText('en', 'stopAll.done', { count: 1 })).toMatch(/^🛑 Stopped 1 task\./);
    expect(botText('en', 'stopAll.done', { count: 3 })).toMatch(/^🛑 Stopped 3 tasks\./);
    expect(botText('uk', 'stopAll.done', { count: 3 })).toMatch(/^🛑 Зупинено 3 задачі\./);
    expect(botText('uk', 'stopAll.done', { count: 5 })).toMatch(/^🛑 Зупинено 5 задач\./);
    expect(botText('uk', 'stopAll.done', { count: 21 })).toMatch(/^🛑 Зупинено 21 задачу\./);
  });

  it('falls back to English for an unknown language and to the key when missing', () => {
    expect(botText('fr', 'question.other')).toBe('Other…');
    expect(botText('en', 'nope.nothing')).toBe('nope.nothing');
  });
});


type Tree = { [key: string]: string | Tree };
const flat = (tree: Tree, prefix = ''): Array<[string, string]> =>
  Object.entries(tree).flatMap(([key, value]) => (typeof value === 'string' ? [[`${prefix}${key}`, value] as [string, string]] : flat(value, `${prefix}${key}.`)));

const ALLOWED = new Set(['b', 'i', 'u', 's', 'code', 'pre', 'a', 'blockquote', 'tg-spoiler']);
/** Labels, toasts and placeholders: plain text (Telegram doesn't parse HTML there) */
const PLAIN = /^(expired|skippedPress_\w+|question\.(other|done|recommended|selected)|review\.(merge|sendBack|later|confirmYes|confirmNo|commentPlaceholder|diffLink|unknownReason)|stopAll\.(yes|no)|design\.(approve|comment|commentPlaceholder)|task\.(start|createFromText|analyse)|brief\.(create_\w+|discard))$/;

describe('bot strings are valid Telegram HTML', () => {
  for (const [lang, file] of [['en', en], ['uk', uk]] as const) {
    it(`${lang}: only supported tags, balanced; no raw < or &; labels plain`, () => {
      for (const [key, text] of flat(file.bot as Tree)) {
        const stack: string[] = [];
        for (const match of text.matchAll(/<(\/)?([a-z-]+)[^>]*>/g)) {
          expect(ALLOWED.has(match[2]), `${lang} ${key}: <${match[2]}>`).toBe(true);
          if (match[1]) expect(stack.pop(), `${lang} ${key}`).toBe(match[2]);
          else stack.push(match[2]);
        }
        expect(stack, `${lang} ${key}`).toEqual([]);
        const outside = text.replace(/<\/?[a-z-]+[^>]*>/g, '');
        expect(outside, `${lang} ${key}`).not.toMatch(/[<>]|&(?!(lt|gt|amp|quot);)/);
        if (PLAIN.test(key)) expect(text, `${lang} ${key}`).not.toMatch(/<|&/);
      }
    });
  }
});
