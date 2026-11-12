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

  it('throws when the model returns no output', async () => {
    await expect(runReadinessScan(input, { run: fakeRun(null), feature, now })).rejects.toThrow();
  });

  it('propagates a rejected run', async () => {
    const run = vi.fn().mockRejectedValue(new Error('boom'));
    await expect(runReadinessScan(input, { run, feature, now })).rejects.toThrow('boom');
  });
});
