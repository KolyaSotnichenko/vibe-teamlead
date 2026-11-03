/**
 * Browser preview of brief import: a canned proposal for a small invoicing brief.
 */

import type { BriefAPI, BriefProposal } from '../../../shared/types';

export const sampleBriefProposal: BriefProposal = {
  briefId: '20261103-1430-invoicing-v1',
  title: 'Invoicing v1',
  summary: 'Customers can create invoices, send them by email and export them; finance can see what is unpaid.',
  epics: [
    { key: 'E1', title: 'Invoices', summary: 'Create, edit and number invoices' },
    { key: 'E2', title: 'Delivery', summary: 'Email and PDF' },
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
      description: 'Form to create and edit draft invoices.',
      epic: 'E1',
      acceptanceCriteria: ['Given a draft, when a line is added, then the total updates immediately.'],
      dependsOn: ['T1'],
      complexity: 'medium',
      priority: 'medium',
      category: 'feature',
      sourceSection: '2.1 Editor',
    },
    {
      key: 'T3',
      title: 'Send invoice by email with PDF',
      description: 'Render the invoice to PDF and email it to the customer.',
      epic: 'E2',
      acceptanceCriteria: ['Given a final invoice, when it is sent, then the customer receives an email with the PDF attached.'],
      dependsOn: ['T1'],
      complexity: 'large',
      priority: 'medium',
      category: 'feature',
      sourceSection: '3. Delivery',
    },
  ],
  assumptions: ['One currency per organisation in v1.'],
  openQuestions: ['Which email provider should be used?'],
};

export const briefMock: BriefAPI = {
  pickFile: async () => ({ success: true, data: '/Users/demo/Documents/invoicing-brief.md' }),
  pathForFile: (file: File) => `/Users/demo/Downloads/${file.name}`,
  analyze: async () => {
    await new Promise((r) => setTimeout(r, 1200));
    return { success: true, data: sampleBriefProposal };
  },
  cancel: async () => ({ success: true }),
  createTasks: async (_projectId, _briefId, tasks) => ({
    success: true,
    data: tasks.map((t, i) => ({ key: t.key, taskId: `brief-task-${i}`, specId: `${String(10 + i).padStart(3, '0')}-${t.key.toLowerCase()}` })),
  }),
  onProgress: () => () => {},
};
