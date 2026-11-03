/**
 * Browser preview of brief import: a canned proposal for a small invoicing brief.
 * `analyze` streams a few progress lines before it answers, and honours `cancel`.
 */

import type { BriefAPI, BriefProgressEvent, BriefProposal } from '../../../shared/types';

export const sampleBriefProposal: BriefProposal = {
  briefId: '20261103-1430-invoicing-v1',
  title: 'Invoicing v1',
  summary: 'Customers can create invoices, send them by email and export them; finance can see what is unpaid.',
  epics: [
    { key: 'E1', title: 'Invoices', summary: 'Create, edit and number invoices' },
    { key: 'E2', title: 'Delivery', summary: 'Email and PDF' },
    { key: 'E3', title: 'Finance view', summary: 'What is unpaid, and exports' },
  ],
  tasks: [
    {
      key: 'T1',
      title: 'Invoice data model and API',
      description: 'Invoices with line items, totals and sequential numbering per organisation.',
      epic: 'E1',
      acceptanceCriteria: [
        'Given an organisation, when two invoices are created, then they get consecutive numbers.',
        'Given line items, when an invoice is saved, then totals include tax per line.',
      ],
      dependsOn: [],
      complexity: 'medium',
      priority: 'high',
      category: 'feature',
      sourceSection: '2. Invoices',
    },
    {
      key: 'T2',
      title: 'Invoice editor',
      description: 'Form to create and edit draft invoices: customer, line items, tax rate per line, notes.',
      epic: 'E1',
      acceptanceCriteria: [
        'Given a draft, when a line is added, then the total updates immediately.',
        'Given a final invoice, when it is opened, then the editor is read-only.',
      ],
      dependsOn: ['T1'],
      complexity: 'medium',
      priority: 'medium',
      category: 'ui_ux',
      sourceSection: '2.1 Editor',
    },
    {
      key: 'T3',
      title: 'Render invoice to PDF',
      description: 'Server-side PDF with the organisation logo, line items and totals.',
      epic: 'E2',
      acceptanceCriteria: ['Given a final invoice, when the PDF is requested, then it matches the on-screen totals.'],
      dependsOn: ['T1'],
      complexity: 'medium',
      priority: 'medium',
      category: 'feature',
      sourceSection: '3.1 PDF',
    },
    {
      key: 'T4',
      title: 'Send invoice by email',
      description: 'Email the PDF to the customer and record when it was sent.',
      epic: 'E2',
      acceptanceCriteria: [
        'Given a final invoice, when it is sent, then the customer receives an email with the PDF attached.',
        'Given a sent invoice, when the list is opened, then it shows the sent date.',
      ],
      dependsOn: ['T3'],
      complexity: 'large',
      priority: 'medium',
      category: 'feature',
      sourceSection: '3.2 Email',
    },
    {
      key: 'T5',
      title: 'Unpaid invoices view',
      description: 'A list of unpaid invoices for finance, oldest first, with days overdue.',
      epic: 'E3',
      acceptanceCriteria: ['Given unpaid invoices, when finance opens the view, then the oldest is first with days overdue.'],
      dependsOn: ['T1', 'T4'],
      complexity: 'small',
      priority: 'high',
      category: 'feature',
      sourceSection: '4. Finance',
    },
    {
      key: 'T6',
      title: 'CSV export of invoices',
      description: 'Export invoices in a date range to CSV for the accounting tool.',
      epic: 'E3',
      acceptanceCriteria: [],
      dependsOn: ['T1'],
      complexity: 'small',
      priority: 'low',
      category: 'feature',
      sourceSection: '4.2 Export',
    },
  ],
  assumptions: ['One currency per organisation in v1.', 'Tax is a percentage per line; no compound taxes.'],
  openQuestions: ['Which email provider should be used?', 'Do credit notes need their own number sequence?'],
};

const PROGRESS = [
  'Reading invoicing-brief.md (4 sections, 2 300 words)',
  'Indexing the project with CodeGraph',
  'Found models in src/server/models (Organisation, Customer)',
  'Matching "2. Invoices" to existing code',
  'Drafting tasks for epic E1 Invoices',
  'Drafting tasks for epic E2 Delivery',
  'Drafting tasks for epic E3 Finance view',
  'Checking dependencies between tasks',
];
const STEP_MS = 650;

const listeners = new Set<(event: BriefProgressEvent) => void>();
let runId = 0;

export const briefMock: BriefAPI = {
  pickFile: async () => ({ success: true, data: '/Users/demo/Documents/invoicing-brief.md' }),
  pathForFile: (file: File) => `/Users/demo/Downloads/${file.name}`,
  analyze: async (projectId) => {
    const id = ++runId;
    for (const message of PROGRESS) {
      await new Promise((r) => setTimeout(r, STEP_MS));
      if (id !== runId) return { success: false, error: 'Cancelled' };
      for (const cb of listeners) cb({ projectId, message });
    }
    await new Promise((r) => setTimeout(r, STEP_MS));
    if (id !== runId) return { success: false, error: 'Cancelled' };
    return { success: true, data: sampleBriefProposal };
  },
  cancel: async () => {
    runId += 1;
    return { success: true };
  },
  createTasks: async (_projectId, _briefId, tasks) => ({
    success: true,
    data: tasks.map((t, i) => ({ key: t.key, taskId: `brief-task-${i}`, specId: `${String(10 + i).padStart(3, '0')}-${t.key.toLowerCase()}` })),
  }),
  onProgress: (callback) => {
    listeners.add(callback);
    return () => {
      listeners.delete(callback);
    };
  },
};
