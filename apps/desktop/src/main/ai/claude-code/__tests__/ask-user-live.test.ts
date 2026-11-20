/**
 * Agent questions against the real Claude Code binary.
 *
 * The hook's own tests passed for weeks while no agent could ask: Claude Code left
 * AskUserQuestion out of every session, so the hook never ran. Only the binary
 * knows whether it offers the tool, so this test starts it, with a local stand-in
 * for the API (no model, no key, no cost) that calls AskUserQuestion once.
 */

import { mkdtempSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { query } from '@anthropic-ai/claude-agent-sdk';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { buildQueryOptions } from '../runner';
import type { AgentQuestion, AskUserHandler } from '../user-questions';
import type { SessionConfig } from '../../session/types';
import { isWindowsHost } from '../../../platform/__tests__/host';

const QUESTIONS: AgentQuestion[] = [
  {
    question: 'Which day starts the week?',
    header: 'Week start',
    multiSelect: false,
    options: [
      { label: 'Monday', description: 'ISO week' },
      { label: 'Sunday', description: 'US week' },
    ],
  },
];

interface ApiRequest {
  model: string;
  stream?: boolean;
  tools?: { name: string }[];
  messages: { content: unknown }[];
}

interface ToolResult {
  type: string;
  content: unknown;
  is_error?: boolean;
}

/** What the stand-in API saw in one session */
interface Seen {
  /** Tool names of the first model request */
  offered: string[];
  /** The result of the AskUserQuestion call, as the model would read it */
  result?: { text: string; isError: boolean };
}

let seen: Seen = { offered: [] };
let server: http.Server;
let baseURL = '';

function respond(res: http.ServerResponse, body: ApiRequest, block: Record<string, unknown>, stopReason: string): void {
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
    res.end(JSON.stringify({ ...message, content: [block], stop_reason: stopReason }));
    return;
  }
  const isTool = block.type === 'tool_use';
  const events = [
    { type: 'message_start', message },
    { type: 'content_block_start', index: 0, content_block: isTool ? { ...block, input: {} } : { type: 'text', text: '' } },
    {
      type: 'content_block_delta',
      index: 0,
      delta: isTool ? { type: 'input_json_delta', partial_json: JSON.stringify(block.input) } : { type: 'text_delta', text: block.text },
    },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: 1 } },
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
    // Claude Code may add its own notes after the result, so it is not always in the last message
    const results = body.messages
      .flatMap((message) => (Array.isArray(message.content) ? (message.content as ToolResult[]) : []))
      .filter((part) => part.type === 'tool_result');
    if (results.length > 0) {
      seen.result = { text: JSON.stringify(results[0].content), isError: results[0].is_error === true };
      respond(res, body, { type: 'text', text: 'Done.' }, 'end_turn');
      return;
    }
    const offered = (body.tools ?? []).map((tool) => tool.name);
    if (!offered.includes('Read')) {
      // One of Claude Code's own side requests (no session tools)
      respond(res, body, { type: 'text', text: 'ok' }, 'end_turn');
      return;
    }
    seen.offered = offered;
    if (offered.includes('AskUserQuestion')) {
      respond(res, body, { type: 'tool_use', id: 'toolu_question', name: 'AskUserQuestion', input: { questions: QUESTIONS } }, 'tool_use');
    } else {
      respond(res, body, { type: 'text', text: 'No way to ask.' }, 'end_turn');
    }
  });
}

/** One session, built the way the app builds it, until Claude Code reports its result. */
async function runSession(askUser?: AskUserHandler): Promise<Seen> {
  seen = { offered: [] };
  const cwd = mkdtempSync(join(tmpdir(), 'vt-ask-cwd-'));
  const config: SessionConfig = {
    agentType: 'brief_analyst',
    model: 'claude-haiku-5-5',
    auth: { apiKey: 'sk-ant-test-not-a-key', baseURL },
    systemPrompt: 'You are the analyst.',
    initialMessages: [{ role: 'user', content: 'Begin.' }],
    toolContext: { cwd, projectDir: cwd, specDir: cwd, securityProfile: undefined as never },
    maxSteps: 4,
    specDir: cwd,
    projectDir: cwd,
    toolsOverride: ['Read', 'AskUserQuestion'],
    settingSources: [],
    bundled: {},
    claudeConfigDir: mkdtempSync(join(tmpdir(), 'vt-ask-config-')),
  };
  const abortController = new AbortController();
  const options = buildQueryOptions(config, abortController, { askUser });
  options.env = { ...options.env, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' };
  const timer = setTimeout(() => abortController.abort(), 50_000);
  try {
    for await (const message of query({ prompt: 'Begin.', options })) {
      if (message.type === 'result') break;
    }
  } finally {
    clearTimeout(timer);
    abortController.abort();
  }
  return seen;
}

describe.skipIf(isWindowsHost)('agent questions with the real Claude Code', () => {
  beforeAll(async () => {
    server = http.createServer(handle);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  it('offers AskUserQuestion to the session, shows the questions to the user and gives the agent the answer', async () => {
    const ask = vi.fn<AskUserHandler>().mockResolvedValue({ 'Which day starts the week?': 'Monday' });

    const session = await runSession(ask);

    expect(session.offered).toContain('AskUserQuestion');
    expect(ask).toHaveBeenCalledTimes(1);
    expect(ask.mock.calls[0][0]).toEqual(QUESTIONS);
    expect(session.result?.isError).toBe(false);
    expect(session.result?.text).toContain('Monday');
  }, 60_000);

  it('tells the agent to go on with an assumption when nobody can answer', async () => {
    const session = await runSession();

    expect(session.offered).toContain('AskUserQuestion');
    expect(session.result?.isError).toBe(true);
    expect(session.result?.text).toMatch(/assumption/);
  }, 60_000);
});
