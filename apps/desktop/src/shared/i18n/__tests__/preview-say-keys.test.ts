/**
 * Every sentence the main process says in the Preview has its key in both locales, with the
 * values the main process gives it (locale-parity.test.ts checks the two locales against
 * each other).
 */
import { describe, expect, it } from 'vitest';

import { PREVIEW_SAY } from '../../constants/preview-say';
import en from '../locales/en/tasks.json';
import uk from '../locales/uk/tasks.json';

const PLACEHOLDER = /\{\{\s*([^}\s]+)\s*\}\}/g;
/** Each value a sentence uses, once: a name may be said twice in it */
const placeholders = (text: string) => [...new Set([...text.matchAll(PLACEHOLDER)].map((m) => m[1]))].sort();

describe('preview sentences from the main process', () => {
  for (const [locale, tasks] of [['en', en], ['uk', uk]] as const) {
    it(`has every key in ${locale}, with exactly the values the main process gives`, () => {
      const said = (tasks as unknown as { preview: { say?: Record<string, string> } }).preview.say ?? {};
      for (const [key, params] of Object.entries(PREVIEW_SAY)) {
        expect(said[key], `preview.say.${key} in ${locale}`).toBeTypeOf('string');
        expect(placeholders(said[key] ?? ''), `placeholders of preview.say.${key} in ${locale}`).toEqual([...params].sort());
      }
      expect(Object.keys(said).sort()).toEqual(Object.keys(PREVIEW_SAY).sort());
    });
  }
});
