/**
 * Preview notes as a task, without a model call: one section per note (page, element,
 * source, screenshot, the owner's words) and one acceptance criterion per note, so QA
 * checks every one. Pure.
 */

import type { ImageAttachment, PreviewNote } from '../../../shared/types';

const oneLine = (text: string) => text.replace(/\s+/g, ' ').trim();
const imageName = (note: PreviewNote) => `preview-note-${note.n}.png`;

function elementLabel(note: PreviewNote): string {
  const { pick } = note;
  if (pick.kind === 'region' && pick.elements?.length) {
    return `a region covering ${pick.elements.map((e) => `\`${e.selector}\`${e.text ? ` ("${oneLine(e.text).slice(0, 60)}")` : ''}`).join(', ')}`;
  }
  const component = pick.component ? ` (${pick.component})` : '';
  const text = pick.text ? `, text "${oneLine(pick.text).slice(0, 80)}"` : '';
  return `\`${pick.selector || pick.kind}\`${component}${text}`;
}

function noteSection(note: PreviewNote): string[] {
  const frames = note.pick.frames.map((f) => `\`${f.file}${f.line ? `:${f.line}` : ''}\``).join(', ');
  return [
    `### Note ${note.n}: \`${note.route}\` at ${note.width} px`,
    '',
    `- **Element:** ${elementLabel(note)}`,
    ...(frames ? [`- **Source:** ${frames}`] : ['- **Source:** not known; find it from the selector, the text and the page']),
    ...(note.image ? [`- **Screenshot:** \`${imageName(note)}\` (attached)`] : []),
    '',
    ...note.text.split('\n').map((line) => `> ${line}`),
    ...(note.pick.html ? ['', '```html', note.pick.html, '```'] : []),
    '',
  ];
}

export function notesTask(notes: PreviewNote[], title: string): { title: string; description: string } {
  const first = oneLine(notes[0]?.text ?? '');
  return {
    title: title.trim() || first.slice(0, 80) || 'Changes from preview notes',
    description: [
      'Notes the owner left on the running app in Preview. Change what each one asks, on its page; keep everything else as it is.',
      '',
      ...notes.flatMap(noteSection),
      '## Acceptance criteria',
      '',
      ...notes.map((note, i) => `- AC-${i + 1}: On \`${note.route}\`, \`${note.pick.selector || note.pick.kind}\`: ${oneLine(note.text)}`),
    ].join('\n'),
  };
}

/** The notes' screenshots as task images */
export function notesImages(notes: PreviewNote[]): ImageAttachment[] {
  return notes.flatMap((note) => {
    const data = note.image?.replace(/^data:image\/png;base64,/, '');
    if (!data) return [];
    return [{ id: `preview-note-${note.id}`, filename: imageName(note), mimeType: 'image/png', size: Math.floor((data.length * 3) / 4) - (data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0), data }];
  });
}
