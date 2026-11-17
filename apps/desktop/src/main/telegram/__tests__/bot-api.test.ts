import { describe, expect, it, vi } from 'vitest';

import { createBotApi, TelegramApiError } from '../bot-api';

type Call = { url: string; body: unknown };

function fakeFetch(responses: Array<{ status?: number; json?: unknown; throws?: Error }>) {
  const calls: Call[] = [];
  const fn = vi.fn(async (url: string, init?: { body?: unknown }) => {
    calls.push({ url, body: typeof init?.body === 'string' ? JSON.parse(init.body) : init?.body });
    const next = responses.shift();
    if (!next) throw new Error('no more responses');
    if (next.throws) throw next.throws;
    return {
      ok: (next.status ?? 200) < 300,
      status: next.status ?? 200,
      json: async () => next.json,
    } as unknown as Response;
  });
  return { fn, calls };
}

describe('bot-api', () => {
  it('calls getMe on the token URL and returns the result', async () => {
    const { fn, calls } = fakeFetch([{ json: { ok: true, result: { id: 1, is_bot: true, username: 'my_bot', first_name: 'B' } } }]);
    const api = createBotApi('123:ABC', fn as never);
    const me = await api.getMe();
    expect(me.username).toBe('my_bot');
    expect(calls[0].url).toBe('https://api.telegram.org/bot123:ABC/getMe');
  });

  it('long-polls getUpdates with a 50 s timeout, the offset and allowed_updates', async () => {
    const { fn, calls } = fakeFetch([{ json: { ok: true, result: [] } }]);
    const api = createBotApi('t', fn as never);
    await api.getUpdates(42);
    expect(calls[0].url).toMatch(/\/getUpdates$/);
    expect(calls[0].body).toEqual({ offset: 42, timeout: 50, allowed_updates: ['message', 'callback_query'] });
  });

  it('sends a message with an inline keyboard and with force-reply', async () => {
    const { fn, calls } = fakeFetch([
      { json: { ok: true, result: { message_id: 7, date: 1, chat: { id: 5 } } } },
      { json: { ok: true, result: { message_id: 8, date: 1, chat: { id: 5 } } } },
    ]);
    const api = createBotApi('t', fn as never);
    const sent = await api.sendMessage(5, 'hi', { buttons: [[{ text: 'A', data: 'x1' }]] });
    expect(sent.message_id).toBe(7);
    expect(calls[0].body).toMatchObject({
      chat_id: 5,
      text: 'hi',
      reply_markup: { inline_keyboard: [[{ text: 'A', callback_data: 'x1' }]] },
    });
    await api.sendMessage(5, 'type', { forceReply: true });
    expect(calls[1].body).toMatchObject({ reply_markup: { force_reply: true } });
  });

  it('edits a message, answers a callback, sends a photo and an album', async () => {
    const ok = { json: { ok: true, result: true } };
    const { fn, calls } = fakeFetch([ok, ok, { json: { ok: true, result: { message_id: 1, date: 1, chat: { id: 5 } } } }, { json: { ok: true, result: [] } }]);
    const api = createBotApi('t', fn as never);
    await api.editMessageText(5, 9, 'done');
    expect(calls[0].body).toMatchObject({ chat_id: 5, message_id: 9, text: 'done', reply_markup: { inline_keyboard: [] } });
    await api.answerCallbackQuery('cb', 'ok');
    expect(calls[1].body).toEqual({ callback_query_id: 'cb', text: 'ok' });
    await api.sendPhoto(5, Buffer.from('png'), 'cap');
    expect(calls[2].url).toMatch(/\/sendPhoto$/);
    expect(calls[2].body).toBeInstanceOf(FormData);
    await api.sendMediaGroup(5, [Buffer.from('a'), Buffer.from('b')]);
    expect(calls[3].url).toMatch(/\/sendMediaGroup$/);
  });

  it('sends a JPEG as a JPEG and a PNG as a PNG', async () => {
    const { fn, calls } = fakeFetch([{ json: { ok: true, result: { message_id: 1 } } }, { json: { ok: true, result: [] } }]);
    const api = createBotApi('1:A', fn as never);
    await api.sendPhoto(5, Buffer.from([0xff, 0xd8, 0xff, 0xe0]));
    const photo = (calls[0].body as FormData).get('photo') as File;
    expect(photo.type).toBe('image/jpeg');
    expect(photo.name).toBe('photo.jpg');
    await api.sendMediaGroup(5, [Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.from([0xff, 0xd8, 0xff])]);
    const form = calls[1].body as FormData;
    expect((form.get('p0') as File).type).toBe('image/png');
    expect((form.get('p1') as File).name).toBe('p1.jpg');
  });

  it('classifies errors: 401, 409, 429 with retry_after, network', async () => {
    const { fn } = fakeFetch([
      { status: 401, json: { ok: false, error_code: 401, description: 'Unauthorized' } },
      { status: 409, json: { ok: false, error_code: 409, description: 'Conflict: terminated by other getUpdates request' } },
      { status: 429, json: { ok: false, error_code: 429, description: 'Too Many Requests', parameters: { retry_after: 7 } } },
      { throws: new TypeError('fetch failed') },
      { status: 400, json: { ok: false, error_code: 400, description: 'Bad Request' } },
    ]);
    const api = createBotApi('secret-token', fn as never);
    const kinds: Array<[string, number | undefined]> = [];
    for (let i = 0; i < 5; i++) {
      try {
        await api.getMe();
      } catch (error) {
        expect(error).toBeInstanceOf(TelegramApiError);
        const e = error as TelegramApiError;
        kinds.push([e.kind, e.retryAfter]);
        // The token never shows up in an error
        expect(e.message).not.toContain('secret-token');
      }
    }
    expect(kinds).toEqual([
      ['unauthorized', undefined],
      ['conflict', undefined],
      ['rate_limited', 7],
      ['network', undefined],
      ['other', undefined],
    ]);
  });
  it('sends HTML with previews off, coloured buttons and an effect; plain on request', async () => {
    const result = { json: { ok: true, result: { message_id: 1, date: 1, chat: { id: 5 } } } };
    const { fn, calls } = fakeFetch([result, result, { json: { ok: true, result: true } }, { json: { ok: true, result: true } }]);
    const api = createBotApi('t', fn as never);
    await api.sendMessage(5, '<b>hi</b>', { buttons: [[{ text: 'Merge', data: 'm', style: 'success' }, { text: 'Later', data: 'l' }]], effect: '5046509860389126442' });
    expect(calls[0].body).toMatchObject({
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
      message_effect_id: '5046509860389126442',
      reply_markup: { inline_keyboard: [[{ text: 'Merge', callback_data: 'm', style: 'success' }, { text: 'Later', callback_data: 'l' }]] },
    });
    expect((calls[0].body as { reply_markup: { inline_keyboard: Array<Array<Record<string, unknown>>> } }).reply_markup.inline_keyboard[0][1]).not.toHaveProperty('style');
    await api.sendMessage(5, 'plain', { plain: true });
    expect(calls[1].body).not.toHaveProperty('parse_mode');
    await api.editMessageText(5, 1, '<i>x</i>');
    expect(calls[2].body).toMatchObject({ parse_mode: 'HTML', link_preview_options: { is_disabled: true } });
    await api.sendChatAction(5, 'typing');
    expect(calls[3].url).toMatch(/\/sendChatAction$/);
    expect(calls[3].body).toEqual({ chat_id: 5, action: 'typing' });
  });

  it('captions are HTML too', async () => {
    const { fn, calls } = fakeFetch([{ json: { ok: true, result: { message_id: 1 } } }, { json: { ok: true, result: [] } }]);
    const api = createBotApi('t', fn as never);
    await api.sendPhoto(5, Buffer.from('png'), '<b>t</b>');
    expect((calls[0].body as FormData).get('parse_mode')).toBe('HTML');
    await api.sendMediaGroup(5, [Buffer.from('a'), Buffer.from('b')], '<b>t</b>');
    expect(JSON.parse((calls[1].body as FormData).get('media') as string)[0]).toMatchObject({ caption: '<b>t</b>', parse_mode: 'HTML' });
  });
});
