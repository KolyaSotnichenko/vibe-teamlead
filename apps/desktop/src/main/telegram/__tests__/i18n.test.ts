import { describe, expect, it } from 'vitest';

import { botText } from '../i18n';

describe('bot i18n', () => {
  it('reads bot.* keys of the telegram namespace in the given language', () => {
    expect(botText('en', 'question.other')).toBe('Other…');
    expect(botText('uk', 'question.other')).toBe('Інше…');
  });

  it('interpolates and picks plural forms by language rules', () => {
    expect(botText('en', 'stopAll.done', { count: 1 })).toMatch(/^Stopped 1 task\./);
    expect(botText('en', 'stopAll.done', { count: 3 })).toMatch(/^Stopped 3 tasks\./);
    expect(botText('uk', 'stopAll.done', { count: 3 })).toMatch(/^Зупинено 3 задачі\./);
    expect(botText('uk', 'stopAll.done', { count: 5 })).toMatch(/^Зупинено 5 задач\./);
    expect(botText('uk', 'stopAll.done', { count: 21 })).toMatch(/^Зупинено 21 задачу\./);
  });

  it('falls back to English for an unknown language and to the key when missing', () => {
    expect(botText('fr', 'question.other')).toBe('Other…');
    expect(botText('en', 'nope.nothing')).toBe('nope.nothing');
  });
});
