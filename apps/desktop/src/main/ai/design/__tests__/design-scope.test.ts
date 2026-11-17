import { describe, expect, it } from 'vitest';

import { designPointer, designScope } from '../design-scope';

const isUiFile = (file: string) => file.endsWith('.tsx');

describe('designScope: the whole design system, or a pointer to it', () => {
  it('gives a coder subtask that names only non-UI files a pointer', () => {
    expect(designScope('coder', { subtaskFiles: ['src/api/x.ts'], isUiFile })).toBe('pointer');
    expect(designScope('coder', { subtaskFiles: ['src/App.tsx', 'src/api/x.ts'], isUiFile })).toBe('full');
    // No files named: unknown, so the whole document
    expect(designScope('coder', { subtaskFiles: [], isUiFile })).toBe('full');
  });

  it('gives QA a pointer when the task changed no UI file, the whole document otherwise', () => {
    for (const role of ['qa_reviewer', 'qa_fixer']) {
      expect(designScope(role, { taskTouchesUi: false, isUiFile })).toBe('pointer');
      expect(designScope(role, { taskTouchesUi: true, isUiFile })).toBe('full');
      expect(designScope(role, { isUiFile })).toBe('full');
    }
  });

  it('leaves the other roles as they were', () => {
    for (const role of ['planner', 'architect', 'spec_writer', 'designer']) {
      expect(designScope(role, { taskTouchesUi: false, subtaskFiles: ['a.ts'], isUiFile })).toBe('full');
    }
  });
});

describe('designPointer', () => {
  it('names the file and says when to read it', () => {
    expect(designPointer('coder', '.vibe-teamlead/design-system.md')).toContain("This subtask's files are not UI files");
    expect(designPointer('qa_fixer', '.vibe-teamlead/design-system.md')).toContain('This task changed no UI file');
    expect(designPointer('qa_reviewer', '.vibe-teamlead/design-system.md')).toContain('`.vibe-teamlead/design-system.md`');
    expect(designPointer('coder', undefined)).toBe('');
  });
});
