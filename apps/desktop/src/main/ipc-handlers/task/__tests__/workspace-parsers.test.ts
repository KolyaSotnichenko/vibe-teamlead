import { describe, it, expect } from 'vitest';
import {
  buildTimeline,
  deriveAcStatus,
  mergeCriteria,
  parseAcceptanceCriteria,
  parseAcPrefix,
  parseAdr,
  parsePlan,
  parseQaCoverage,
} from '../workspace-parsers';

const SPEC = `# Spec: Export invoices

## Acceptance Criteria

### Export
- **AC-1** Given an invoice list, when the user clicks Export, then a CSV downloads. — Test: unit
- **AC-2** Given no invoices, when the user opens Export, then the button is disabled. — Test: integration
- [ ] **AC-3** Given a 10k-row list, when exported, then it finishes in under 2s — Test: e2e
- **AC-4**: Given styles, when viewed, then the button matches the design system.

\`\`\`md
- **AC-9** inside a fence must be ignored
\`\`\`

| AC | Test |
|----|------|
| **AC-1** | duplicate mention ignored |
`;

const QA = `# QA Report

### AC coverage

| AC | Test (file::name) | Asserts the criterion? | Result |
|----|-------------------|------------------------|--------|
| AC-1 | \`tests/export.test.ts::downloads csv\` | yes | PASS |
| AC-2 | \`tests/export.test.ts::disabled when empty\` | yes | **FAIL** |
| AC-3 | \`e2e/export.spec.ts::large list\` | no — only checks status | PASS |

Other table:

| File | Lines |
|------|-------|
| a.ts | 3 |
`;

describe('parseAcceptanceCriteria', () => {
  it('extracts ids, text and test levels, skipping fences and duplicates', () => {
    const criteria = parseAcceptanceCriteria(SPEC);
    expect(criteria.map((c) => c.id)).toEqual(['AC-1', 'AC-2', 'AC-3', 'AC-4']);
    expect(criteria[0]).toEqual({
      id: 'AC-1',
      text: 'Given an invoice list, when the user clicks Export, then a CSV downloads.',
      testLevel: 'unit',
    });
    expect(criteria[1].testLevel).toBe('integration');
    expect(criteria[2].testLevel).toBe('e2e');
    expect(criteria[2].text).toBe('Given a 10k-row list, when exported, then it finishes in under 2s');
    expect(criteria[3]).toMatchObject({ testLevel: null, text: 'Given styles, when viewed, then the button matches the design system.' });
  });

  it('returns [] for empty or non-string input', () => {
    expect(parseAcceptanceCriteria('')).toEqual([]);
    expect(parseAcceptanceCriteria(undefined as unknown as string)).toEqual([]);
  });
});

describe('parseQaCoverage', () => {
  it('reads only the AC coverage table and normalizes results', () => {
    const rows = parseQaCoverage(QA);
    expect(rows).toHaveLength(3);
    expect(rows?.[0]).toEqual({
      acIds: ['AC-1'],
      test: { test: 'tests/export.test.ts::downloads csv', asserts: 'yes', result: 'pass' },
    });
    expect(rows?.[1].test.result).toBe('fail');
  });

  it('returns null when no coverage table exists', () => {
    expect(parseQaCoverage('# QA\n\nAll good.')).toBeNull();
    expect(parseQaCoverage('')).toBeNull();
  });

  it('accepts rows covering several criteria', () => {
    const rows = parseQaCoverage('| AC | Test | Result |\n|---|---|---|\n| AC-1, AC-02 | t | ✅ |\n');
    expect(rows?.[0].acIds).toEqual(['AC-1', 'AC-2']);
    expect(rows?.[0].test.result).toBe('pass');
  });
});

describe('deriveAcStatus', () => {
  it('is untested without rows, fail on any failure, pass otherwise', () => {
    expect(deriveAcStatus([])).toBe('untested');
    expect(deriveAcStatus([{ test: 'a', asserts: 'yes', result: 'pass' }])).toBe('pass');
    expect(
      deriveAcStatus([
        { test: 'a', asserts: 'yes', result: 'pass' },
        { test: 'b', asserts: 'yes', result: 'fail' },
      ])
    ).toBe('fail');
    expect(deriveAcStatus([{ test: 'a', asserts: '', result: 'unknown' }])).toBe('untested');
  });

  it('treats a passing test that does not assert the criterion as a failure', () => {
    expect(deriveAcStatus([{ test: 'a', asserts: 'no — only status', result: 'pass' }])).toBe('fail');
  });
});

describe('parseAcPrefix', () => {
  it('reads the leading [AC-..] list', () => {
    expect(parseAcPrefix('[AC-2, AC-3] Add endpoint')).toEqual(['AC-2', 'AC-3']);
    expect(parseAcPrefix('  [ac-1] lower')).toEqual(['AC-1']);
  });
  it('ignores mentions that are not a leading prefix', () => {
    expect(parseAcPrefix('Add endpoint for AC-2')).toEqual([]);
    expect(parseAcPrefix('[setup] scaffolding')).toEqual([]);
    expect(parseAcPrefix(null)).toEqual([]);
  });
});

const PLAN = {
  feature: 'Export invoices',
  phases: [
    {
      id: 'phase-1-backend',
      name: 'Backend',
      type: 'implementation',
      depends_on: [],
      subtasks: [
        { id: 'subtask-1-1', title: 'CSV serializer', description: '[AC-1] Test first: ...', status: 'done', files_to_create: ['src/csv.ts'] },
        { subtask_id: 'subtask-1-2', name: 'Empty state', description: '[AC-2] ...', status: 'running', depends_on: ['subtask-1-1', 'ghost'] },
      ],
    },
    {
      phase: 2,
      name: 'Frontend',
      depends_on: ['phase-1-backend', 7],
      subtasks: [{ id: 'subtask-2-1', title: 'Button', description: 'No prefix', status: 'weird', verification: { method: 'command', command: 'npm test' } }],
    },
  ],
};

describe('parsePlan', () => {
  it('normalizes ids, statuses, AC prefixes and dependencies', () => {
    const plan = parsePlan(PLAN);
    expect(plan?.feature).toBe('Export invoices');
    expect(plan?.phases.map((p) => p.id)).toEqual(['phase-1-backend', 'phase-2']);
    const [s11, s12] = plan?.phases[0].subtasks ?? [];
    expect(s11).toMatchObject({ id: 'subtask-1-1', status: 'completed', acIds: ['AC-1'], files: ['src/csv.ts'], phaseId: 'phase-1-backend' });
    expect(s12).toMatchObject({ id: 'subtask-1-2', title: 'Empty state', status: 'in_progress', dependsOn: ['subtask-1-1'] });
    const s21 = plan?.phases[1].subtasks[0];
    expect(s21).toMatchObject({ status: 'pending', acIds: [], verification: { type: 'command', run: 'npm test' } });
    expect(plan?.phases[1].dependsOn).toEqual(['phase-1-backend']);
  });

  it('resolves numeric phase references', () => {
    const plan = parsePlan({
      phases: [
        { phase: 1, name: 'A', subtasks: [{ id: 'a', title: 'a', description: '' }] },
        { phase: 2, name: 'B', depends_on: [1], subtasks: [{ id: 'b', title: 'b', description: '' }] },
      ],
    });
    expect(plan?.phases[1].dependsOn).toEqual(['phase-1']);
  });

  it('wraps flat step lists and rejects garbage', () => {
    expect(parsePlan({ steps: ['one', 'two'] })?.phases[0].subtasks.map((s) => s.title)).toEqual(['one', 'two']);
    expect(parsePlan(null)).toBeUndefined();
    expect(parsePlan({ phases: 'nope' })).toBeUndefined();
    expect(parsePlan({ phases: [{ name: 'empty', subtasks: [] }] })).toBeUndefined();
  });
});

describe('mergeCriteria', () => {
  it('joins QA results and covering subtasks onto each criterion', () => {
    const merged = mergeCriteria(parseAcceptanceCriteria(SPEC), parseQaCoverage(QA), parsePlan(PLAN));
    const byId = Object.fromEntries(merged.map((c) => [c.id, c]));
    expect(byId['AC-1']).toMatchObject({ status: 'pass', coveredBy: ['subtask-1-1'] });
    expect(byId['AC-2']).toMatchObject({ status: 'fail', coveredBy: ['subtask-1-2'] });
    expect(byId['AC-3'].status).toBe('fail');
    expect(byId['AC-4']).toMatchObject({ status: 'untested', coveredBy: [], tests: [] });
  });

  it('marks everything untested without a QA report', () => {
    const merged = mergeCriteria(parseAcceptanceCriteria(SPEC), null, undefined);
    expect(merged.every((c) => c.status === 'untested')).toBe(true);
  });
});

describe('buildTimeline', () => {
  const entry = (timestamp: string, extra: Record<string, unknown> = {}) => ({
    timestamp,
    type: 'text',
    content: 'x',
    ...extra,
  });

  it('builds phase, session and subtask spans from recorded timestamps', () => {
    const items = buildTimeline({
      spec_id: '001',
      phases: {
        planning: {
          phase: 'planning',
          status: 'completed',
          started_at: '2026-11-01T10:00:00.000Z',
          completed_at: '2026-11-01T10:20:00.000Z',
          entries: [entry('2026-11-01T10:01:00.000Z', { session: 1 }), entry('2026-11-01T10:19:00.000Z', { session: 1 })],
        },
        coding: {
          phase: 'coding',
          status: 'active',
          started_at: '2026-11-01T10:30:00.000Z',
          completed_at: null,
          entries: [
            entry('2026-11-01T10:31:00.000Z', { subtask_id: 'subtask-1-1' }),
            entry('2026-11-01T10:50:00.000Z', { subtask_id: 'subtask-1-1' }),
            entry('2026-11-01T10:55:00.000Z', { subtask_id: 'subtask-1-2' }),
            entry('not a date', { subtask_id: 'subtask-9' }),
          ],
        },
        validation: { phase: 'validation', status: 'pending', started_at: null, completed_at: null, entries: [] },
      },
    });

    expect(items.map((i) => i.id)).toEqual([
      'phase:planning',
      'session:planning:1',
      'phase:coding',
      'subtask:coding:subtask-1-1',
      'subtask:coding:subtask-1-2',
    ]);
    expect(items[0]).toMatchObject({ endedAt: '2026-11-01T10:20:00.000Z', status: 'completed', entryCount: 2 });
    expect(items[2]).toMatchObject({ endedAt: null, status: 'active' });
    expect(items[3]).toMatchObject({ startedAt: '2026-11-01T10:31:00.000Z', endedAt: '2026-11-01T10:50:00.000Z', status: 'completed' });
    expect(items[4]).toMatchObject({ endedAt: null, status: 'active' });
  });

  it('falls back to entry timestamps and tolerates bad input', () => {
    const items = buildTimeline({
      phases: { validation: { status: 'failed', started_at: null, completed_at: null, entries: [entry('2026-11-02T09:00:00.000Z'), entry('2026-11-02T09:05:00.000Z')] } },
    });
    expect(items).toEqual([
      expect.objectContaining({ id: 'phase:validation', startedAt: '2026-11-02T09:00:00.000Z', endedAt: '2026-11-02T09:05:00.000Z', status: 'failed' }),
    ]);
    expect(buildTimeline(null)).toEqual([]);
    expect(buildTimeline({ phases: 3 })).toEqual([]);
  });
});

describe('parseAdr', () => {
  it('reads title and inline status', () => {
    const adr = parseAdr('0001-use-csv.md', '# Use CSV for exports\n\n* Status: Accepted\n* Date: 2026-11-01\n');
    expect(adr).toMatchObject({ fileName: '0001-use-csv.md', title: 'Use CSV for exports', status: 'accepted' });
  });

  it('reads front-matter status and a status section', () => {
    expect(parseAdr('a.md', '---\nstatus: proposed\n---\n# Title').status).toBe('proposed');
    expect(parseAdr('a.md', '# T\n\n## Status\n\nSuperseded by 0003').status).toBe('superseded by 0003');
  });

  it('falls back to the file name for the title', () => {
    const adr = parseAdr('0002-stream-large-files.md', 'no heading');
    expect(adr.title).toBe('stream large files');
    expect(adr.status).toBeUndefined();
  });
});

describe('security artifacts', () => {
  it('reads gate findings as blocking and Strix findings against the threshold', async () => {
    const { parseSecurityGates, parseSecurityQa } = await import('../workspace-parsers');
    const gates = parseSecurityGates({
      ran: ['gitleaks'],
      skipped: [{ gate: 'osv-scanner', reason: 'no dependency lockfiles changed' }],
      findings: [{ gate: 'gitleaks', title: 'Secret detected: AWS', file: 'a.ts', line: 3 }],
    });
    expect(gates?.findings).toEqual([expect.objectContaining({ source: 'gitleaks', location: 'a.ts:3', blocking: true })]);
    expect(gates?.skipped[0].gate).toBe('osv-scanner');
    expect(gates?.partial).toEqual([]);
    expect(parseSecurityGates({ ran: ['semgrep'], skipped: [], partial: [{ gate: 'semgrep', reason: 'could not scan 1 file: a.ts' }, { nope: 1 }], findings: [] })?.partial).toEqual([
      { gate: 'semgrep', reason: 'could not scan 1 file: a.ts' },
    ]);

    const pentest = parseSecurityQa(
      {
        status: 'findings',
        settings: { scanMode: 'quick', failOn: 'high' },
        costUsd: 2,
        runDir: '/spec/security/strix_runs/r1',
        findings: [
          { title: 'SQLi', severity: 'critical' },
          { title: 'Header', severity: 'low' },
          { title: 'Odd', severity: 'unknown' },
        ],
      },
      '/spec',
    );
    expect(pentest?.findings.map((f) => f.blocking)).toEqual([true, false, true]);
    expect(pentest?.reportPath).toBe('security/strix_runs/r1/penetration_test_report.md');
    expect(parseSecurityQa('nope', '/spec')).toBeUndefined();
  });
});
