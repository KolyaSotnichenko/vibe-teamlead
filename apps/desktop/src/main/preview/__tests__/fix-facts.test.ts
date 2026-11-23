import { describe, expect, it } from 'vitest';

import type { PreviewEnvReport } from '../../../shared/types/preview';
import { fixFacts, FIX_TOOLS } from '../fix-facts';

const ENV: PreviewEnvReport = {
  running: false, restartNeeded: false, databases: ['postgres'], composeServices: ['azurite'], mail: false, dockerUnavailable: false,
  services: [{
    service: 'api', dir: 'apps/api',
    vars: [
      { name: 'DATABASE_URL', value: 'postgresql://verify:s3cret@127.0.0.1:5432/verify', source: 'database' },
      { name: 'STRIPE_SECRET_KEY', value: 'sk_live_do_not_show', source: 'override' },
      { name: 'FEATURE_X', value: 'on', source: 'example' },
      { name: 'REDIS_URL', value: '', source: 'blocked' },
    ],
  }],
};

describe('what the app tells the agent that fixes a start', () => {
  const facts = (over: Partial<Parameters<typeof fixFacts>[0]> = {}) =>
    fixFacts({ dockerAnswers: true, onPath: (name) => ['node', 'pnpm'].includes(name), env: ENV, runningMd: null, ...over }).join('\n');

  it('says whether Docker answers', () => {
    expect(facts()).toMatch(/Docker answers/);
    expect(facts({ dockerAnswers: false })).toMatch(/Docker does not answer/);
  });

  it('says which tools are on the search path and which are not', () => {
    const text = facts();
    expect(text).toMatch(/On the search path: node, pnpm/);
    expect(text).toMatch(/Not on the search path: .*python3/);
    expect(FIX_TOOLS).toEqual(expect.arrayContaining(['node', 'pnpm', 'npm', 'yarn', 'bun', 'python3', 'uv', 'poetry', 'ruby', 'bundle', 'php', 'composer', 'go']));
  });

  it("names each service's variables with where each came from, and never a value", () => {
    const text = facts();
    expect(text).toMatch(/api \(apps\/api\)/);
    expect(text).toMatch(/DATABASE_URL \[database\]/);
    expect(text).toMatch(/STRIPE_SECRET_KEY \[override\]/);
    expect(text).toMatch(/REDIS_URL \[blocked, empty\]/);
    expect(text).not.toContain('s3cret');
    expect(text).not.toContain('sk_live_do_not_show');
    expect(text).not.toContain('=on');
  });

  it('says what the preview starts in Docker for the project', () => {
    expect(facts()).toMatch(/postgres/);
    expect(facts()).toMatch(/azurite/);
  });

  it('gives RUNNING.md when the project has one, up to 8 KiB', () => {
    expect(facts()).toMatch(/no RUNNING\.md/i);
    const text = facts({ runningMd: `## Start\n${'x'.repeat(20_000)}` });
    expect(text).toContain('## Start');
    expect(text.length).toBeLessThan(11_000);
  });
});
