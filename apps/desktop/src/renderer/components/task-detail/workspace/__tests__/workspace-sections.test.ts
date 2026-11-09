import { describe, expect, it } from 'vitest';

import { workspaceSections } from '../TaskWorkspacePanel';

describe('workspaceSections', () => {
  it('offers the Preview of the task while it waits in review, with a project to run it in', () => {
    expect(workspaceSections({ storybook: false, status: 'human_review', hasProject: true })).toEqual(['spec', 'plan', 'architecture', 'security', 'preview']);
    expect(workspaceSections({ storybook: true, status: 'human_review', hasProject: true })).toContain('storybook');
  });

  it('not while agents work on it, after it merged, or without its project', () => {
    expect(workspaceSections({ storybook: false, status: 'in_progress', hasProject: true })).not.toContain('preview');
    expect(workspaceSections({ storybook: false, status: 'done', hasProject: true })).not.toContain('preview');
    expect(workspaceSections({ storybook: false, status: 'human_review', hasProject: false })).not.toContain('preview');
  });
});
