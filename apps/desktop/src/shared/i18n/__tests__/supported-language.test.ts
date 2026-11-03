import { describe, expect, it } from 'vitest';
import { isSupportedLanguage, resolveSupportedLanguage } from '../../constants/i18n';
import { ADD_TO_DICTIONARY_LABELS, SPELL_CHECK_LANGUAGE_MAP } from '../../constants/spellcheck';

describe('resolveSupportedLanguage', () => {
  it('keeps a shipped language', () => {
    expect(resolveSupportedLanguage('en')).toBe('en');
    expect(resolveSupportedLanguage('uk', 'en-US')).toBe('uk');
  });

  it('falls back to English for the removed French setting', () => {
    expect(isSupportedLanguage('fr')).toBe(false);
    expect(resolveSupportedLanguage('fr')).toBe('en');
    expect(resolveSupportedLanguage('fr', 'fr-FR')).toBe('en');
    expect(resolveSupportedLanguage('fr', 'en-GB')).toBe('en');
  });

  it('falls back to Ukrainian when the OS language is Ukrainian', () => {
    expect(resolveSupportedLanguage('fr', 'uk-UA')).toBe('uk');
    expect(resolveSupportedLanguage('fr', 'uk')).toBe('uk');
    expect(resolveSupportedLanguage(undefined, 'uk_UA')).toBe('uk');
  });

  it('handles garbage without throwing', () => {
    expect(resolveSupportedLanguage(42, null)).toBe('en');
    expect(resolveSupportedLanguage('', '')).toBe('en');
  });
});

describe('spell check constants', () => {
  it('maps uk to Ukrainian dictionaries and drops fr', () => {
    expect(SPELL_CHECK_LANGUAGE_MAP.uk).toEqual(['uk-UA', 'uk']);
    expect(SPELL_CHECK_LANGUAGE_MAP.fr).toBeUndefined();
    expect(ADD_TO_DICTIONARY_LABELS.uk).toBe('Додати до словника');
    expect(ADD_TO_DICTIONARY_LABELS.fr).toBeUndefined();
  });
});
