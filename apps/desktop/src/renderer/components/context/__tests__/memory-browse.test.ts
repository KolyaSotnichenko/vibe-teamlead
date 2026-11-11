import { describe, expect, it } from 'vitest';

import { browseMemories } from '../memory-browse';

const m = (id: string, over: Record<string, unknown> = {}) =>
  ({ id, type: 'gotcha', content: '', tags: [], relatedFiles: [], source: 'observer_inferred', confidence: 0.7, createdAt: '2026-11-11', ...over }) as never;

const memories = [
  m('1', { content: 'The apostrophe in Привʼязати is U+02BC', tags: ['038-add-a-shared-data-table'], relatedFiles: ['apps/web/e2e/ac-07.spec.ts'] }),
  m('2', { type: 'pattern', content: 'Prefer role-based locators', source: 'agent_explicit' }),
  m('3', { type: 'module_insight', content: 'journey.spec.ts uses a combobox', relatedFiles: ['apps/web/e2e/journey.spec.ts'], tags: ['041-x'] }),
];

describe('browsing project memory', () => {
  it('by who wrote it: an agent on purpose, or learned from a subtask', () => {
    expect(browseMemories(memories, { source: 'agent' }).map((x) => x.id)).toEqual(['2']);
    expect(browseMemories(memories, { source: 'learned' }).map((x) => x.id)).toEqual(['1', '3']);
  });

  it('by text, file or task, ignoring case', () => {
    expect(browseMemories(memories, { text: 'u+02bc' }).map((x) => x.id)).toEqual(['1']);
    expect(browseMemories(memories, { text: 'journey.spec' }).map((x) => x.id)).toEqual(['3']);
    expect(browseMemories(memories, { text: '038' }).map((x) => x.id)).toEqual(['1']);
  });

  it('together with the type category', () => {
    expect(browseMemories(memories, { category: (x) => x.type === 'pattern', source: 'all' }).map((x) => x.id)).toEqual(['2']);
  });
});
