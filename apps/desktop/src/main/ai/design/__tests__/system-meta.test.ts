import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { readSystemMeta, recordSystemMeta } from '../system-meta';
import { summarizeAudit } from '../redesign';

describe('the design system record', () => {
  it('keeps when and how it was written and the references it took in', () => {
    const project = mkdtempSync(join(tmpdir(), 'vtl-meta-'));
    expect(readSystemMeta(project)).toBeUndefined();
    recordSystemMeta(project, { how: 'direction', direction: 'Креслення', referenceIds: ['a', 'b'] }, '2026-11-09T15:20:00.000Z');
    expect(readSystemMeta(project)).toEqual({ writtenAt: '2026-11-09T15:20:00.000Z', how: 'direction', direction: 'Креслення', referenceIds: ['a', 'b'] });
  });

  it('an edit keeps the references the system took in', () => {
    const project = mkdtempSync(join(tmpdir(), 'vtl-meta-'));
    recordSystemMeta(project, { how: 'extract', referenceIds: ['a'] }, '2026-11-01T00:00:00.000Z');
    recordSystemMeta(project, { how: 'edited' }, '2026-11-02T00:00:00.000Z');
    expect(readSystemMeta(project)).toEqual({ writtenAt: '2026-11-02T00:00:00.000Z', how: 'edited', referenceIds: ['a'] });
  });

  it('ignores a broken record', () => {
    const project = mkdtempSync(join(tmpdir(), 'vtl-meta-'));
    mkdirSync(join(project, '.vibe-teamlead', 'design'), { recursive: true });
    writeFileSync(join(project, '.vibe-teamlead', 'design', 'system-meta.json'), '{nope');
    expect(readSystemMeta(project)).toBeUndefined();
  });
});

describe('summarizeAudit', () => {
  it('counts places and files, and names the files with the most, with their kinds', () => {
    const f = (file: string, rule: string) => ({ file, rule, line: 1, match: 'x', message: 'm' }) as never;
    expect(summarizeAudit([f('a.tsx', 'radius'), f('a.tsx', 'off-palette-color'), f('a.tsx', 'radius'), f('b.tsx', 'shadow')], 10)).toEqual({
      findings: 4,
      files: 2,
      uiFiles: 10,
      top: [{ file: 'a.tsx', count: 3, rules: ['radius', 'off-palette-color'] }, { file: 'b.tsx', count: 1, rules: ['shadow'] }],
    });
  });
});
