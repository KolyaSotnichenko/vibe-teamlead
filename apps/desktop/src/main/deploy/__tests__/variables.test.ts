import { describe, it, expect, vi } from 'vitest';
import type { DeployProjectSettings, VercelError } from '../../../shared/types/deploy';
import { GitHubWriteError } from '../github-write';
import { setDeployVariable, listDeployVariables, type VariablesDeps } from '../variables';

const VALUE = 'pa"ss\'wörd 🔑\nline2 \\ DISTINCT_9f3a\n';
const settings: DeployProjectSettings = {
  enabled: true,
  repo: { owner: 'me', repo: 'app', createdByApp: true },
  vercel: { projectId: 'prj_1', projectName: 'app', teamId: 'team_1' },
};

function makeDeps(over: Partial<VariablesDeps> = {}) {
  const upsertEnv = vi.fn(async () => {});
  const listEnvNames = vi.fn(async () => [
    { key: 'A_KEY', targets: ['production'] },
    { key: 'B_KEY', targets: ['production', 'preview'] },
  ]);
  const scopes: unknown[] = [];
  const setRepoSecret = vi.fn(async () => {});
  const listRepoSecretNames = vi.fn(async () => ['B_KEY']);
  const deps: VariablesDeps = {
    vercelClient: (scope) => {
      scopes.push(scope);
      return { upsertEnv, listEnvNames } as never;
    },
    setRepoSecret,
    listRepoSecretNames,
    ...over,
  };
  return { deps, upsertEnv, listEnvNames, setRepoSecret, listRepoSecretNames, scopes };
}
const input = { name: 'API_KEY', value: VALUE, targets: ['production', 'preview'] as Array<'production' | 'preview'>, alsoGitHubSecret: true };

describe('setDeployVariable', () => {
  it('passes the value exactly to Vercel (sensitive) and GitHub', async () => {
    const m = makeDeps();
    const r = await setDeployVariable(settings, input, m.deps);
    expect(r).toEqual({ ok: true, vercel: 'ok', github: 'ok' });
    expect(m.upsertEnv).toHaveBeenCalledWith('prj_1', { key: 'API_KEY', value: VALUE, targets: ['production', 'preview'], sensitive: true });
    expect(m.setRepoSecret).toHaveBeenCalledWith('me', 'app', 'API_KEY', VALUE);
    expect(m.scopes[0]).toEqual({ teamId: 'team_1' });
  });

  it('skips GitHub when not asked', async () => {
    const m = makeDeps();
    const r = await setDeployVariable(settings, { ...input, alsoGitHubSecret: false }, m.deps);
    expect(r).toEqual({ ok: true, vercel: 'ok', github: 'skipped' });
    expect(m.setRepoSecret).not.toHaveBeenCalled();
  });

  it('reports which side failed when GitHub fails after Vercel; no value anywhere', async () => {
    const m = makeDeps({
      setRepoSecret: vi.fn(async () => {
        throw new GitHubWriteError('permissions', 'Approve the permissions');
      }),
    });
    const r = await setDeployVariable(settings, input, m.deps);
    expect(r).toMatchObject({ ok: false, vercel: 'ok', github: { kind: 'permissions' } });
    expect(JSON.stringify(r)).not.toContain('DISTINCT_9f3a');
  });

  it('reports a Vercel failure and does not touch GitHub', async () => {
    const err: VercelError = { kind: 'bad-request', message: 'nope' };
    const m = makeDeps();
    m.upsertEnv.mockRejectedValueOnce(err);
    const r = await setDeployVariable(settings, input, m.deps);
    expect(r).toMatchObject({ ok: false, vercel: { kind: 'bad-request', message: 'nope' }, github: 'skipped' });
    expect(m.setRepoSecret).not.toHaveBeenCalled();
  });

  it('never leaks the value even if a dependency error contains it', async () => {
    const m = makeDeps();
    m.upsertEnv.mockRejectedValueOnce(new Error(`boom ${VALUE}`));
    const r = await setDeployVariable(settings, input, m.deps);
    expect(JSON.stringify(r)).not.toContain('DISTINCT_9f3a');
    const m2 = makeDeps({
      setRepoSecret: vi.fn(async () => {
        throw new Error(`boom ${VALUE}`);
      }),
    });
    const r2 = await setDeployVariable(settings, input, m2.deps);
    expect(JSON.stringify(r2)).not.toContain('DISTINCT_9f3a');
    expect(r2).toMatchObject({ vercel: 'ok', github: { kind: 'unavailable' } });
  });

  it.each(['lower', '1ABC', 'A-B', '', 'A B'])('refuses invalid name %j before any request', async (name) => {
    const m = makeDeps();
    const r = await setDeployVariable(settings, { ...input, name }, m.deps);
    expect(r).toMatchObject({ ok: false, vercel: { kind: 'invalid' } });
    expect(m.upsertEnv).not.toHaveBeenCalled();
    expect(m.setRepoSecret).not.toHaveBeenCalled();
  });

  it('refuses GITHUB_ names for a secret before any request, but allows them for Vercel only', async () => {
    const m = makeDeps();
    const r = await setDeployVariable(settings, { ...input, name: 'GITHUB_TOKEN' }, m.deps);
    expect(r).toMatchObject({ ok: false, github: { kind: 'invalid' } });
    expect(m.upsertEnv).not.toHaveBeenCalled();
    const r2 = await setDeployVariable(settings, { ...input, name: 'GITHUB_TOKEN', alsoGitHubSecret: false }, m.deps);
    expect(r2).toMatchObject({ ok: true });
  });

  it('refuses empty targets and unknown targets', async () => {
    const m = makeDeps();
    expect(await setDeployVariable(settings, { ...input, targets: [] }, m.deps)).toMatchObject({ ok: false, vercel: { kind: 'invalid' } });
    expect(await setDeployVariable(settings, { ...input, targets: ['development' as never] }, m.deps)).toMatchObject({ ok: false });
    expect(m.upsertEnv).not.toHaveBeenCalled();
  });

  it('returns not-set-up without vercel or repo', async () => {
    const m = makeDeps();
    expect(await setDeployVariable({ enabled: false }, input, m.deps)).toEqual({ ok: false, kind: 'not-set-up', message: expect.any(String) });
    expect(await setDeployVariable({ ...settings, repo: undefined }, input, m.deps)).toMatchObject({ kind: 'not-set-up' });
    // no repo is fine when no secret is wanted? still a deploy project needs repo
    expect(m.upsertEnv).not.toHaveBeenCalled();
  });
});

describe('listDeployVariables', () => {
  it('returns names, targets and inGitHub only', async () => {
    const m = makeDeps();
    const r = await listDeployVariables(settings, m.deps);
    expect(r).toEqual({
      ok: true,
      variables: [
        { name: 'A_KEY', targets: ['production'], inGitHub: false },
        { name: 'B_KEY', targets: ['production', 'preview'], inGitHub: true },
      ],
    });
  });

  it('still lists Vercel names when GitHub secrets cannot be read (inGitHub unknown -> false, flagged)', async () => {
    const m = makeDeps({
      listRepoSecretNames: vi.fn(async () => {
        throw new GitHubWriteError('permissions', 'x');
      }),
    });
    const r = await listDeployVariables(settings, m.deps);
    expect(r).toMatchObject({ ok: true, githubUnavailable: { kind: 'permissions' } });
  });

  it('reports a Vercel failure', async () => {
    const m = makeDeps();
    m.listEnvNames.mockRejectedValueOnce({ kind: 'unauthorized', message: 'no' });
    expect(await listDeployVariables(settings, m.deps)).toEqual({ ok: false, kind: 'unauthorized', message: 'no' });
  });

  it('returns not-set-up', async () => {
    const m = makeDeps();
    expect(await listDeployVariables({ enabled: false }, m.deps)).toMatchObject({ ok: false, kind: 'not-set-up' });
  });
});
