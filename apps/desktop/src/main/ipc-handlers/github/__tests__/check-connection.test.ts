/**
 * GitHub connection check (used by GitHub Issues and GitHub PRs) and the PR list use the same sign-in
 * as Deploy: the GitHub App user token from getValidAccessToken(), refreshed when it has expired.
 * Regression: PRs said "GitHub Not Connected" while signed in, because the check read the stored
 * token synchronously and an expired one (not yet refreshed) counted as no sign-in.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { Project } from '../../../../shared/types';
import { IPC_CHANNELS } from '../../../../shared/constants';

const handlers = vi.hoisted(() => new Map<string, Function>());
const listeners = vi.hoisted(() => new Map<string, Function>());
vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: Function) => handlers.set(channel, fn),
    on: (channel: string, fn: Function) => listeners.set(channel, fn),
    removeHandler: vi.fn(),
  },
  app: { getPath: vi.fn(() => '/tmp'), on: vi.fn() },
  BrowserWindow: class {},
}));

const projectRef: { current: Project | null } = { current: null };
vi.mock('../../../project-store', () => ({
  projectStore: { getProject: vi.fn(() => projectRef.current), getProjects: vi.fn(() => []) },
}));

const tokens = vi.hoisted(() => ({
  stored: null as string | null,
  valid: null as string | null,
}));
vi.mock('../../../github-auth/token-store', () => ({
  getStoredAccessTokenSync: vi.fn(() => tokens.stored),
  getValidAccessToken: vi.fn(async () => tokens.valid),
}));

// No gh CLI on the machine
vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  const fail = () => {
    throw new Error('gh: not found');
  };
  return {
    ...actual,
    execFileSync: vi.fn(fail),
    execFile: vi.fn((...args: unknown[]) => {
      const cb = args[args.length - 1];
      if (typeof cb === 'function') cb(new Error('gh: not found'), '', '');
    }),
  };
});

// Create task: the spec is written by spec-utils (not under test here)
const createSpecForIssue = vi.hoisted(() => vi.fn(async () => ({ specId: '042-issue-4' })));
vi.mock('../spec-utils', () => ({
  createSpecForIssue,
  buildIssueContext: vi.fn(() => 'context'),
  buildInvestigationTask: vi.fn(() => 'task'),
}));
vi.mock('../../../agent', () => ({ AgentManager: class {} }));

import { registerCheckConnection } from '../repository-handlers';
import { registerInvestigateIssue } from '../investigation-handlers';
import { getGitHubConfigAsync } from '../utils';

let dir: string;

function makeProject(env: string): Project {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-conn-'));
  fs.mkdirSync(path.join(dir, '.auto-claude'));
  fs.writeFileSync(path.join(dir, '.auto-claude', '.env'), env);
  return { id: 'p1', name: 'p', path: dir, autoBuildPath: '.auto-claude', settings: {} } as unknown as Project;
}

const fetchMock = vi.fn();

beforeEach(() => {
  handlers.clear();
  listeners.clear();
  tokens.stored = null;
  tokens.valid = null;
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (url: string) => {
    const body = String(url).includes('/issues') ? [] : { full_name: 'acme/app' };
    return new Response(JSON.stringify(body), { status: 200 });
  });
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

describe('GitHub connection check', () => {
  it('is connected with the App token when the stored one has expired and is refreshed', async () => {
    projectRef.current = makeProject('GITHUB_REPO=acme/app\nGITHUB_AUTH_METHOD=oauth\n');
    tokens.stored = null; // expired: the synchronous read has nothing usable
    tokens.valid = 'ghu_fresh'; // getValidAccessToken() refreshes it
    registerCheckConnection();
    const result = (await handlers.get(IPC_CHANNELS.GITHUB_CHECK_CONNECTION)?.({}, 'p1')) as {
      success: boolean;
      data: { connected: boolean; repoFullName?: string };
    };
    expect(result.data.connected).toBe(true);
    expect(result.data.repoFullName).toBe('acme/app');
    const auth = (fetchMock.mock.calls[0][1] as RequestInit).headers as Record<string, string>;
    expect(auth.Authorization).toBe('Bearer ghu_fresh');
  });

  it('never trusts a ghu_ token saved in .env; it uses the live App token', async () => {
    const project = makeProject('GITHUB_REPO=acme/app\nGITHUB_TOKEN=ghu_old\n');
    tokens.valid = 'ghu_live';
    expect(await getGitHubConfigAsync(project)).toEqual({ token: 'ghu_live', repo: 'acme/app' });
  });

  it('keeps a personal access token from .env', async () => {
    const project = makeProject('GITHUB_REPO=acme/app\nGITHUB_TOKEN=ghp_pat\n');
    tokens.valid = 'ghu_live';
    expect(await getGitHubConfigAsync(project)).toEqual({ token: 'ghp_pat', repo: 'acme/app' });
  });

  it('is not connected when signed out and there is no other token', async () => {
    projectRef.current = makeProject('GITHUB_REPO=acme/app\nGITHUB_AUTH_METHOD=oauth\n');
    registerCheckConnection();
    const result = (await handlers.get(IPC_CHANNELS.GITHUB_CHECK_CONNECTION)?.({}, 'p1')) as {
      data: { connected: boolean };
    };
    expect(result.data.connected).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('creates a task from an issue with an expired stored token that getValidAccessToken refreshes', async () => {
    projectRef.current = makeProject('GITHUB_REPO=acme/app\nGITHUB_AUTH_METHOD=oauth\n');
    tokens.stored = null;
    tokens.valid = 'ghu_fresh';
    fetchMock.mockImplementation(async (url: string) => {
      const body = String(url).endsWith('/comments')
        ? []
        : { number: 4, title: 'Bug', body: 'x', labels: [], html_url: 'https://github.com/acme/app/issues/4' };
      return new Response(JSON.stringify(body), { status: 200 });
    });
    const send = vi.fn();
    registerInvestigateIssue({} as never, () => ({ webContents: { send } }) as never);
    await listeners.get(IPC_CHANNELS.GITHUB_INVESTIGATE_ISSUE)?.({}, 'p1', 4);
    expect(send).not.toHaveBeenCalledWith(IPC_CHANNELS.GITHUB_INVESTIGATION_ERROR, 'p1', expect.anything());
    expect(send).toHaveBeenCalledWith(
      IPC_CHANNELS.GITHUB_INVESTIGATION_COMPLETE,
      'p1',
      expect.objectContaining({ success: true, taskId: '042-issue-4' })
    );
    const auth = (fetchMock.mock.calls[0][1] as RequestInit).headers as Record<string, string>;
    expect(auth.Authorization).toBe('Bearer ghu_fresh');
  });
});
