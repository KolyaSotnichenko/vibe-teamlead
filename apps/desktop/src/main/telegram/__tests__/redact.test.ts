import { describe, expect, it } from 'vitest';

import { TelegramApiError } from '../bot-api';
import { b, html, link, quote, sanitizeHtml, visibleLength } from '../format';
import { createFakeBot } from './fake-bot';
import { clipMessage, redactHtml, redactSecrets, safeApi } from '../redact';

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

describe('safeApi with HTML', () => {
  const secretKey = 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789';

  it('redacts the raw text before it is escaped, inside tags and links', async () => {
    const bot = createFakeBot();
    const api = safeApi(bot.api, () => ['MY&TOKEN']);
    await api.sendMessage(1, html`${b('DB_PASSWORD=a&b')} ${'MY&TOKEN'} ${link('https://x.dev/?key=MY&TOKEN', 'link')}`);
    expect(bot.sent[0].text).toBe('<b>DB_PASSWORD=[redacted]</b> [redacted] <a href="https://x.dev/?key=[redacted]">link</a>');
    expect(bot.sent[0].html).toBe(true);
  });

  it('a raw string goes as plain text, redacted, its markup inert', async () => {
    const bot = createFakeBot();
    const api = safeApi(bot.api, () => []);
    await api.sendMessage(1, `<a href="https://evil">x</a> ${secretKey}`);
    expect(bot.sent[0].html).toBe(false);
    expect(bot.sent[0].text).toBe('<a href="https://evil">x</a> [redacted]');
  });

  // Html that did not come from the helpers can't be made; these check the parser on whatever
  // markup reaches it (an i18n string, a future helper)
  it('a secret in a single-quoted or unquoted attribute is redacted; the tag is escaped', () => {
    for (const source of [`<a href='https://x.dev/?k=${secretKey}'>l</a>`, `<a href=https://x.dev/?k=${secretKey}>l</a>`]) {
      const out = redactHtml(sanitizeHtml(source));
      expect(out.value).not.toContain('abcdefghijklmnop');
      expect(out.value).not.toMatch(/<a /);
    }
  });

  it('a secret across an entity boundary or split by markup is still not sent', async () => {
    const bot = createFakeBot();
    const api = safeApi(bot.api, () => ['MY&TOKEN']);
    await api.sendMessage(1, sanitizeHtml('key MY&amp;TOKEN and sk-ant-api03&#45;abcdefghijklmnopqrstuvwxyz'));
    expect(bot.sent[0].text).not.toMatch(/MY&amp;TOKEN|abcdefghijklmnop/);
    await api.sendMessage(1, sanitizeHtml('<b>sk-ant-api03-abc</b>defghijklmnopqrstuvwxyz'));
    expect(bot.sent[1].text).not.toContain('defghijklmnop');
    expect(bot.sent[1].text).toContain('[redacted]');
  });

  it('an unsupported tag is escaped', async () => {
    const bot = createFakeBot();
    const api = safeApi(bot.api, () => []);
    await api.sendMessage(1, sanitizeHtml('<b>ok</b><script>x</script><img src="y">'));
    expect(bot.sent[0].text).toBe('<b>ok</b>&lt;script&gt;x&lt;/script&gt;&lt;img src=&quot;y&quot;&gt;');
  });

  it('hostile text in a task title stays inert', async () => {
    const bot = createFakeBot();
    const api = safeApi(bot.api, () => []);
    await api.sendMessage(1, html`👀 ${b('<b>x</b> & <a href=javascript:alert(1)>y</a>')}`);
    expect(bot.sent[0].text).toBe('👀 <b>&lt;b&gt;x&lt;/b&gt; &amp; &lt;a href=javascript:alert(1)&gt;y&lt;/a&gt;</b>');
  });

  it('truncates HTML at the limit without broken tags', async () => {
    const bot = createFakeBot();
    const api = safeApi(bot.api, () => []);
    await api.sendMessage(1, html`${b('title')}\n${quote('a & b '.repeat(1000), { expandable: true })}`);
    const text = bot.sent[0].text;
    expect(visibleLength(text)).toBeLessThanOrEqual(4096);
    expect(text.endsWith('…</blockquote>')).toBe(true);
  });

  it('keeps button styles', async () => {
    const bot = createFakeBot();
    const api = safeApi(bot.api, () => []);
    await api.sendMessage(1, 'hi', { buttons: [[{ text: 'Merge', data: 'm', style: 'success' }]] });
    expect(bot.sent[0].options?.buttons?.[0][0]).toEqual({ text: 'Merge', data: 'm', style: 'success' });
  });

  it("resends once as plain text when Telegram can't parse the entities, and logs it", async () => {
    const bot = createFakeBot();
    const warnings: string[] = [];
    const api = safeApi(bot.api, () => [], (message) => warnings.push(message));
    bot.rejectWith((_method, _text, isHtml) =>
      isHtml ? new TelegramApiError('other', "Bad Request: can't parse entities: Unsupported start tag \"x\" at byte offset 3") : undefined,
    );
    await api.sendMessage(1, b('a <b> & c'));
    expect(bot.sent).toHaveLength(1);
    expect(bot.sent[0]).toMatchObject({ text: 'a <b> & c', html: false });
    await api.editMessageText(1, 2, html`<i>x</i>`);
    expect(bot.edits[0]).toMatchObject({ text: 'x', html: false });
    expect(warnings.length).toBe(2);
  });

  it('other errors are not retried', async () => {
    const bot = createFakeBot();
    const api = safeApi(bot.api, () => []);
    bot.rejectWith(() => new TelegramApiError('network', 'Telegram is not reachable'));
    await expect(api.sendMessage(1, 'x')).rejects.toThrow('not reachable');
    expect(bot.attempts).toHaveLength(1);
  });

  it('sends without the effect when Telegram rejects it', async () => {
    const bot = createFakeBot();
    const api = safeApi(bot.api, () => []);
    bot.rejectWith((_m, _t, _h, options) => ((options as { effect?: string } | undefined)?.effect ? new TelegramApiError('other', 'Bad Request: EFFECT_ID_INVALID') : undefined));
    await api.sendMessage(1, html`✅ <b>Merged</b>`, { effect: '5046509860389126442' });
    expect(bot.attempts).toHaveLength(2);
    expect(bot.sent[0].options?.effect).toBeUndefined();
    expect(bot.sent[0].text).toBe('✅ <b>Merged</b>');
  });
});

