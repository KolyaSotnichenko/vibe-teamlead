import { describe, expect, it } from 'vitest';

import { createFakeBot } from './fake-bot';
import { clipMessage, redactSecrets, safeApi } from '../redact';

describe('redactSecrets', () => {
  it('masks key and token shapes', () => {
    const text = [
      'key sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789',
      'gh ghp_abcdefghijklmnopqrstuvwxyz0123456789AB',
      'pat github_pat_11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyz',
      'aws AKIAABCDEFGHIJKLMNOP',
      'bot 123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw0',
      'env DATABASE_PASSWORD=hunter2hunter2',
      'slack xoxb-1234567890-abcdefghij',
    ].join('\n');
    const out = redactSecrets(text);
    for (const secret of ['sk-ant-api03', 'ghp_abc', 'github_pat_11', 'AKIAABCD', 'AAHdqTcv', 'hunter2', 'xoxb-1234']) {
      expect(out).not.toContain(secret);
    }
    expect(out).toContain('[redacted]');
  });

  it('masks the exact values it is given and leaves ordinary text alone', () => {
    expect(redactSecrets('the value is s3cr3t-value here', ['s3cr3t-value'])).toBe('the value is [redacted] here');
    expect(redactSecrets('Add a login page (AC-1, AC-2)')).toBe('Add a login page (AC-1, AC-2)');
  });
});

describe('safeApi', () => {
  it('redacts and clips every text the bot sends or edits', async () => {
    const bot = createFakeBot();
    const api = safeApi(bot.api, () => ['MYTOKEN']);
    await api.sendMessage(1, `a MYTOKEN b ${'x'.repeat(5000)}`);
    expect(bot.sent[0].text).not.toContain('MYTOKEN');
    expect(bot.sent[0].text.length).toBeLessThanOrEqual(4096);
    await api.editMessageText(1, 2, 'MYTOKEN');
    expect(bot.edits[0].text).toBe('[redacted]');
  });

  it('redacts button labels too', async () => {
    const bot = createFakeBot();
    const api = safeApi(bot.api, () => ['MYTOKEN']);
    await api.sendMessage(1, 'hi', { buttons: [[{ text: 'MYTOKEN', data: 'x' }]] });
    expect(bot.sent[0].options?.buttons?.[0][0].text).toBe('[redacted]');
  });

  it('clipMessage keeps short text as is', () => {
    expect(clipMessage('hello')).toBe('hello');
  });
});
