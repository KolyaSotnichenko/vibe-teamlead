import { describe, expect, it } from 'vitest';
import { ciState, statusItems, type StatusInput } from '../status-model';

const base: StatusInput = { hasProject: true, working: 0, queued: 0, review: 0, paused: false, waiting: 0, sidebarShowsWaiting: false, ciConclusion: null };
const keys = (input: Partial<StatusInput>) => statusItems({ ...base, ...input }).map((item) => item.key);

describe('statusItems', () => {
  it('shows nothing without a project and no question waiting', () => {
    expect(statusItems({ ...base, hasProject: false, working: 3 })).toEqual([]);
  });

  it('still shows a waiting question without a project', () => {
    expect(statusItems({ ...base, hasProject: false, waiting: 1 })).toEqual([
      { key: 'waiting', count: 1, alert: true, target: 'question' },
    ]);
  });

  it('shows running, queued and ready-for-review counts that open the board, quietly', () => {
    expect(statusItems({ ...base, working: 2, queued: 3, review: 4 })).toEqual([
      { key: 'running', count: 2, alert: false, target: 'kanban' },
      { key: 'queued', count: 3, alert: false, target: 'kanban' },
      { key: 'review', count: 4, alert: false, target: 'kanban' },
    ]);
  });

  it('leaves the question to the open sidebar, which shows it in words, and shows it when the sidebar is collapsed', () => {
    expect(keys({ waiting: 1, sidebarShowsWaiting: true })).toEqual(['running', 'queued', 'review']);
    expect(keys({ waiting: 1, sidebarShowsWaiting: false })[0]).toBe('waiting');
    expect(statusItems({ ...base, hasProject: false, waiting: 1, sidebarShowsWaiting: true })).toEqual([]);
  });

  it('puts a waiting question first and marks it as needing the user', () => {
    const items = statusItems({ ...base, waiting: 2, working: 1 });
    expect(items[0]).toEqual({ key: 'waiting', count: 2, alert: true, target: 'question' });
  });

  it('shows the paused queue only while it is paused', () => {
    expect(keys({ paused: false })).not.toContain('paused');
    expect(statusItems({ ...base, paused: true }).find((i) => i.key === 'paused')).toEqual({
      key: 'paused',
      alert: false,
      target: 'kanban',
    });
  });

  it('shows CI only when main has a recorded run, alerting only on a failure', () => {
    expect(keys({ ciConclusion: null })).not.toContain('ci');
    expect(statusItems({ ...base, ciConclusion: 'success' }).at(-1)).toEqual({
      key: 'ci',
      ci: 'passing',
      alert: false,
      target: 'ci',
    });
    expect(statusItems({ ...base, ciConclusion: 'failure' }).at(-1)).toEqual({
      key: 'ci',
      ci: 'failing',
      alert: true,
      target: 'ci',
    });
  });

  it('keeps a fixed order: question, running, queued, review, paused, CI', () => {
    expect(keys({ waiting: 1, paused: true, ciConclusion: 'success' })).toEqual(['waiting', 'running', 'queued', 'review', 'paused', 'ci']);
  });
});

describe('ciState', () => {
  it('reads GitHub conclusions as passing, failing or other', () => {
    expect(ciState('success')).toBe('passing');
    for (const c of ['failure', 'timed_out', 'startup_failure']) expect(ciState(c)).toBe('failing');
    for (const c of ['cancelled', 'skipped', 'neutral', 'stale', 'whatever']) expect(ciState(c)).toBe('other');
  });
});
