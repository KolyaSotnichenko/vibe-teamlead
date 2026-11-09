import { describe, expect, it } from 'vitest';

import { designFlow } from '../design-flow';

const ref = (id: string, addedAt: string, status = 'ready') => ({ id, addedAt, status }) as never;

describe('designFlow: which of the three steps is next', () => {
  it('starts at the design system when there is none; references are optional', () => {
    const flow = designFlow({ exists: false, references: [], audit: null });
    expect(flow.current).toBe('system');
    expect(flow.references).toEqual({ count: 0, fresh: 0 });
    expect(flow.system.status).toBe('none');
  });

  it('sends you back to the system when references came after it', () => {
    const flow = designFlow({
      exists: true,
      meta: { writtenAt: '2026-11-03T10:00:00Z', how: 'extract', referenceIds: ['a'] },
      references: [ref('a', '2026-11-01T00:00:00Z'), ref('b', '2026-11-05T00:00:00Z'), ref('c', '2026-11-06T00:00:00Z'), ref('d', '2026-11-06T00:00:00Z', 'analysing')],
      audit: { findings: 0, files: 0, uiFiles: 169, top: [] },
    });
    expect(flow.current).toBe('system');
    expect(flow.system.status).toBe('stale');
    expect(flow.references).toEqual({ count: 3, fresh: 2 });
    expect(flow.freshIds).toEqual(['b', 'c']);
  });

  it('moves to applying it when the code does not follow it', () => {
    const flow = designFlow({
      exists: true,
      meta: { writtenAt: '2026-11-09T15:20:00Z', how: 'direction', direction: 'Креслення', referenceIds: ['a'] },
      references: [ref('a', '2026-11-01T00:00:00Z')],
      audit: { findings: 37, files: 12, uiFiles: 169, top: [] },
    });
    expect(flow.current).toBe('apply');
    expect(flow.apply.status).toBe('diff');
  });

  it('has nothing next when the system holds every reference and the code follows it', () => {
    const flow = designFlow({ exists: true, meta: { writtenAt: '2026-11-09T15:20:00Z', how: 'extract', referenceIds: [] }, references: [], audit: { findings: 0, files: 0, uiFiles: 169, top: [] } });
    expect(flow.current).toBeNull();
    expect(flow.apply.status).toBe('clean');
  });

  it('counts a system without a record (made before this) as holding the references added before its file', () => {
    const flow = designFlow({ exists: true, meta: undefined, references: [ref('a', '2026-11-01T00:00:00Z')], audit: undefined });
    expect(flow.system.status).toBe('ok');
    expect(flow.apply.status).toBe('checking');
    expect(flow.current).toBeNull();
  });

  it('cannot check the code when the system has no tokens', () => {
    const flow = designFlow({ exists: true, references: [], audit: null });
    expect(flow.apply.status).toBe('unavailable');
    expect(flow.current).toBeNull();
  });
});
