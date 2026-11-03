import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

vi.mock('../../claude-code/task', () => ({ READ_TOOLS: ['Read'], runClaudeTask: vi.fn() }));

import { BriefError, normalizeProposal, storeBrief, taskDescription } from '../brief-import';
import type { BriefProposalOutput } from '../../schema/brief-proposal';

const task = (key: string, dependsOn: string[] = [], epic = 'E1') => ({
  key,
  title: ` ${key} title `,
  description: 'Do it',
  epic,
  acceptanceCriteria: ['Given a, when b, then c.', '  '],
  dependsOn,
  complexity: 'medium' as const,
  priority: 'medium' as const,
  category: 'feature' as const,
  sourceSection: '2. Invoices',
});

describe('storeBrief', () => {
  it('stores free text as brief.md in the project', async () => {
    const project = mkdtempSync(join(tmpdir(), 'vtl-brief-'));
    const brief = await storeBrief(project, '.auto-claude', { text: 'Invoicing v1\nCustomers send invoices.' });
    expect(brief.readPath).toBe(join(brief.dir, 'brief.md'));
    expect(brief.dir.startsWith(join(project, '.auto-claude', 'briefs'))).toBe(true);
    expect(brief.briefId).toMatch(/^\d{8}-\d{6}-invoicing-v1$/);
    expect(readFileSync(brief.readPath, 'utf-8')).toContain('Customers send invoices.');
  });

  it('keeps the original file, reads PDFs directly and refuses unknown types', async () => {
    const project = mkdtempSync(join(tmpdir(), 'vtl-brief-'));
    const pdf = join(project, 'spec.pdf');
    writeFileSync(pdf, '%PDF-1.4');
    const stored = await storeBrief(project, undefined, { filePath: pdf });
    expect(stored.readPath).toBe(join(stored.dir, 'source.pdf'));
    const odd = join(project, 'spec.xyz');
    writeFileSync(odd, 'x');
    await expect(storeBrief(project, undefined, { filePath: odd })).rejects.toBeInstanceOf(BriefError);
    await expect(storeBrief(project, undefined, {})).rejects.toBeInstanceOf(BriefError);
    expect(existsSync(join(stored.dir, 'source.pdf'))).toBe(true);
  });
});

describe('normalizeProposal', () => {
  it('keeps only backward dependencies, unique keys and known epics', () => {
    const output: BriefProposalOutput = {
      title: 'Invoicing',
      summary: 'S',
      epics: [{ key: 'E1', title: 'Invoices', summary: '' }],
      tasks: [task('T1', ['T2']), task('T2', ['T1', 'T9', 'T2']), task('T2', ['T1'], 'E7')],
      assumptions: ['One currency', ' '],
      openQuestions: ['Which email provider?'],
    };
    const proposal = normalizeProposal('b1', output);
    expect(proposal.tasks.map((t) => t.key)).toEqual(['T1', 'T2', 'T2b']);
    expect(proposal.tasks.map((t) => t.dependsOn)).toEqual([[], ['T1'], ['T1']]);
    expect(proposal.tasks[2].epic).toBe('E1');
    expect(proposal.tasks[0].title).toBe('T1 title');
    expect(proposal.tasks[0].acceptanceCriteria).toEqual(['Given a, when b, then c.']);
    expect(proposal.assumptions).toEqual(['One currency']);
  });
});

describe('taskDescription', () => {
  it('carries the draft criteria and a pointer to the brief section', () => {
    const md = taskDescription({ ...normalizeProposal('b', { title: '', summary: '', epics: [], tasks: [task('T1')], assumptions: [], openQuestions: [] }).tasks[0] }, '.auto-claude/briefs/b/brief.md');
    expect(md).toContain('## Acceptance criteria (draft)');
    expect(md).toContain('- Given a, when b, then c.');
    expect(md).toContain('Source: .auto-claude/briefs/b/brief.md — 2. Invoices');
  });
});
