import { describe, expect, it, vi } from 'vitest';

import { blockerKey } from '../../../deploy/readiness-store';
import { READ_TOOLS } from '../../claude-code/task';
import { ReadinessScanSchema, type ScanInput, runReadinessScan } from '../deploy-readiness';

const input: ScanInput = {
  projectPath: '/tmp/proj',
  commit: 'abc123',
  secretNames: ['DATABASE_URL', 'STRIPE_SECRET_KEY'],
  // What `secrets.NAME` in the project's workflows reads (DATABASE_URL and STRIPE_SECRET_KEY are in GitHub already)
  workflowSecretNames: ['SENDGRID_KEY', 'CSRF_SECRET', 'WEB_ORIGIN', 'SESSION_COOKIE_SECURE', 'API_BASE_URL', 'NPM_TOKEN', 'DATABASE_URL', 'STRIPE_SECRET_KEY'],
  lastMainRun: { conclusion: 'failure', runId: 42, failedJobs: ['test'], workflowPath: '.github/workflows/ci.yml' },
};

const output = {
  blockers: [
    { kind: 'code', subject: 'Api Client Base URL', title: 'Hardcoded localhost', detail: 'src/api.ts uses localhost' },
    { kind: 'code', subject: 'api client base url', title: 'Duplicate', detail: 'again' },
    { kind: 'workflow', subject: 'ci browser install', title: 'No browser', detail: 'Playwright needs it' },
  ],
  owner: [{ kind: 'secret', variable: 'SENDGRID_KEY', message: 'Add it' }],
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

  it('puts every secret name in the prompt and no value', async () => {
    const run = fakeRun();
    await runReadinessScan({ ...input, secretNames: ['DATABASE_URL', 'STRIPE_SECRET_KEY'] }, { run, feature, now });
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

  it('copies lastMainRun, commit, scannedAt, owner and the workflow path; no services', async () => {
    const result = await runReadinessScan(input, { run: fakeRun(), feature, now });
    expect(result.workflow).toEqual({ path: '.github/workflows/ci.yml', lastMainRun: { conclusion: 'failure', runId: 42 } });
    expect(result.commit).toBe('abc123');
    expect(result.scannedAt).toBe('2026-11-12T10:00:00.000Z');
    expect(result).not.toHaveProperty('services');
    expect(result.owner[0]).toEqual({ kind: 'secret', variable: 'SENDGRID_KEY', message: 'Add it' });
  });

  it('the prompt is about CI and GitHub secrets: no Vercel, no database, no services', async () => {
    const run = fakeRun();
    await runReadinessScan(input, { run, feature, now });
    const { prompt, systemPrompt } = run.mock.calls[0][0] as { prompt: string; systemPrompt: string };
    expect(prompt).toContain('GitHub Actions secret names');
    expect(prompt).toMatch(/CI/);
    for (const text of [prompt, systemPrompt]) {
      expect(text).not.toMatch(/vercel/i);
      expect(text).not.toMatch(/deploy/i);
      expect(text).not.toMatch(/unsupported/i);
      expect(text).not.toMatch(/database added|services already/i);
    }
    expect(systemPrompt).toContain('GitHub Actions');
    expect(systemPrompt).toContain('${{ secrets.NAME }}');
    expect(systemPrompt).toContain('GITHUB_TOKEN');
    expect(systemPrompt).toMatch(/never ask for/i);
    expect(systemPrompt).not.toMatch(/### `services`/);
  });

  it('the schema has no unsupported blockers, no services and secret / other owner items', () => {
    const base = { blockers: [], owner: [] };
    expect(ReadinessScanSchema.safeParse(base).success).toBe(true);
    expect(ReadinessScanSchema.safeParse({ ...base, blockers: [{ kind: 'unsupported', subject: 's', title: 't', detail: 'd' }] }).success).toBe(false);
    expect(ReadinessScanSchema.safeParse({ ...base, owner: [{ kind: 'variable', variable: 'A_B', message: 'm' }] }).success).toBe(false);
    expect(ReadinessScanSchema.safeParse({ ...base, owner: [{ kind: 'secret', variable: 'A_B', message: 'm' }] }).success).toBe(true);
    expect(Object.keys(ReadinessScanSchema.shape)).not.toContain('services');
  });

  it('keeps a secret item only for a name a workflow reads that GitHub lacks, once', async () => {
    const out = {
      ...output,
      owner: [
        { kind: 'secret', variable: 'SENDGRID_KEY', message: 'a' },
        { kind: 'secret', variable: 'STRIPE_SECRET_KEY', message: 'configured already' },
        { kind: 'secret', variable: 'GITHUB_TOKEN', message: 'GitHub sets it' },
        { kind: 'secret', variable: 'sendgrid_key', message: 'repeat, other case' },
        { kind: 'secret', variable: 'npm_token', message: 'lower case in the workflow' },
        { kind: 'secret', message: 'no name' },
        { kind: 'secret', variable: 'NODE_ENV', message: 'no workflow reads it' },
        { kind: 'other', message: 'Turn on billing' },
      ],
    };
    const result = await runReadinessScan(input, { run: fakeRun(out), feature, now });
    expect(result.owner).toEqual([
      { kind: 'secret', variable: 'SENDGRID_KEY', message: 'a' },
      { kind: 'secret', variable: 'NPM_TOKEN', message: 'lower case in the workflow' },
      { kind: 'other', message: 'Turn on billing' },
      // The rest the workflows read and GitHub lacks, whether the model named them or not
      ...['CSRF_SECRET', 'WEB_ORIGIN', 'SESSION_COOKIE_SECURE', 'API_BASE_URL'].map((name) => ({ kind: 'secret', variable: name, message: `CI needs the secret ${name}.` })),
    ]);
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

  it('tells the agent that missing secrets are owner items, one per secret, never blockers', async () => {
    const run = fakeRun();
    await runReadinessScan(input, { run, feature, now });
    const system = (run.mock.calls[0][0] as { systemPrompt: string }).systemPrompt;
    expect(system).toContain('one item per secret');
    expect(system).toMatch(/never a blocker/i);
    expect(system).not.toContain('an env var that is read but never configured');
  });

  it('turns a code blocker into secret items when every name it lists is a secret a workflow reads', async () => {
    const out = {
      ...output,
      blockers: [
        { kind: 'code', subject: 'ci secrets', title: 'Required secrets are not configured', detail: 'ci.yml passes CSRF_SECRET, WEB_ORIGIN and SESSION_COOKIE_SECURE to the tests.' },
        { kind: 'workflow', subject: 'ci secrets', title: 'Missing secrets for the e2e job', detail: 'ci.yml needs SENDGRID_KEY.' },
      ],
    };
    const result = await runReadinessScan(input, { run: fakeRun(out), feature, now });
    // Workflow blockers are left alone: a CI gap is often a fix an agent can make
    expect(result.blockers.map((b) => b.title)).toEqual(['Missing secrets for the e2e job']);
    expect(result.owner.map((o) => [o.kind, o.variable])).toEqual([
      ['secret', 'SENDGRID_KEY'],
      ['secret', 'CSRF_SECRET'],
      ['secret', 'WEB_ORIGIN'],
      ['secret', 'SESSION_COOKIE_SECURE'],
      ['secret', 'API_BASE_URL'],
      ['secret', 'NPM_TOKEN'],
    ]);
    expect(result.owner[1].message).toBe('CI needs the secret CSRF_SECRET.');
  });

  it('keeps the code blocker when a name it lists is not read by a workflow, or is in GitHub already', async () => {
    const out = {
      ...output,
      blockers: [
        // NODE_ENV and VERCEL_URL: no workflow reads them as secrets; an agent can fix the code
        { kind: 'code', subject: 'api env vars', title: 'Required API env vars are not configured', detail: 'config.ts reads CSRF_SECRET, NODE_ENV and VERCEL_URL.' },
        // DATABASE_URL is in GitHub already
        { kind: 'code', subject: 'db url', title: 'CSRF_SECRET and DATABASE_URL are missing', detail: 'db.ts' },
      ],
    };
    const result = await runReadinessScan(input, { run: fakeRun(out), feature, now });
    expect(result.blockers.map((b) => b.title)).toEqual(['Required API env vars are not configured', 'CSRF_SECRET and DATABASE_URL are missing']);
    expect(result.owner.map((o) => o.variable)).toEqual(['SENDGRID_KEY', 'CSRF_SECRET', 'WEB_ORIGIN', 'SESSION_COOKIE_SECURE', 'API_BASE_URL', 'NPM_TOKEN']);
  });

  it('no workflow secrets read: no secret items at all, every code blocker stays', async () => {
    const out = { ...output, blockers: [{ kind: 'code', subject: 's', title: 'CSRF_SECRET is not set', detail: 'd' }] };
    const result = await runReadinessScan({ ...input, workflowSecretNames: [] }, { run: fakeRun(out), feature, now });
    expect(result.blockers.map((b) => b.title)).toEqual(['CSRF_SECRET is not set']);
    expect(result.owner).toEqual([]);
  });

  it('tells the agent which secrets the workflows read', async () => {
    const run = fakeRun();
    await runReadinessScan(input, { run, feature, now });
    expect((run.mock.calls[0][0] as { prompt: string }).prompt).toContain('Secrets the workflows read: SENDGRID_KEY, CSRF_SECRET');
  });

  const scanBlockers = async (blockers: Array<{ title: string; detail: string }>) => {
    const out = { ...output, blockers: blockers.map((b, i) => ({ kind: 'code', subject: `s${i}`, ...b })) };
    return runReadinessScan(input, { run: fakeRun(out), feature, now });
  };
  const variables = (r: Awaited<ReturnType<typeof scanBlockers>>) => r.owner.filter((o) => o.kind === 'secret').map((o) => o.variable);

  it('keeps blockers that are about variables but not about values missing', async () => {
    const r = await scanBlockers([
      { title: 'Env var validation is missing', detail: 'env.ts never checks FOO_BAR.' },
      { title: 'Undefined variable breaks the build', detail: 'src/a.ts uses FOO_BAR before it is declared.' },
    ]);
    expect(r.blockers.map((b) => b.title)).toEqual(['Env var validation is missing', 'Undefined variable breaks the build']);
    expect(variables(r)).toEqual(['SENDGRID_KEY', 'CSRF_SECRET', 'WEB_ORIGIN', 'SESSION_COOKIE_SECURE', 'API_BASE_URL', 'NPM_TOKEN']);
  });

  it('takes the names from the title first, the detail only when the title has none', async () => {
    const r = await scanBlockers([{ title: 'API_BASE_URL is not set in production build', detail: 'web/vite.config.ts also mentions OTHER_NAME.' }]);
    expect(r.blockers).toEqual([]);
    expect(variables(r)).toEqual(['SENDGRID_KEY', 'API_BASE_URL', 'CSRF_SECRET', 'WEB_ORIGIN', 'SESSION_COOKIE_SECURE', 'NPM_TOKEN']);
  });

  it('ignores names without an underscore and the platform\'s own variables', async () => {
    const r = await scanBlockers([
      { title: 'Env vars are not configured', detail: 'server.ts reads PORT.' },
      { title: 'PORT is not set', detail: 'server.ts reads PORT.' },
      { title: 'Env vars are not configured', detail: 'deploy reads GITHUB_TOKEN and CSRF_SECRET.' },
    ]);
    expect(r.blockers.map((b) => b.title)).toEqual(['Env vars are not configured', 'PORT is not set']);
    expect(variables(r)).toEqual(['SENDGRID_KEY', 'CSRF_SECRET', 'WEB_ORIGIN', 'SESSION_COOKIE_SECURE', 'API_BASE_URL', 'NPM_TOKEN']);
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
    expect(variables(r)).toEqual(['SENDGRID_KEY', 'CSRF_SECRET', 'WEB_ORIGIN', 'SESSION_COOKIE_SECURE', 'API_BASE_URL', 'NPM_TOKEN']);
  });

  it('keeps a variable blocker it cannot name a variable for', async () => {
    const out = { ...output, blockers: [{ kind: 'code', subject: 'env', title: 'Env vars not configured', detail: 'Some settings are missing.' }] };
    const result = await runReadinessScan(input, { run: fakeRun(out), feature, now });
    expect(result.blockers).toHaveLength(1);
  });

  it('secret names unknown (the listing failed): no secret items at all, none marked missing; the prompt says so', async () => {
    const out = {
      ...output,
      blockers: [...output.blockers, { kind: 'code', subject: 'ci secrets', title: 'CSRF_SECRET is not set', detail: 'd' }],
      owner: [{ kind: 'secret', variable: 'SENDGRID_KEY', message: 'Add it' }, { kind: 'other', message: 'Turn on billing' }],
    };
    const run = fakeRun(out);
    const { secretNames: _s, ...unknown } = input;
    const result = await runReadinessScan(unknown, { run, feature, now });
    expect(result.owner).toEqual([{ kind: 'other', message: 'Turn on billing' }]);
    // A blocker only about secrets the workflows read is neither a task nor an item: GitHub may have them
    expect(result.blockers.map((b) => b.title)).not.toContain('CSRF_SECRET is not set');
    expect((run.mock.calls[0][0] as { prompt: string }).prompt).toContain('could not be listed');
  });

  it('the listing succeeded: every secret a workflow reads that GitHub lacks is an item, even when the model names none', async () => {
    const out = { ...output, owner: [{ kind: 'secret', variable: 'NPM_TOKEN', message: 'From the model' }] };
    const result = await runReadinessScan(
      { ...input, workflowSecretNames: ['NPM_TOKEN', 'CSRF_SECRET', 'DATABASE_URL', 'GITHUB_TOKEN'] },
      { run: fakeRun(out), feature, now },
    );
    expect(result.owner).toEqual([
      { kind: 'secret', variable: 'NPM_TOKEN', message: 'From the model' },
      { kind: 'secret', variable: 'CSRF_SECRET', message: 'CI needs the secret CSRF_SECRET.' },
    ]);
  });

  it('throws when the model returns no output', async () => {
    await expect(runReadinessScan(input, { run: fakeRun(null), feature, now })).rejects.toThrow();
  });

  it('propagates a rejected run', async () => {
    const run = vi.fn().mockRejectedValue(new Error('boom'));
    await expect(runReadinessScan(input, { run, feature, now })).rejects.toThrow('boom');
  });
});

describe('known blockers keep their keys (roadmaply: the same problems came back under new subjects)', () => {
  const known = [
    { key: 'code-api-migrations', kind: 'code' as const, subject: 'api migrations', title: 'Prisma migrations never run on deploy' },
    { key: 'code-web-api-base-url', kind: 'code' as const, subject: 'web api base url', title: 'Web app falls back to hardcoded localhost API' },
    { key: 'code-transactional-email', kind: 'code' as const, title: 'Only a console email provider exists' },
  ];
  const scan = (blockers: unknown[]) =>
    runReadinessScan({ ...input, knownBlockers: known }, { run: fakeRun({ ...output, blockers }), feature, now });

  it('lists the known blockers in the prompt and asks to reuse their subjects', async () => {
    const run = fakeRun();
    await runReadinessScan({ ...input, knownBlockers: known }, { run, feature, now });
    const prompt = (run.mock.calls[0][0] as { prompt: string }).prompt;
    expect(prompt).toContain('Known blockers');
    expect(prompt).toContain('api migrations');
    expect(prompt).toContain('Prisma migrations never run on deploy');
    expect(prompt).toContain('reuse its subject exactly');
  });

  it('caps the known list at 30', async () => {
    const run = fakeRun();
    const many = Array.from({ length: 40 }, (_, i) => ({ key: `code-k${i}`, kind: 'code' as const, subject: `thing ${i}`, title: `Title ${i}` }));
    await runReadinessScan({ ...input, knownBlockers: many }, { run, feature, now });
    const prompt = (run.mock.calls[0][0] as { prompt: string }).prompt;
    expect(prompt).toContain('thing 29');
    expect(prompt).not.toContain('thing 30');
  });

  it('says nothing about known blockers when there are none', async () => {
    const run = fakeRun();
    await runReadinessScan(input, { run, feature, now });
    expect((run.mock.calls[0][0] as { prompt: string }).prompt).not.toContain('Known blockers');
  });

  it('a new subject with the same title reuses the known key', async () => {
    const result = await scan([{ kind: 'code', subject: 'database migrations', title: 'Prisma migrations never run on deploy', detail: 'd' }]);
    expect(result.blockers.map((b) => b.key)).toEqual(['code-api-migrations']);
  });

  it('a reworded title of the same thing reuses the known key', async () => {
    const result = await scan([{ kind: 'code', subject: 'api client base url', title: 'Web API client falls back to localhost', detail: 'd' }]);
    expect(result.blockers.map((b) => b.key)).toEqual(['code-web-api-base-url']);
  });

  it('the known subject returned by the model gives the known key', async () => {
    const result = await scan([{ kind: 'code', subject: 'transactional email', title: 'No real email transport', detail: 'd' }]);
    expect(result.blockers.map((b) => b.key)).toEqual(['code-transactional-email']);
  });

  it('an unrelated blocker keeps its own key', async () => {
    const result = await scan([{ kind: 'code', subject: 'logo upload storage', title: 'Uploads use the local filesystem', detail: 'd' }]);
    expect(result.blockers.map((b) => b.key)).toEqual([blockerKey('code', 'logo upload storage')]);
  });

  it('a different kind never takes a known key', async () => {
    const result = await scan([{ kind: 'workflow', subject: 'database migrations', title: 'Prisma migrations never run on deploy', detail: 'd' }]);
    expect(result.blockers.map((b) => b.key)).toEqual([blockerKey('workflow', 'database migrations')]);
  });

  it('a blocker naming the known subject exactly wins the key over a looser match before it', async () => {
    const result = await scan([
      { kind: 'code', subject: 'database migrations', title: 'Prisma migrations never run on deploy', detail: 'd' },
      { kind: 'code', subject: 'api migrations', title: 'Migrations', detail: 'd' },
    ]);
    expect(result.blockers.map((b) => b.key)).toEqual([blockerKey('code', 'database migrations'), 'code-api-migrations']);
  });

  it('the prompt names each known blocker by its key and a subject in words, also when only the key is known', async () => {
    const run = fakeRun();
    await runReadinessScan({ ...input, knownBlockers: known }, { run, feature, now });
    const prompt = (run.mock.calls[0][0] as { prompt: string }).prompt;
    expect(prompt).toContain('code-transactional-email');
    expect(prompt).toMatch(/subject "transactional email"/);
    expect(prompt).toContain('sameAs');
  });

  it('a model that copies the prompt\'s own words back keeps every known key', async () => {
    const run = fakeRun();
    await runReadinessScan({ ...input, knownBlockers: known }, { run, feature, now });
    const prompt = (run.mock.calls[0][0] as { prompt: string }).prompt;
    const echoed = known.map((k) => {
      const line = prompt.split('\n').find((l) => l.includes(k.key)) as string;
      return { kind: 'code', subject: /subject "([^"]+)"/.exec(line)?.[1] ?? '', title: k.title, detail: 'd' };
    });
    // and a model that puts the key itself in the subject
    const keyed = [{ kind: 'code', subject: 'code-transactional-email', title: 'x', detail: 'd' }];
    expect((await scan(echoed)).blockers.map((b) => b.key)).toEqual(known.map((k) => k.key));
    expect((await scan(keyed)).blockers.map((b) => b.key)).toEqual(['code-transactional-email']);
  });

  it('sameAs merges what words cannot (roadmaply: email, logo)', async () => {
    const logoKnown = { key: 'code-logo-upload-storage', kind: 'code' as const, subject: 'logo upload storage', title: 'Logo uploads write to local disk' };
    const result = await runReadinessScan(
      { ...input, knownBlockers: [...known, logoKnown] },
      {
        run: fakeRun({
          ...output,
          blockers: [
            { kind: 'code', subject: 'email provider', title: 'No real email transport', detail: 'd', sameAs: 'code-transactional-email' },
            { kind: 'code', subject: 'logo storage adapter', title: 'Uploads use the local filesystem', detail: 'd', sameAs: 'code-logo-upload-storage' },
          ],
        }),
        feature,
        now,
      },
    );
    expect(result.blockers.map((b) => b.key)).toEqual(['code-transactional-email', 'code-logo-upload-storage']);
  });

  it('a sameAs that is not a known key of that kind is ignored', async () => {
    const result = await scan([{ kind: 'workflow', subject: 'ci browser install', title: 'No browsers', detail: 'd', sameAs: 'code-api-migrations' }]);
    expect(result.blockers.map((b) => b.key)).toEqual([blockerKey('workflow', 'ci browser install')]);
  });

  it('without sameAs, different things with alike words stay apart', async () => {
    const wfKnown = [
      { key: 'workflow-ci-playwright-browser-install', kind: 'workflow' as const, subject: 'ci playwright browser install', title: 'Browsers are not installed for Playwright' },
      { key: 'workflow-ci-postgres-service-container', kind: 'workflow' as const, subject: 'ci postgres service container', title: 'CI has no Postgres service container' },
      { key: 'code-api-localhost-url', kind: 'code' as const, subject: 'api localhost url', title: 'The web app calls a localhost API' },
    ];
    const blockers = [
      { kind: 'workflow', subject: 'ci vitest browser install', title: 'Browsers are not installed for Vitest', detail: 'd' },
      { kind: 'workflow', subject: 'ci redis service container', title: 'CI has no Redis service container', detail: 'd' },
      { kind: 'code', subject: 'websocket localhost url', title: 'The web app opens a localhost websocket', detail: 'd' },
    ];
    const result = await runReadinessScan({ ...input, knownBlockers: wfKnown }, { run: fakeRun({ ...output, blockers }), feature, now });
    expect(result.blockers.map((b) => b.key)).toEqual(blockers.map((b) => blockerKey(b.kind as 'code', b.subject)));
  });

  it('keys do not depend on the order the model lists blockers in', async () => {
    const a = { kind: 'code', subject: 'migrations', title: 'Prisma migrations run on deploy too late', detail: 'd' };
    const b = { kind: 'code', subject: 'database migrations', title: 'Prisma migrations never run on deploy', detail: 'd' };
    const keys = async (list: unknown[]) => Object.fromEntries((await scan(list)).blockers.map((x) => [x.subject, x.key]));
    expect(await keys([a, b])).toEqual(await keys([b, a]));
    expect((await keys([a, b]))['database migrations']).toBe('code-api-migrations');
  });

  it('one known key goes to one blocker only', async () => {
    const result = await scan([
      { kind: 'code', subject: 'database migrations', title: 'Prisma migrations never run on deploy', detail: 'd' },
      { kind: 'code', subject: 'migrations', title: 'Prisma migrations never run on deploy', detail: 'again' },
    ]);
    expect(result.blockers.map((b) => b.key)).toEqual(['code-api-migrations', blockerKey('code', 'migrations')]);
  });
});
