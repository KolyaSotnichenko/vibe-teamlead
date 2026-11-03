/**
 * Sample task workspace for browser preview (no Electron, no spec directory).
 * Shapes match what the main-process TASK_WORKSPACE_GET handler returns.
 */

import type { IPCResult, TaskWorkspace } from '../../../shared/types';

const SPEC_MD = `# Spec: Export invoices to CSV

## Overview

Finance needs to pull invoice data into spreadsheets without asking engineering for a database dump. This adds an **Export** action to the invoice list that downloads the currently filtered rows as CSV.

## Out of scope

- XLSX export
- Scheduled exports by email

## Acceptance Criteria

### Export
- **AC-1** Given a filtered invoice list, when the user clicks Export, then a CSV with exactly the visible rows downloads. — Test: integration
- **AC-2** Given an invoice with a comma or quote in a field, when exported, then the field is quoted per RFC 4180. — Test: unit
- **AC-3** Given an empty list, when the page renders, then the Export button is disabled and says why. — Test: unit

### Performance
- **AC-4** Given 50 000 invoices, when exported, then the download starts within 2 seconds and memory stays flat (streamed). — Test: integration
- **AC-5** Given a user without the \`finance:read\` role, when they call the export endpoint, then it returns 403. — Test: e2e

## Success criteria

1. [ ] Every acceptance criterion (AC-1 … AC-5) has an automated test, and all of them pass
2. [ ] No regressions in the invoice list
`;

const ARCHITECTURE_MD = `# Architecture: invoice CSV export

## Context

The invoice list is served by \`InvoiceController.list\` and rendered by \`InvoiceTable\`. Export reuses the same filter object so "what you see is what you export" (AC-1).

## Components

| Component | Responsibility | AC |
| --- | --- | --- |
| \`ExportButton\` | Disabled state + reason, triggers download | AC-3 |
| \`GET /invoices/export\` | Auth check, streams rows | AC-4, AC-5 |
| \`csvSerializer\` | RFC 4180 quoting | AC-2 |

## Constraints for the planner

- Stream with \`Readable.from(cursor)\`; never buffer the whole result.
- Reuse \`parseInvoiceFilters()\`; do not duplicate filter parsing.
`;

const ADR_MD = `# Stream CSV from a database cursor

* Status: accepted
* Date: 2026-11-02

## Context and Problem Statement

Exports of 50k rows must start within 2 seconds without growing memory (AC-4).

## Considered Options

* Build the file in memory, then send
* Stream rows from a cursor through the serializer
* Generate asynchronously and email a link

## Decision Outcome

Chosen option: **stream rows from a cursor**, because it meets AC-4 with no new infrastructure.

### Consequences

* Good: constant memory, first byte immediately.
* Bad: a mid-stream DB error truncates the file; we add a trailing checksum row.
`;

const SEQUENCE_MMD = `sequenceDiagram
  actor U as Finance user
  participant B as ExportButton
  participant API as GET /invoices/export
  participant DB as Postgres
  U->>B: click Export
  B->>API: GET ?filters=…
  API->>API: check finance:read
  API->>DB: open cursor
  loop each 500 rows
    DB-->>API: rows
    API-->>B: CSV chunk
  end
  B-->>U: invoices.csv
`;

/** Stand-in for the PNG draw.io renders next to containers.drawio (any image data URL works in <img>) */
const CONTAINERS_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="760" height="230" viewBox="0 0 760 230" font-family="Helvetica, Arial, sans-serif" font-size="13">
<rect width="760" height="230" fill="#ffffff"/>
<g fill="#ffffff" stroke="#1C1D19" stroke-width="1.5">
<rect x="20" y="70" width="170" height="80"/><rect x="295" y="70" width="170" height="80"/><rect x="570" y="70" width="170" height="80"/></g>
<g fill="#1C1D19" text-anchor="middle">
<text x="105" y="104" font-weight="bold">Web app</text><text x="105" y="124" font-size="11">[React, InvoiceTable]</text>
<text x="380" y="104" font-weight="bold">Billing API</text><text x="380" y="124" font-size="11">[Node, /invoices/export]</text>
<text x="655" y="104" font-weight="bold">Postgres</text><text x="655" y="124" font-size="11">[invoices]</text>
<text x="242" y="100" font-size="11">GET export</text><text x="242" y="114" font-size="11">HTTPS, CSV stream</text>
<text x="517" y="100" font-size="11">cursor reads</text><text x="517" y="114" font-size="11">SQL</text></g>
<g stroke="#1C1D19" stroke-width="1.5"><line x1="190" y1="125" x2="287" y2="125"/><line x1="465" y1="125" x2="562" y2="125"/></g>
<g fill="#1C1D19"><path d="M295 125 l-9 -5 v10z"/><path d="M570 125 l-9 -5 v10z"/></g>
<text x="20" y="30" font-size="14" font-weight="bold" fill="#1C1D19">Containers — invoice export</text>
</svg>`;

const iso = (hhmm: string, day = '2026-11-02') => `${day}T${hhmm}:00.000Z`;

export const sampleTaskWorkspace: TaskWorkspace = {
  specDir: '/Users/demo/projects/billing/.auto-claude/specs/002-dashboard',
  hasQaCoverage: true,
  spec: {
    markdown: SPEC_MD,
    criteria: [
      {
        id: 'AC-1',
        text: 'Given a filtered invoice list, when the user clicks Export, then a CSV with exactly the visible rows downloads.',
        testLevel: 'integration',
        status: 'pass',
        tests: [{ test: 'api/tests/export.test.ts::exports only filtered rows', asserts: 'yes', result: 'pass' }],
        coveredBy: ['subtask-2-1'],
      },
      {
        id: 'AC-2',
        text: 'Given an invoice with a comma or quote in a field, when exported, then the field is quoted per RFC 4180.',
        testLevel: 'unit',
        status: 'pass',
        tests: [{ test: 'api/src/csv.test.ts::quotes commas and quotes', asserts: 'yes', result: 'pass' }],
        coveredBy: ['subtask-1-1'],
      },
      {
        id: 'AC-3',
        text: 'Given an empty list, when the page renders, then the Export button is disabled and says why.',
        testLevel: 'unit',
        status: 'fail',
        tests: [{ test: 'web/src/ExportButton.test.tsx::disabled with reason', asserts: 'yes', result: 'fail' }],
        coveredBy: ['subtask-2-2'],
      },
      {
        id: 'AC-4',
        text: 'Given 50 000 invoices, when exported, then the download starts within 2 seconds and memory stays flat (streamed).',
        testLevel: 'integration',
        status: 'untested',
        tests: [],
        coveredBy: ['subtask-1-2'],
      },
      {
        id: 'AC-5',
        text: 'Given a user without the `finance:read` role, when they call the export endpoint, then it returns 403.',
        testLevel: 'e2e',
        status: 'untested',
        tests: [],
        coveredBy: ['subtask-1-3'],
      },
    ],
  },
  plan: {
    feature: 'Export invoices to CSV',
    phases: [
      {
        id: 'phase-1-backend',
        name: 'Export endpoint',
        type: 'implementation',
        dependsOn: [],
        subtasks: [
          {
            id: 'subtask-1-1',
            title: 'RFC 4180 CSV serializer',
            description: '[AC-2] Test first: api/src/csv.test.ts::quotes commas and quotes (AC-2). Add csvSerializer.',
            status: 'completed',
            phaseId: 'phase-1-backend',
            acIds: ['AC-2'],
            dependsOn: [],
            files: ['api/src/csv.ts'],
            verification: { type: 'command', run: 'npm test -- csv' },
          },
          {
            id: 'subtask-1-2',
            title: 'Stream rows from a cursor',
            description: '[AC-4] Test first: api/tests/export.test.ts::streams 50k rows (AC-4).',
            status: 'completed',
            phaseId: 'phase-1-backend',
            acIds: ['AC-4'],
            dependsOn: ['subtask-1-1'],
            files: ['api/src/routes/export.ts'],
          },
          {
            id: 'subtask-1-3',
            title: 'Guard with finance:read',
            description: '[AC-5] Test first: e2e/export.spec.ts::forbids without role (AC-5).',
            status: 'completed',
            phaseId: 'phase-1-backend',
            acIds: ['AC-5'],
            dependsOn: ['subtask-1-2'],
            files: ['api/src/routes/export.ts'],
          },
        ],
      },
      {
        id: 'phase-2-frontend',
        name: 'Export button',
        type: 'implementation',
        dependsOn: ['phase-1-backend'],
        subtasks: [
          {
            id: 'subtask-2-1',
            title: 'Wire Export to current filters',
            description: '[AC-1] Test first: api/tests/export.test.ts::exports only filtered rows (AC-1).',
            status: 'completed',
            phaseId: 'phase-2-frontend',
            acIds: ['AC-1'],
            dependsOn: ['subtask-1-2'],
            files: ['web/src/InvoiceTable.tsx'],
          },
          {
            id: 'subtask-2-2',
            title: 'Disabled state with reason',
            description: '[AC-3] Test first: web/src/ExportButton.test.tsx::disabled with reason (AC-3).',
            status: 'failed',
            phaseId: 'phase-2-frontend',
            acIds: ['AC-3'],
            dependsOn: ['subtask-2-1'],
            files: ['web/src/ExportButton.tsx'],
          },
          {
            id: 'subtask-2-3',
            title: 'Download progress toast',
            description: 'Show a toast while the stream is open.',
            status: 'in_progress',
            phaseId: 'phase-2-frontend',
            acIds: [],
            dependsOn: ['subtask-2-1'],
            files: ['web/src/ExportButton.tsx'],
          },
        ],
      },
    ],
  },
  timeline: [
    { id: 'phase:planning', kind: 'phase', phase: 'planning', startedAt: iso('09:02'), endedAt: iso('09:41'), status: 'completed', entryCount: 84 },
    { id: 'session:planning:1', kind: 'session', phase: 'planning', session: 1, startedAt: iso('09:02'), endedAt: iso('09:24'), status: 'completed', entryCount: 51 },
    { id: 'session:planning:2', kind: 'session', phase: 'planning', session: 2, startedAt: iso('09:26'), endedAt: iso('09:41'), status: 'completed', entryCount: 33 },
    { id: 'phase:coding', kind: 'phase', phase: 'coding', startedAt: iso('09:44'), endedAt: iso('11:58'), status: 'completed', entryCount: 312 },
    { id: 'subtask:coding:subtask-1-1', kind: 'subtask', phase: 'coding', subtaskId: 'subtask-1-1', startedAt: iso('09:44'), endedAt: iso('10:07'), status: 'completed', entryCount: 58 },
    { id: 'subtask:coding:subtask-1-2', kind: 'subtask', phase: 'coding', subtaskId: 'subtask-1-2', startedAt: iso('10:09'), endedAt: iso('10:51'), status: 'completed', entryCount: 97 },
    { id: 'subtask:coding:subtask-1-3', kind: 'subtask', phase: 'coding', subtaskId: 'subtask-1-3', startedAt: iso('10:53'), endedAt: iso('11:12'), status: 'completed', entryCount: 44 },
    { id: 'subtask:coding:subtask-2-1', kind: 'subtask', phase: 'coding', subtaskId: 'subtask-2-1', startedAt: iso('11:14'), endedAt: iso('11:58'), status: 'completed', entryCount: 113 },
    { id: 'phase:validation', kind: 'phase', phase: 'validation', startedAt: iso('12:03'), endedAt: iso('12:31'), status: 'failed', entryCount: 66 },
    { id: 'session:validation:1', kind: 'session', phase: 'validation', session: 1, startedAt: iso('12:03'), endedAt: iso('12:31'), status: 'failed', entryCount: 66 },
  ],
  architecture: {
    markdown: ARCHITECTURE_MD,
    adrs: [{ fileName: '0001-stream-csv-from-cursor.md', title: 'Stream CSV from a database cursor', status: 'accepted', markdown: ADR_MD }],
    diagrams: [
      {
        name: 'containers',
        kind: 'drawio',
        drawioPath: 'architecture/diagrams/containers.drawio',
        pngPath: 'architecture/diagrams/containers.png',
        pngVersion: 1,
      },
      { name: 'deployment', kind: 'drawio', drawioPath: 'architecture/diagrams/deployment.drawio' },
      { name: 'export-sequence', kind: 'mermaid', mermaidSource: SEQUENCE_MMD },
    ],
  },
  security: {
    gates: {
      ran: ['gitleaks', 'osv-scanner'],
      skipped: [],
      findings: [],
    },
    pentest: {
      status: 'findings',
      scanMode: 'quick',
      failOn: 'high',
      costUsd: 1.84,
      reportPath: 'security/strix_runs/invoice-export-1/penetration_test_report.md',
      findings: [
        {
          source: 'strix',
          title: 'CSV formula injection in exported invoice notes',
          severity: 'high',
          location: 'api/src/export/csv.ts:31',
          detail: 'A note starting with =HYPERLINK( is written unescaped, so the spreadsheet runs it when the file is opened. PoC: create an invoice with note =HYPERLINK("https://example.test","x") and export.',
          blocking: true,
        },
        {
          source: 'strix',
          title: 'Export endpoint has no rate limit',
          severity: 'low',
          location: 'api/src/routes/invoices.ts:88',
          blocking: false,
        },
      ],
    },
  },
};

/** Early-stage task: the spec exists, nothing else has been written yet (shows the empty states). */
export const earlyTaskWorkspace: TaskWorkspace = {
  specDir: '/Users/demo/projects/billing/.auto-claude/specs/002-dashboard',
  hasQaCoverage: false,
  spec: {
    markdown: SPEC_MD,
    criteria: (sampleTaskWorkspace.spec?.criteria ?? []).map((c) => ({ ...c, status: 'untested' as const, tests: [], coveredBy: [] })),
  },
  timeline: [],
  architecture: { adrs: [], diagrams: [] },
  security: {},
};

export const taskWorkspaceMock = {
  getTaskWorkspace: async (taskId: string, _projectId?: string): Promise<IPCResult<TaskWorkspace | null>> => ({
    success: true,
    data: ['task-8', 'task-3', 'task-9'].includes(taskId) ? sampleTaskWorkspace : earlyTaskWorkspace,
  }),
  getTaskWorkspaceImage: async (_taskId: string, _relativePath: string): Promise<IPCResult<string>> => ({
    success: true,
    data: `data:image/svg+xml;utf8,${encodeURIComponent(CONTAINERS_SVG)}`,
  }),
  openTaskWorkspaceFile: async (_taskId: string, relativePath: string): Promise<IPCResult> => {
    console.warn('[Browser Mock] openTaskWorkspaceFile:', relativePath);
    return { success: true };
  },
};
