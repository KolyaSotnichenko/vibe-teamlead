/**
 * Locale parity: every UI string in English must exist in Ukrainian with the
 * same placeholders, and Ukrainian must not carry keys English doesn't have.
 *
 * Plurals: where `en` has `key_one` / `key_other`, `uk` must provide all four
 * Ukrainian plural forms (`_one`, `_few`, `_many`, `_other`).
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import i18n, { resources } from '../index';
import { AVAILABLE_LANGUAGES } from '../../constants/i18n';

const LOCALES_DIR = join(__dirname, '..', 'locales');
const UK_PLURAL_FORMS = ['one', 'few', 'many', 'other'] as const;
const PLURAL_SUFFIX = /_(zero|one|two|few|many|other)$/;
const PLACEHOLDER = /\{\{\s*([^}\s]+)\s*\}\}/g;

type Flat = Record<string, string>;

function flatten(value: unknown, prefix = '', out: Flat = {}): Flat {
  if (typeof value === 'string') {
    out[prefix] = value;
  } else if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const [key, child] of Object.entries(value)) {
      flatten(child, prefix ? `${prefix}.${key}` : key, out);
    }
  } else {
    out[prefix] = `<<non-string: ${JSON.stringify(value)}>>`;
  }
  return out;
}

function readNamespace(lang: string, file: string): { raw: string; flat: Flat } {
  const raw = readFileSync(join(LOCALES_DIR, lang, file), 'utf-8');
  return { raw, flat: flatten(JSON.parse(raw)) };
}

function placeholders(text: string): string[] {
  return [...new Set([...text.matchAll(PLACEHOLDER)].map((m) => m[1]))].sort();
}

/** Keys `uk` must have: every `en` key, plus all Ukrainian forms of each `en` plural. */
function expectedUkKeys(en: Flat): Set<string> {
  const keys = new Set(Object.keys(en));
  for (const key of Object.keys(en)) {
    if (/_(one|other)$/.test(key)) {
      const base = key.replace(PLURAL_SUFFIX, '');
      for (const form of UK_PLURAL_FORMS) keys.add(`${base}_${form}`);
    }
  }
  return keys;
}

/** The English string a Ukrainian key is translated from. */
function englishSource(en: Flat, key: string): string | undefined {
  if (key in en) return en[key];
  const base = key.replace(PLURAL_SUFFIX, '');
  return en[`${base}_other`] ?? en[base];
}

const enFiles = readdirSync(join(LOCALES_DIR, 'en')).filter((f) => f.endsWith('.json')).sort();

describe('locales', () => {
  it('ships exactly English and Ukrainian', () => {
    expect(readdirSync(LOCALES_DIR).sort()).toEqual(['en', 'uk']);
    expect(Object.keys(resources).sort()).toEqual(['en', 'uk']);
    expect(AVAILABLE_LANGUAGES.map((l) => l.value)).toEqual(['en', 'uk']);
  });

  it('has the same namespace files in uk as in en', () => {
    const ukFiles = readdirSync(join(LOCALES_DIR, 'uk')).filter((f) => f.endsWith('.json')).sort();
    expect(ukFiles).toEqual(enFiles);
  });

  it('registers every namespace for both languages', () => {
    expect(Object.keys(resources.uk).sort()).toEqual(Object.keys(resources.en).sort());
    expect(Object.keys(resources.en)).toHaveLength(enFiles.length);
  });

  describe.each(enFiles)('%s', (file) => {
    const en = readNamespace('en', file).flat;
    const { raw: ukRaw, flat: uk } = readNamespace('uk', file);

    it('has every en key in uk and no extra keys', () => {
      const expected = expectedUkKeys(en);
      const missing = [...expected].filter((k) => !(k in uk));
      const extra = Object.keys(uk).filter((k) => !expected.has(k));
      expect({ missing, extra }).toEqual({ missing: [], extra: [] });
    });

    it('keeps the interpolation placeholders of the English source', () => {
      const mismatches = Object.keys(uk)
        .map((key) => ({ key, en: englishSource(en, key), uk: uk[key] }))
        .filter((e) => e.en !== undefined && placeholders(e.en).join() !== placeholders(e.uk).join())
        .map((e) => `${e.key}: en ${placeholders(e.en ?? '')} / uk ${placeholders(e.uk)}`);
      expect(mismatches).toEqual([]);
    });

    it('has no empty translations', () => {
      expect(Object.keys(uk).filter((k) => uk[k].trim() === '')).toEqual([]);
    });

    it('is formatted with 2-space indent, literal UTF-8 and a trailing newline', () => {
      expect(ukRaw).not.toMatch(/\\u[0-9a-fA-F]{4}/);
      expect(ukRaw).toBe(`${JSON.stringify(JSON.parse(ukRaw), null, 2)}\n`);
    });
  });
});

describe('Ukrainian plurals at runtime', () => {
  const t = i18n.getFixedT('uk');

  it('picks the one / few / many forms by Ukrainian rules', () => {
    expect(t('tasks:briefImport.done.title', { count: 1 })).toBe('Створено 1 задачу');
    expect(t('tasks:briefImport.done.title', { count: 3 })).toBe('Створено 3 задачі');
    expect(t('tasks:briefImport.done.title', { count: 5 })).toBe('Створено 5 задач');
    expect(t('tasks:briefImport.done.title', { count: 21 })).toBe('Створено 21 задачу');
    expect(t('tasks:briefImport.done.title', { count: 12 })).toBe('Створено 12 задач');
  });

  it('pluralises keys that have only a base and _other form in English', () => {
    expect(t('common:insights.messageCount', { count: 2 })).toBe('2 повідомлення');
    expect(t('common:insights.messageCount', { count: 11 })).toBe('11 повідомлень');
  });
});
