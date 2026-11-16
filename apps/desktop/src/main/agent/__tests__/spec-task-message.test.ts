import { describe, expect, it } from 'vitest';

import { specTaskMessage } from '../spec-task-message';

describe('specTaskMessage', () => {
  const base = { taskDescription: 'Add RBAC', projectPath: '/p', specDir: '/p/.vibe-teamlead/specs/005', baseBranch: 'main' };

  // "Auto-approve: true" read to the spec agents as "don't ask the user": they decided the brief's
  // open questions themselves. It only meant the plan goes to coding without waiting for approval.
  it('says only the plan approval is skipped, and that the user is still asked their decisions', () => {
    const text = specTaskMessage({ ...base, requireReview: false });
    expect(text).not.toMatch(/auto-approve/i);
    expect(text).toContain('Plan approval: not needed');
    expect(text).toMatch(/AskUserQuestion/);
    expect(text).toContain('Task: Add RBAC');
    expect(text).toContain('Spec directory: /p/.vibe-teamlead/specs/005');
    expect(text).toContain('Base branch: main');
  });

  it('with review before coding on, says so', () => {
    expect(specTaskMessage({ ...base, requireReview: true })).toContain('Plan approval: the user reviews the plan before coding');
  });
});
