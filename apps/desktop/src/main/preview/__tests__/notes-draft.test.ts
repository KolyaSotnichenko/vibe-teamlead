import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { readNotesDraft, writeNotesDraft } from '../notes-draft';

const note = (n: number, extra: Record<string, unknown> = {}) => ({
  id: `id${n}`,
  n,
  route: '/login',
  width: 1280,
  text: 'Make this button smaller',
  pick: { kind: 'element', rect: { x: 1, y: 2, width: 3, height: 4 }, selector: '#go', text: 'Go', html: '<button>Go</button>', frames: [] },
  image: 'data:image/png;base64,AAAA',
  createdAt: '2026-11-09T12:00:00.000Z',
  ...extra,
});

describe('the notes draft', () => {
  it("is kept in the project's .vibe-teamlead folder and read back", () => {
    const project = mkdtempSync(join(tmpdir(), 'vtl-notes-'));
    writeNotesDraft(project, [note(1), note(2)]);
    expect(JSON.parse(readFileSync(join(project, '.vibe-teamlead', 'preview', 'notes.json'), 'utf-8')).notes).toHaveLength(2);
    expect(readNotesDraft(project)).toEqual([note(1), note(2)]);
  });

  it('starts empty, and drops what is not a note or an image that is not a PNG', () => {
    const project = mkdtempSync(join(tmpdir(), 'vtl-notes-'));
    expect(readNotesDraft(project)).toEqual([]);
    writeNotesDraft(project, [note(1, { image: 'javascript:alert(1)' }), { nope: true }, note(3, { pick: { kind: 'evil' } })] as never);
    const kept = readNotesDraft(project);
    expect(kept).toHaveLength(1);
    expect(kept[0].image).toBeUndefined();
  });

  it('keeps it bounded', () => {
    const project = mkdtempSync(join(tmpdir(), 'vtl-notes-'));
    writeNotesDraft(project, Array.from({ length: 150 }, (_, i) => note(i + 1, { text: 'x'.repeat(9000) })));
    const kept = readNotesDraft(project);
    expect(kept).toHaveLength(100);
    expect(kept[0].text).toHaveLength(4000);
  });
});
