import { describe, expect, it, vi } from 'vitest';

import { blockerKey } from '../../../deploy/readiness-store';
import { READ_TOOLS } from '../../claude-code/task';
import { type ScanInput, runReadinessScan } from '../deploy-readiness';

const input: ScanInput = {
  projectPath: '/tmp/proj',
  commit: 'abc123',
  variableNames: ['DATABASE_URL', 'STRIPE_SECRET_KEY'],
  databaseAdded: true,
  servicesAdded: ['postgres'],
  lastMainRun: { conclusion: 'failure', runId: 42, failedJobs: ['test'], workflowPath: '.github/workflows/ci.yml' },
};

const output = {
  blockers: [
    { kind: 'code', subject: 'Api Client Base URL', title: 'Hardcoded localhost', detail: 'src/api.ts uses localhost' },
    { kind: 'code', subject: 'api client base url', title: 'Duplicate', detail: 'again' },
    { kind: 'workflow', subject: 'ci browser install', title: 'No browser', detail: 'Playwright needs it' },
  ],
  services: [{ kind: 'postgres', name: 'db', managed: true }],
  owner: [{ kind: 'variable', variable: 'SENDGRID_KEY', message: 'Add it' }],
  workflowPath: '.github/workflows/ci.yml',
};

const fakeRun = (out: unknown = output) => vi.fn(async (_options: unknown) => ({ text: '', output: out, session: {} }) as never);
const feature = () => ({ model: 'opus', thinkingLevel: 'high' });
const now = () => new Date('2026-11-12T10:00:00.000Z');

describe('runReadinessScan', () => {
  it('calls the task with read tools, the agent type, cwd, turns and the feature settings', async () => {
    const run = fakeRun();
    await runReadinessScan(input, { run, feature, now });
    const options = run.mock.calls[0][0] as Record<string, unknown>;
    expect(options.tools).toEqual(READ_TOOLS);
    expect(options.agentType).toBe('deploy_readiness');
    expect(options.cwd).toBe('/tmp/proj');
    expect(options.maxTurns).toBe(40);
    expect(options.model).toBe('opus');
    expect(options.thinkingLevel).toBe('high');
    expect(options.outputSchema).toBeDefined();
  });

  it('puts every variable name in the prompt and no value', async () => {
    const run = fakeRun();
    await runReadinessScan({ ...input, variableNames: ['DATABASE_URL', 'STRIPE_SECRET_KEY'] }, { run, feature, now });
    const prompt = (run.mock.calls[0][0] as { prompt: string }).prompt;
    expect(prompt).toContain('DATABASE_URL');
    expect(prompt).toContain('STRIPE_SECRET_KEY');
    expect(prompt).not.toMatch(/=/);
    expect(prompt).toContain('ci.yml');
  });

  it('keys blockers and collapses subjects that differ only in case', async () => {
    const result = await runReadinessScan(input, { run: fakeRun(), feature, now });
    expect(result.blockers.map((b) => b.key)).toEqual([
      blockerKey('code', 'Api Client Base URL'),
      blockerKey('workflow', 'ci browser install'),
    ]);
    expect(result.blockers[0].title).toBe('Hardcoded localhost');
  });

  it('copies lastMainRun, commit, scannedAt, services, owner and the workflow path', async () => {
    const result = await runReadinessScan(input, { run: fakeRun(), feature, now });
    expect(result.workflow).toEqual({ path: '.github/workflows/ci.yml', lastMainRun: { conclusion: 'failure', runId: 42 } });
    expect(result.commit).toBe('abc123');
    expect(result.scannedAt).toBe('2026-11-12T10:00:00.000Z');
    expect(result.services).toHaveLength(1);
    expect(result.owner[0].variable).toBe('SENDGRID_KEY');
  });

  it('clips long answers instead of failing: title 120, detail 2000, subject 120 before keying, owner message 500', async () => {
    const long = {
      ...output,
      blockers: [{ kind: 'code', subject: `s${'u'.repeat(300)}`, title: `t\n${'x'.repeat(300)}`, detail: 'd'.repeat(5000) }],
      owner: [{ kind: 'other', message: 'm'.repeat(2000) }],
    };
    const result = await runReadinessScan(input, { run: fakeRun(long), feature, now });
    const [b] = result.blockers;
    expect(b.title.length).toBeLessThanOrEqual(120);
    expect(b.title).not.toContain('\n');
    expect(b.detail.length).toBeLessThanOrEqual(2000);
    expect(b.subject.length).toBeLessThanOrEqual(120);
    expect(b.key).toBe(blockerKey('code', b.subject));
    expect(result.owner[0].message.length).toBeLessThanOrEqual(500);
  });

  it('tells the agent env values are off-limits (names from example files only)', async () => {
    const run = fakeRun();
    await runReadinessScan(input, { run, feature, now });
    const system = (run.mock.calls[0][0] as { systemPrompt: string }).systemPrompt;
    expect(system).toContain('Environment values are off-limits');
    expect(system).toContain('example env files');
  });

  it('tells the agent that unconfigured variables are owner items, one per variable, never blockers', async () => {
    const run = fakeRun();
    await runReadinessScan(input, { run, feature, now });
    const system = (run.mock.calls[0][0] as { systemPrompt: string }).systemPrompt;
    expect(system).toContain('one item per variable');
    expect(system).toContain("the app's own settings and secrets");
    expect(system).toMatch(/never a blocker/i);
    expect(system).not.toContain('an env var that is read but never configured');
  });

  it('turns a blocker that only says variables are not configured into owner variable items', async () => {
    const out = {
      ...output,
      blockers: [
        { kind: 'code', subject: 'api env vars', title: 'Required API env vars are not configured', detail: 'apps/api/src/config.ts reads CSRF_SECRET, WEB_ORIGIN, SESSION_COOKIE_SECURE and DATABASE_URL; NODE_ENV and VERCEL_URL too.' },
        { kind: 'workflow', subject: 'ci secrets', title: 'Missing secrets for the deploy job', detail: 'deploy.yml needs SENDGRID_KEY.' },
        { kind: 'code', subject: 'api client base url', title: 'Hardcoded localhost', detail: 'src/api.ts uses localhost; read API_BASE_URL instead.' },
        { kind: 'code', subject: 'env validation', title: 'Missing env validation crashes the build', detail: 'zod schema in env.ts throws on MY_FLAG.' },
      ],
    };
    const result = await runReadinessScan(input, { run: fakeRun(out), feature, now });
    // Workflow blockers are left alone: a CI gap is often a fix an agent can make
    expect(result.blockers.map((b) => b.title)).toEqual(['Missing secrets for the deploy job', 'Hardcoded localhost', 'Missing env validation crashes the build']);
    // Configured (DATABASE_URL), already listed (SENDGRID_KEY) and Vercel's own (NODE_ENV, VERCEL_URL) are not added
    expect(result.owner.map((o) => [o.kind, o.variable])).toEqual([
      ['variable', 'SENDGRID_KEY'],
      ['variable', 'CSRF_SECRET'],
      ['variable', 'WEB_ORIGIN'],
      ['variable', 'SESSION_COOKIE_SECURE'],
    ]);
  });

  const scanBlockers = async (blockers: Array<{ title: string; detail: string }>) => {
    const out = { ...output, blockers: blockers.map((b, i) => ({ kind: 'code', subject: `s${i}`, ...b })) };
    return runReadinessScan(input, { run: fakeRun(out), feature, now });
  };
  const variables = (r: Awaited<ReturnType<typeof scanBlockers>>) => r.owner.filter((o) => o.kind === 'variable').map((o) => o.variable);

  it('keeps blockers that are about variables but not about values missing', async () => {
    const r = await scanBlockers([
      { title: 'Env var validation is missing', detail: 'env.ts never checks FOO_BAR.' },
      { title: 'Undefined variable breaks the build', detail: 'src/a.ts uses FOO_BAR before it is declared.' },
    ]);
    expect(r.blockers.map((b) => b.title)).toEqual(['Env var validation is missing', 'Undefined variable breaks the build']);
    expect(variables(r)).toEqual(['SENDGRID_KEY']);
  });

  it('takes the names from the title first, the detail only when the title has none', async () => {
    const r = await scanBlockers([{ title: 'API_BASE_URL is not set in production build', detail: 'web/vite.config.ts also mentions OTHER_NAME.' }]);
    expect(r.blockers).toEqual([]);
    expect(variables(r)).toEqual(['SENDGRID_KEY', 'API_BASE_URL']);
  });

  it('ignores names without an underscore and the platform\'s own variables', async () => {
    const r = await scanBlockers([
      { title: 'Env vars are not configured', detail: 'server.ts reads PORT.' },
      { title: 'PORT is not set', detail: 'server.ts reads PORT.' },
      { title: 'Env vars are not configured', detail: 'deploy reads GITHUB_TOKEN and CSRF_SECRET.' },
    ]);
    expect(r.blockers.map((b) => b.title)).toEqual(['Env vars are not configured', 'PORT is not set']);
    expect(variables(r)).toEqual(['SENDGRID_KEY', 'CSRF_SECRET']);
  });

  it('drops a blocker only when its variables are owner items now', async () => {
    const r = await scanBlockers([
      // Configured already: nothing to add, so the blocker stays for the agent to look at
      { title: 'DATABASE_URL is not configured', detail: 'db.ts' },
      { title: 'GITHUB_TOKEN is missing', detail: 'release.ts' },
      // Already listed for the owner
      { title: 'SENDGRID_KEY is not set', detail: 'mail.ts' },
    ]);
    expect(r.blockers.map((b) => b.title)).toEqual(['DATABASE_URL is not configured', 'GITHUB_TOKEN is missing']);
    expect(variables(r)).toEqual(['SENDGRID_KEY']);
  });

  it('keeps a variable blocker it cannot name a variable for', async () => {
    const out = { ...output, blockers: [{ kind: 'code', subject: 'env', title: 'Env vars not configured', detail: 'Some settings are missing.' }] };
    const result = await runReadinessScan(input, { run: fakeRun(out), feature, now });
    expect(result.blockers).toHaveLength(1);
  });

  it('throws when the model returns no output', async () => {
    await expect(runReadinessScan(input, { run: fakeRun(null), feature, now })).rejects.toThrow();
  });

  it('propagates a rejected run', async () => {
    const run = vi.fn().mockRejectedValue(new Error('boom'));
    await expect(runReadinessScan(input, { run, feature, now })).rejects.toThrow('boom');
  });
});
