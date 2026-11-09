import { describe, expect, it } from 'vitest';

import type { PreviewNote } from '../../../../shared/types';
import { notesImages, notesTask } from '../notes-task';

const note = (n: number, extra: Partial<PreviewNote> = {}): PreviewNote => ({
  id: `id${n}`,
  n,
  route: '/login',
  width: 1280,
  text: 'Make this button smaller\nand quieter',
  pick: {
    kind: 'element',
    rect: { x: 0, y: 0, width: 10, height: 10 },
    selector: 'form > button',
    text: 'Sign in',
    html: '<button class="btn-lg">Sign in</button>',
    component: 'SubmitButton',
    frames: [{ file: 'apps/web/src/components/submit-button.tsx', line: 16 }, { file: 'apps/web/src/app/login/page.tsx', line: 164 }],
  },
  image: 'data:image/png;base64,QUJD',
  createdAt: '2026-11-09T12:00:00.000Z',
  ...extra,
});

describe('notesTask', () => {
  it('turns each note into a section with its page, element, source and screenshot, and an acceptance criterion', () => {
    const { description } = notesTask([note(1), note(2, { route: '/', text: 'Add an empty state', image: undefined })], 'Polish login');
    expect(description).toContain('### Note 1: `/login` at 1280 px');
    expect(description).toContain('`form > button` (SubmitButton), text "Sign in"');
    expect(description).toContain('`apps/web/src/components/submit-button.tsx:16`, `apps/web/src/app/login/page.tsx:164`');
    expect(description).toContain('preview-note-1.png');
    expect(description).not.toContain('preview-note-2.png');
    expect(description).toContain('> Make this button smaller\n> and quieter');
    expect(description).toContain('- AC-1: On `/login`, `form > button`: Make this button smaller and quieter');
    expect(description).toContain('- AC-2: On `/`, `form > button`: Add an empty state');
  });

  it('describes a region by the elements it covers', () => {
    const region = note(1, { pick: { ...note(1).pick, kind: 'region', elements: [{ selector: '#a', text: 'A' }, { selector: '#b', text: '' }] } });
    expect(notesTask([region], 't').description).toContain('a region covering `#a` ("A"), `#b`');
  });

  it('uses the title given, or the first note', () => {
    expect(notesTask([note(1)], '  ').title).toBe('Make this button smaller and quieter');
    expect(notesTask([note(1)], 'Polish login').title).toBe('Polish login');
  });
});

describe('notesImages', () => {
  it('attaches the screenshots as PNGs named after their notes', () => {
    const [image] = notesImages([note(1), note(2, { image: undefined })]);
    expect(image).toMatchObject({ filename: 'preview-note-1.png', mimeType: 'image/png', data: 'QUJD', size: 3 });
    expect(notesImages([note(2, { image: undefined })])).toEqual([]);
  });
});
