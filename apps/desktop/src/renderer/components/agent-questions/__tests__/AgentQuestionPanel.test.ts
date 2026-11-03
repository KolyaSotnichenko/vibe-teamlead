import { describe, expect, it } from 'vitest';

import { roleKey, toAnswers } from '../AgentQuestionPanel';

const questions = [
  { question: 'Auth?', header: 'Auth', multiSelect: true, options: [] },
  { question: 'Sessions?', header: 'Sessions', multiSelect: false, options: [] },
];

describe('toAnswers', () => {
  it('needs an answer for every question', () => {
    expect(toAnswers(questions, { 'Auth?': { selected: ['GitHub'], other: '' } })).toBeNull();
  });

  it('joins selections and free text', () => {
    expect(
      toAnswers(questions, {
        'Auth?': { selected: ['GitHub', 'Magic link'], other: 'SSO later' },
        'Sessions?': { selected: [], other: 'Cookies' },
      }),
    ).toEqual({ 'Auth?': 'GitHub, Magic link, SSO later', 'Sessions?': 'Cookies' });
  });
});

describe('roleKey', () => {
  it('maps agent types to roles', () => {
    expect(roleKey('spec_gatherer')).toBe('spec');
    expect(roleKey('qa_fixer')).toBe('qaFixer');
    expect(roleKey('qa_reviewer')).toBe('qa');
    expect(roleKey('something')).toBe('agent');
  });
});
