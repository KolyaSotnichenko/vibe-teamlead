import { describe, expect, it } from 'vitest';
import type { DeployDeployment, DeployJob } from '../../../shared/types/deploy';
import { buildRunGraph } from '../run-graph';

let nextId = 1;
const job = (name: string, over: Partial<DeployJob> = {}): DeployJob => ({
  id: nextId++,
  name,
  status: 'completed',
  conclusion: 'success',
  startedAt: `2026-01-01T00:00:${String(nextId).padStart(2, '0')}Z`,
  steps: [],
  ...over,
});

const CHAIN = `
jobs:
  check:
    name: Lint and types
    runs-on: ubuntu-latest
  e2e:
    needs: check
    runs-on: ubuntu-latest
  build:
    needs: [e2e]
    runs-on: ubuntu-latest
`;

describe('buildRunGraph', () => {
  it('orders columns by needs levels and labels with name or id', () => {
    const g = buildRunGraph(CHAIN, [job('build'), job('Lint and types'), job('e2e')], []);
    expect(g.columns.map((c) => c.nodes.map((n) => n.label))).toEqual([['Lint and types'], ['e2e'], ['build']]);
  });

  it('puts jobs without needs in the same first column', () => {
    const yaml = `jobs:\n  a: {runs-on: x}\n  b: {runs-on: x}\n  c: {needs: [a, b], runs-on: x}\n`;
    const g = buildRunGraph(yaml, [job('a'), job('b'), job('c')], []);
    expect(g.columns).toHaveLength(2);
    expect(g.columns[0].nodes.map((n) => n.key).sort()).toEqual(['a', 'b']);
  });

  it('aggregates matrix jobs into one node, running if any runs', () => {
    const yaml = `jobs:\n  build: {runs-on: x}\n`;
    const g = buildRunGraph(
      yaml,
      [job('build (18)'), job('build (20)', { status: 'in_progress', conclusion: undefined })],
      [],
    );
    expect(g.columns).toHaveLength(1);
    const n = g.columns[0].nodes[0];
    expect(n.jobIds).toHaveLength(2);
    expect(n.status).toBe('running');
  });

  it('failure wins over success in an aggregate', () => {
    const yaml = `jobs:\n  build: {runs-on: x}\n`;
    const g = buildRunGraph(yaml, [job('build (1)'), job('build (2)', { conclusion: 'failure' })], []);
    expect(g.columns[0].nodes[0].status).toBe('failure');
  });

  it('maps reusable workflow jobs by prefix', () => {
    const yaml = `jobs:\n  call: {uses: ./.github/workflows/x.yml}\n`;
    const g = buildRunGraph(yaml, [job('call / test'), job('call / lint')], []);
    expect(g.columns).toHaveLength(1);
    expect(g.columns[0].nodes[0].key).toBe('call');
    expect(g.columns[0].nodes[0].jobIds).toHaveLength(2);
  });

  it('puts jobs missing from the YAML in a final column in start order', () => {
    const yaml = `jobs:\n  a: {runs-on: x}\n`;
    const late = job('zeta', { startedAt: '2026-01-01T00:09:00Z' });
    const early = job('omega', { startedAt: '2026-01-01T00:01:00Z' });
    const g = buildRunGraph(yaml, [late, job('a'), early], []);
    expect(g.columns).toHaveLength(2);
    expect(g.columns[1].nodes.map((n) => n.label)).toEqual(['omega', 'zeta']);
  });

  it('falls back to one column on invalid YAML or null', () => {
    const jobs = [job('b', { startedAt: '2026-01-01T00:02:00Z' }), job('a', { startedAt: '2026-01-01T00:01:00Z' })];
    for (const y of ['jobs: [unclosed', null]) {
      const g = buildRunGraph(y, jobs, []);
      expect(g.columns).toHaveLength(1);
      expect(g.columns[0].nodes.map((n) => n.label)).toEqual(['a', 'b']);
    }
  });

  it('maps statuses', () => {
    const yaml = `jobs:\n  q: {}\n  c: {}\n  s: {}\n  w: {}\n`;
    const g = buildRunGraph(
      yaml,
      [
        job('q', { status: 'queued', conclusion: undefined }),
        job('c', { conclusion: 'cancelled' }),
        job('s', { conclusion: 'skipped' }),
        job('w', { status: 'waiting', conclusion: undefined }),
      ],
      [],
    );
    const by = Object.fromEntries(g.columns[0].nodes.map((n) => [n.key, n.status]));
    expect(by).toEqual({ q: 'queued', c: 'cancelled', s: 'skipped', w: 'queued' });
  });

  it('adds a final Deploy column with environment nodes and urls', () => {
    const d: DeployDeployment[] = [
      { environment: 'Preview', state: 'success', url: 'https://p.example', logUrl: 'https://l', createdAt: 't' },
      { environment: 'Prod', state: 'in_progress', createdAt: 't' },
    ];
    const g = buildRunGraph(CHAIN, [job('build')], d);
    const last = g.columns[g.columns.length - 1];
    expect(last.stage).toBe('Deploy');
    expect(last.nodes.map((n) => [n.label, n.status])).toEqual([
      ['Preview', 'success'],
      ['Prod', 'running'],
    ]);
    expect(last.nodes[0].deploymentUrl).toBe('https://p.example');
    expect(last.nodes[0].logUrl).toBe('https://l');
  });

  it('does not execute custom yaml tags', () => {
    const g = buildRunGraph('jobs: !!js/function "x"', [job('a')], []);
    expect(g.columns).toHaveLength(1);
  });
});
