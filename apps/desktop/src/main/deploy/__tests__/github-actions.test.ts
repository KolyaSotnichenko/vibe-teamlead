import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';

vi.mock('../../ipc-handlers/github/utils', () => ({
  getGitHubConfigAsync: vi.fn(),
  normalizeRepoReference: (r: string) =>
    r.replace(/\.git$/, '').replace(/^(https?:\/\/github\.com\/|git@github\.com:)/, '').trim(),
}));
vi.mock('child_process', () => ({ execFile: vi.fn() }));
vi.mock('../../cli-tool-manager', () => ({ getToolPath: () => 'git' }));

import { createActionsClient, classifyGitHubError, resolveRepo } from '../github-actions';
import { getGitHubConfigAsync } from '../../ipc-handlers/github/utils';
import { execFile } from 'child_process';

/** execFile answering with stdout, or failing. */
const gitAnswers = (stdout: string | Error) =>
  vi.mocked(execFile).mockImplementation(((...args: unknown[]) => {
    const cb = args[args.length - 1] as (err: Error | null, stdout?: string) => void;
    if (stdout instanceof Error) cb(stdout);
    else cb(null, stdout);
  }) as never);

const fx = (n: string) => JSON.parse(readFileSync(path.join(__dirname, 'fixtures', n), 'utf-8'));
const ok = (body: unknown) => ({ status: 200, headers: new Headers(), body });

function client(routes: Record<string, unknown>) {
  const calls: string[] = [];
  const c = createActionsClient(async (endpoint) => {
    calls.push(endpoint);
    const hit = routes[endpoint];
    if (hit === undefined) return { status: 404, headers: new Headers(), body: { message: 'Not Found' } };
    return hit as { status: number; headers: Headers; body: unknown };
  });
  return { c, calls };
}

describe('runs', () => {
  it('maps the head repository of a run', async () => {
    const body = { workflow_runs: [{ id: 1, head_repository: { full_name: 'fork/app' } }, { id: 2 }] };
    const { c } = client({ '/repos/acme/app/actions/runs?per_page=20': ok(body) });
    const runs = await c.runs('acme', 'app');
    expect(runs[0].headRepo).toBe('fork/app');
    expect(runs[1].headRepo).toBeUndefined();
  });

  it('can filter by branch', async () => {
    const { c, calls } = client({ '/repos/acme/app/actions/runs?per_page=30&branch=feat%2Fx': ok({ workflow_runs: [] }) });
    await c.runs('acme', 'app', 30, 'feat/x');
    expect(calls).toEqual(['/repos/acme/app/actions/runs?per_page=30&branch=feat%2Fx']);
  });

  it('maps workflow runs', async () => {
    const { c, calls } = client({ '/repos/acme/app/actions/runs?per_page=20': ok(fx('runs.json')) });
    const runs = await c.runs('acme', 'app');
    expect(calls).toEqual(['/repos/acme/app/actions/runs?per_page=20']);
    expect(runs).toHaveLength(2);
    expect(runs[0]).toEqual({
      id: 101, number: 17, name: 'CI', title: 'Add login', branch: 'main', sha: 'abc123', event: 'push',
      status: 'completed', conclusion: 'success', startedAt: '2026-11-10T10:00:00Z',
      updatedAt: '2026-11-10T10:05:00Z', htmlUrl: 'https://github.com/acme/app/actions/runs/101',
      workflowPath: '.github/workflows/ci.yml',
    });
    expect(runs[1].status).toBe('in_progress');
    expect(runs[1].conclusion).toBeUndefined();
    expect(runs[1].startedAt).toBe('2026-11-11T08:00:00Z');
  });

  it('throws a GitHubError on failure', async () => {
    const { c } = client({});
    await expect(c.runs('acme', 'app')).rejects.toMatchObject({ kind: 'not-found' });
  });
});

describe('jobs', () => {
  it('maps jobs with steps', async () => {
    const { c } = client({ '/repos/acme/app/actions/runs/101/jobs?per_page=100': ok(fx('jobs.json')) });
    const jobs = await c.jobs('acme', 'app', 101);
    expect(jobs).toEqual([{
      id: 555, name: 'build', status: 'completed', conclusion: 'failure',
      startedAt: '2026-11-10T10:00:05Z', completedAt: '2026-11-10T10:04:00Z',
      steps: [
        { name: 'Set up job', status: 'completed', conclusion: 'success', number: 1, startedAt: '2026-11-10T10:00:05Z', completedAt: '2026-11-10T10:00:09Z' },
        { name: 'npm test', status: 'completed', conclusion: 'failure', number: 2 },
      ],
    }]);
  });
});

describe('workflowFile', () => {
  it('decodes base64 content', async () => {
    const { c, calls } = client({
      '/repos/acme/app/contents/.github/workflows/ci.yml?ref=abc123': ok(fx('contents.json')),
    });
    expect(await c.workflowFile('acme', 'app', '.github/workflows/ci.yml', 'abc123')).toBe('name: CI\non: push\n');
    expect(calls).toHaveLength(1);
  });
  it('returns null on 404', async () => {
    const { c } = client({});
    expect(await c.workflowFile('acme', 'app', 'x.yml', 'abc')).toBeNull();
  });
});

describe('non-404 failures', () => {
  const fail = { status: 500, headers: new Headers(), body: { message: 'boom' } };
  it('workflowFile rethrows', async () => {
    const { c } = client({ '/repos/acme/app/contents/x.yml?ref=abc': fail });
    await expect(c.workflowFile('acme', 'app', 'x.yml', 'abc')).rejects.toMatchObject({ kind: 'unavailable' });
  });
  it('jobLog rethrows', async () => {
    const { c } = client({ '/repos/acme/app/actions/jobs/1/logs': fail });
    await expect(c.jobLog('acme', 'app', 1)).rejects.toMatchObject({ kind: 'unavailable' });
  });
});

describe('mapping details', () => {
  it('strips @ref from workflow path and normalizes unknown status', async () => {
    const body = { workflow_runs: [{ id: 1, name: 'n', status: 'requested', path: '.github/workflows/ci.yml@refs/heads/main', created_at: 'x' }] };
    const { c } = client({ '/repos/acme/app/actions/runs?per_page=20': ok(body) });
    const [r] = await c.runs('acme', 'app');
    expect(r.workflowPath).toBe('.github/workflows/ci.yml');
    expect(r.status).toBe('queued');
  });
});

describe('jobLog', () => {
  it('returns the text', async () => {
    const { c } = client({ '/repos/acme/app/actions/jobs/555/logs': ok('line1\nline2') });
    expect(await c.jobLog('acme', 'app', 555)).toBe('line1\nline2');
  });
  it('returns null while unavailable', async () => {
    const { c } = client({});
    expect(await c.jobLog('acme', 'app', 555)).toBeNull();
  });
});

describe('no deployment or Vercel reads', () => {
  it('the client only reads runs, jobs, workflow files and logs', () => {
    const { c } = client({});
    expect(Object.keys(c).sort()).toEqual(['jobLog', 'jobs', 'runs', 'workflowFile']);
  });
});

describe('classifyGitHubError', () => {
  it('permissions', () => {
    const e = classifyGitHubError(403, new Headers(), { message: 'Resource not accessible by integration' });
    expect(e.kind).toBe('permissions');
  });
  it('rate limit with resetAt', () => {
    const h = new Headers({ 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1800000000' });
    for (const s of [403, 429]) {
      const e = classifyGitHubError(s, h, { message: 'API rate limit exceeded' });
      expect(e.kind).toBe('rate-limit');
      expect(e.resetAt).toBe(new Date(1800000000 * 1000).toISOString());
    }
  });
  it('401 is no-connection', () => {
    expect(classifyGitHubError(401, new Headers(), { message: 'Bad credentials' }).kind).toBe('no-connection');
  });
  it('secondary rate limit uses retry-after', () => {
    const e = classifyGitHubError(403, new Headers({ 'retry-after': '60' }), { message: 'secondary rate limit' });
    expect(e.kind).toBe('rate-limit');
    const delta = new Date(e.resetAt as string).getTime() - Date.now();
    expect(delta).toBeGreaterThan(50_000);
    expect(delta).toBeLessThanOrEqual(60_000);
  });
  it('an unavailable error carries the HTTP status, so a 410 can be told apart', () => {
    expect(classifyGitHubError(410, new Headers(), { message: 'Gone' })).toMatchObject({ kind: 'unavailable', status: 410 });
    expect(classifyGitHubError(503, new Headers(), {})).toMatchObject({ kind: 'unavailable', status: 503 });
  });
  it('5xx is unavailable', () => {
    expect(classifyGitHubError(500, new Headers(), { message: 'boom' }).kind).toBe('unavailable');
    expect(classifyGitHubError(422, new Headers(), {}).kind).toBe('unavailable');
  });
  it('not found', () => {
    expect(classifyGitHubError(404, new Headers(), { message: 'Not Found' }).kind).toBe('not-found');
  });
  it('other statuses carry the message', () => {
    expect(classifyGitHubError(500, new Headers(), { message: 'boom' }).message).toContain('boom');
  });
});

describe('resolveRepo', () => {
  const project = { path: '/p', autoBuildPath: '.vt' } as never;
  it('uses GITHUB_REPO config', async () => {
    vi.mocked(getGitHubConfigAsync).mockResolvedValue({ token: 't', repo: 'https://github.com/acme/app.git' });
    expect(await resolveRepo(project)).toEqual({ owner: 'acme', repo: 'app' });
  });
  it('falls back to ssh origin', async () => {
    vi.mocked(getGitHubConfigAsync).mockResolvedValue(null);
    gitAnswers('git@github.com:acme/app.git\n');
    expect(await resolveRepo(project)).toEqual({ owner: 'acme', repo: 'app' });
  });
  it('falls back to https origin', async () => {
    vi.mocked(getGitHubConfigAsync).mockResolvedValue(null);
    gitAnswers('https://github.com/acme/app\n');
    expect(await resolveRepo(project)).toEqual({ owner: 'acme', repo: 'app' });
  });
  it('null for GitLab', async () => {
    vi.mocked(getGitHubConfigAsync).mockResolvedValue(null);
    gitAnswers('git@gitlab.com:acme/app.git\n');
    expect(await resolveRepo(project)).toBeNull();
  });
  it('null when git fails', async () => {
    vi.mocked(getGitHubConfigAsync).mockResolvedValue(null);
    gitAnswers(new Error('no remote'));
    expect(await resolveRepo(project)).toBeNull();
  });
});
