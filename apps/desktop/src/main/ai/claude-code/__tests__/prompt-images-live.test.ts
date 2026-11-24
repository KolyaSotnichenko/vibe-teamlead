/**
 * Images in the prompt, against the real Claude Code binary.
 *
 * Insights let the user attach a screenshot, but the session got only text: the
 * model was told an image was attached and never saw it. Only the binary shows
 * what reaches the API, so this test starts it with a local stand-in for the API
 * (no model, no key, no cost) and looks at the request.
 */

import { mkdtempSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { query } from '@anthropic-ai/claude-agent-sdk';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildPrompt, buildQueryOptions } from '../runner';
import type { SessionConfig } from '../../session/types';
import { isWindowsHost } from '../../../platform/__tests__/host';

/** A 1×1 PNG */
const PIXEL = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

interface Block {
  type: string;
  text?: string;
  source?: { type: string; media_type: string; data: string };
}

interface ApiRequest {
  model: string;
  stream?: boolean;
  tools?: { name: string }[];
  messages: { role: string; content: string | Block[] }[];
}

/** The user blocks of the session's first model request */
let seen: Block[] | undefined;
let server: http.Server;
let baseURL = '';

function respond(res: http.ServerResponse, body: ApiRequest, text: string): void {
  const message = {
    id: `msg_${Date.now()}`,
    type: 'message',
    role: 'assistant',
    model: body.model,
    content: [] as unknown[],
    stop_reason: null as string | null,
    stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 },
  };
  if (!body.stream) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ...message, content: [{ type: 'text', text }], stop_reason: 'end_turn' }));
    return;
  }
  const events = [
    { type: 'message_start', message },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } },
    { type: 'message_stop' },
  ];
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  for (const event of events) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  res.end();
}

function handle(req: http.IncomingMessage, res: http.ServerResponse): void {
  let raw = '';
  req.on('data', (chunk) => {
    raw += chunk;
  });
  req.on('end', () => {
    if (!req.url?.startsWith('/v1/messages') || req.url.includes('count_tokens')) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ type: 'error', error: { type: 'not_found_error', message: 'not served' } }));
      return;
    }
    const body = JSON.parse(raw) as ApiRequest;
    const isSession = (body.tools ?? []).some((tool) => tool.name === 'Read');
    if (isSession && !seen) {
      seen = body.messages
        .filter((m) => m.role === 'user')
        .flatMap((m) => (typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : m.content));
    }
    respond(res, body, 'A screenshot of a settings page.');
  });
}

async function runSession(images: SessionConfig['images']): Promise<{ blocks: Block[]; result?: string }> {
  seen = undefined;
  const cwd = mkdtempSync(join(tmpdir(), 'vt-img-cwd-'));
  const config: SessionConfig = {
    agentType: 'insights_chat',
    model: 'claude-haiku-5-5',
    auth: { apiKey: 'sk-ant-test-not-a-key', baseURL },
    systemPrompt: 'You answer questions about the codebase.',
    initialMessages: [{ role: 'user', content: 'What is on this screenshot?' }],
    images,
    toolContext: { cwd, projectDir: cwd, specDir: cwd, securityProfile: undefined as never },
    maxSteps: 3,
    specDir: cwd,
    projectDir: cwd,
    toolsOverride: ['Read'],
    settingSources: [],
    bundled: {},
    claudeConfigDir: mkdtempSync(join(tmpdir(), 'vt-img-config-')),
  };
  const abortController = new AbortController();
  const options = buildQueryOptions(config, abortController, {});
  options.env = { ...options.env, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' };
  const timer = setTimeout(() => abortController.abort(), 50_000);
  let result: string | undefined;
  try {
    for await (const message of query({ prompt: buildPrompt(config), options })) {
      if (message.type === 'result') {
        result = message.subtype === 'success' ? message.result : message.subtype;
        break;
      }
    }
  } finally {
    clearTimeout(timer);
    abortController.abort();
  }
  return { blocks: seen ?? [], result };
}

describe.skipIf(isWindowsHost)('images in the prompt with the real Claude Code', () => {
  beforeAll(async () => {
    server = http.createServer(handle);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  it('sends the attached image to the model with the question, and the session ends with the answer', async () => {
    const { blocks, result } = await runSession([{ mediaType: 'image/png', data: PIXEL }]);

    const image = blocks.find((block) => block.type === 'image');
    expect(image?.source).toEqual({ type: 'base64', media_type: 'image/png', data: PIXEL });
    expect(blocks.some((block) => block.type === 'text' && block.text?.includes('What is on this screenshot?'))).toBe(true);
    expect(result).toBe('A screenshot of a settings page.');
  }, 60_000);
});

describe('buildPrompt', () => {
  const base = { initialMessages: [{ role: 'user' as const, content: 'Question' }] } as SessionConfig;

  it('is the text alone when there are no images', () => {
    expect(buildPrompt(base)).toBe('Question');
    expect(buildPrompt({ ...base, images: [] })).toBe('Question');
  });

  it('is one user message with the text and each image, a data URL prefix removed and image/jpg named image/jpeg', async () => {
    const prompt = buildPrompt({
      ...base,
      images: [
        { mediaType: 'image/png', data: PIXEL },
        { mediaType: 'image/jpg', data: `data:image/jpg;base64,${PIXEL}` },
      ],
    });
    expect(typeof prompt).not.toBe('string');
    const messages = [];
    for await (const message of prompt as AsyncIterable<unknown>) messages.push(message);
    expect(messages).toEqual([
      {
        type: 'user',
        parent_tool_use_id: null,
        message: {
          role: 'user',
          content: [
            { type: 'text', text: 'Question' },
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PIXEL } },
            { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: PIXEL } },
          ],
        },
      },
    ]);
  });
});
