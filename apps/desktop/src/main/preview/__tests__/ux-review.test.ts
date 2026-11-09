import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import { readLastUxReview, runUxReview, uxReviewPrompt } from '../ux-review';

describe('uxReviewPrompt', () => {
  it('names the running app, starts from the home page, and caps the pages', () => {
    const prompt = uxReviewPrompt('http://localhost:61073');
    expect(prompt).toContain('http://localhost:61073');
    expect(prompt).toMatch(/start at `\/`/i);
    expect(prompt).toMatch(/at most 12 pages/);
    expect(prompt).toMatch(/ux-review skill/);
    expect(prompt).toMatch(/don't start servers/i);
  });
});

describe('runUxReview', () => {
  const output = {
    summary: 'Two problems.',
    pages: ['/', '/login'],
    findings: [
      { page: '/', width: 1280, severity: 'blocks', problem: 'The home page is a placeholder', expected: 'A landing or a redirect to sign-in', file: 'apps/web/src/app/page.tsx' },
      { page: '/login', width: 375, severity: 'note', problem: 'Heading wraps awkwardly', expected: 'Shorter heading on phone' },
    ],
  };

  it('runs one session with the skill, the browser and read-only tools, in the preview folder, and keeps the result', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'vtl-ux-'));
    const runTask = vi.fn(async (_options: Record<string, unknown>) => ({ text: '', output }));
    const result = await runUxReview({ projectId: 'p1', url: 'http://localhost:61073', worktree: '/wt/p1', dataDir, runTask, model: { model: 'sonnet', thinkingLevel: 'medium' } });
    const options = runTask.mock.calls[0][0];
    expect(options).toMatchObject({ agentType: 'ux_reviewer', cwd: '/wt/p1', specDir: '/wt/p1/.vibe-teamlead/specs/preview', skills: ['ux-review:ux-review'], model: 'sonnet', thinkingLevel: 'medium' });
    // Skill too: a tool list replaces the defaults, and the review must load its skill
    expect(options.tools).toEqual(['Read', 'Glob', 'Grep', 'Skill']);
    expect(result.findings).toHaveLength(2);
    expect(result.at).toEqual(expect.any(String));
    expect(readLastUxReview(dataDir, 'p1')).toEqual(result);
    expect(readLastUxReview(dataDir, 'other')).toBeNull();
  });

  it('fails clearly when the session returns no review', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'vtl-ux-'));
    await expect(
      runUxReview({ projectId: 'p1', url: 'http://x', worktree: '/wt', dataDir, runTask: async () => ({ text: 'oops' }), model: { model: 'sonnet', thinkingLevel: 'low' } }),
    ).rejects.toThrow(/no review/i);
    expect(readLastUxReview(dataDir, 'p1')).toBeNull();
  });
});
