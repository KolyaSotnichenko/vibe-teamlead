/**
 * Mock data for browser preview
 * Contains sample projects, tasks, and sessions for UI development/testing
 */

import type { Task } from '../../../shared/types';

import { DEFAULT_PROJECT_SETTINGS } from '../../../shared/constants';

export const mockProjects = [
  {
    id: 'mock-project-1',
    name: 'sample-project',
    path: '/Users/demo/projects/sample-project',
    autoBuildPath: '/Users/demo/projects/sample-project/.vibe-teamlead',
    settings: DEFAULT_PROJECT_SETTINGS,
    createdAt: new Date(),
    updatedAt: new Date()
  },
  {
    id: 'mock-project-2',
    name: 'another-project',
    path: '/Users/demo/projects/another-project',
    autoBuildPath: '/Users/demo/projects/another-project/.vibe-teamlead',
    settings: DEFAULT_PROJECT_SETTINGS,
    createdAt: new Date(),
    updatedAt: new Date()
  }
];

export const mockInsightsSessions = [
  {
    id: 'session-1',
    projectId: 'mock-project-1',
    title: 'Architecture discussion',
    messageCount: 5,
    createdAt: new Date(Date.now() - 1000 * 60 * 30), // 30 minutes ago
    updatedAt: new Date(Date.now() - 1000 * 60 * 30)
  },
  {
    id: 'session-2',
    projectId: 'mock-project-1',
    title: 'Code review suggestions',
    messageCount: 12,
    createdAt: new Date(Date.now() - 1000 * 60 * 60 * 2), // 2 hours ago
    updatedAt: new Date(Date.now() - 1000 * 60 * 60 * 2)
  },
  {
    id: 'session-3',
    projectId: 'mock-project-1',
    title: 'Security analysis',
    messageCount: 8,
    createdAt: new Date(Date.now() - 1000 * 60 * 60 * 24), // Yesterday
    updatedAt: new Date(Date.now() - 1000 * 60 * 60 * 24)
  },
  {
    id: 'session-4',
    projectId: 'mock-project-1',
    title: 'Performance optimization',
    messageCount: 3,
    createdAt: new Date(Date.now() - 1000 * 60 * 60 * 24 * 3), // 3 days ago
    updatedAt: new Date(Date.now() - 1000 * 60 * 60 * 24 * 3)
  }
];

const MIN = 60_000;
const sub = (id: string, title: string, status: 'pending' | 'in_progress' | 'completed' | 'failed', files: string[] = []) => ({
  id,
  title,
  description: title,
  status,
  files
});

/**
 * Board preview: one task per state the agent team can be in
 * (spec writer asking, coder mid-plan, QA, review, failed, done).
 */
export const mockTasks: Task[] = [
  {
    id: 'task-1',
    projectId: 'mock-project-1',
    specId: '001-add-auth',
    title: 'Add user authentication',
    description: 'Implement JWT-based user authentication with **login/logout** and password reset.\n\n- Email + password first\n- Sessions survive a reload',
    status: 'in_progress',
    subtasks: [],
    logs: [],
    executionProgress: { phase: 'planning', phaseProgress: 0.4, overallProgress: 0.1, message: 'Spec creation: requirements (2/5)', startedAt: new Date(Date.now() - 6 * MIN) },
    metadata: { category: 'feature', priority: 'high', sourceType: 'manual' },
    createdAt: new Date(Date.now() - 86400000),
    updatedAt: new Date(Date.now() - 1 * MIN)
  },
  {
    id: 'task-2',
    projectId: 'mock-project-1',
    specId: '002-dashboard',
    title: 'Build analytics dashboard',
    description: 'Create a real-time analytics dashboard with charts and metrics',
    status: 'in_progress',
    location: 'worktree',
    subtasks: [
      sub('subtask-1', 'Setup chart library', 'completed', ['src/lib/charts.ts']),
      sub('subtask-2', 'Metrics API client', 'completed', ['src/api/metrics.ts']),
      sub('subtask-3', 'Dashboard grid layout', 'completed', ['src/components/Dashboard.tsx']),
      sub('subtask-4', 'Revenue chart with live updates', 'in_progress', ['src/components/RevenueChart.tsx']),
      sub('subtask-5', 'Empty and error states', 'pending'),
      sub('subtask-6', 'Export chart as PNG', 'pending')
    ],
    logs: ['[INFO] Starting task...', '[INFO] Subtask 3 completed', '[INFO] Working on subtask 4...'],
    executionProgress: { phase: 'coding', phaseProgress: 50, overallProgress: 55, currentSubtask: 'subtask-4', message: 'Iteration 7 (coding)', startedAt: new Date(Date.now() - 52 * MIN), completedPhases: ['planning'] },
    metadata: { category: 'feature', complexity: 'medium', baseBranch: 'main', sourceType: 'roadmap' },
    createdAt: new Date(Date.now() - 3600000),
    updatedAt: new Date(Date.now() - 2 * MIN)
  },
  {
    id: 'task-6',
    projectId: 'mock-project-1',
    specId: '006-rate-limit',
    title: 'Rate-limit the public API',
    description: 'Return 429 with Retry-After when a client exceeds 100 requests per minute per API key.',
    status: 'backlog',
    subtasks: [],
    logs: [],
    metadata: { category: 'security', priority: 'urgent', sourceType: 'insights' },
    createdAt: new Date(Date.now() - 3 * 3600000),
    updatedAt: new Date(Date.now() - 3 * 3600000)
  },
  {
    id: 'task-7',
    projectId: 'mock-project-1',
    specId: '007-sqlite-settings',
    title: 'Move settings storage to SQLite',
    description: 'Replace the JSON settings file with a SQLite table and migrate existing values on first launch.',
    status: 'queue',
    subtasks: [
      sub('subtask-1', 'Schema and migration', 'pending'),
      sub('subtask-2', 'Settings repository', 'pending'),
      sub('subtask-3', 'Import old JSON once', 'pending'),
      sub('subtask-4', 'Remove JSON writer', 'pending')
    ],
    logs: [],
    executionProgress: { phase: 'idle', phaseProgress: 0, overallProgress: 0, completedPhases: ['planning'] },
    metadata: { category: 'refactoring', complexity: 'large', requireReviewBeforeCoding: true },
    createdAt: new Date(Date.now() - 5 * 3600000),
    updatedAt: new Date(Date.now() - 40 * MIN)
  },
  {
    id: 'task-8',
    projectId: 'mock-project-1',
    specId: '008-invoice-csv',
    title: 'Export invoices to CSV',
    description: 'Finance downloads the filtered invoice list as CSV.',
    status: 'ai_review',
    location: 'worktree',
    subtasks: [
      sub('subtask-1', 'RFC 4180 serializer', 'completed', ['src/export/csv.ts']),
      sub('subtask-2', 'Streaming export endpoint', 'completed', ['src/routes/invoices.ts']),
      sub('subtask-3', 'Export button with disabled reason', 'completed', ['src/ui/ExportButton.tsx']),
      sub('subtask-4', 'Role check on export', 'completed', ['src/routes/invoices.ts']),
      sub('subtask-5', 'E2E download test', 'completed', ['e2e/export.spec.ts'])
    ],
    logs: [],
    executionProgress: { phase: 'qa_review', phaseProgress: 0, overallProgress: 80, message: 'Running QA review', startedAt: new Date(Date.now() - 95 * MIN), completedPhases: ['planning', 'coding'] },
    metadata: { category: 'feature', baseBranch: 'main' },
    createdAt: new Date(Date.now() - 6 * 3600000),
    updatedAt: new Date(Date.now() - 4 * MIN)
  },
  {
    id: 'task-3',
    projectId: 'mock-project-1',
    specId: '003-fix-bug',
    title: 'Fix pagination bug',
    description: 'Fix off-by-one error in table pagination',
    status: 'human_review',
    reviewReason: 'completed',
    location: 'worktree',
    subtasks: [
      sub('subtask-1', 'Failing test for the last page', 'completed', ['src/utils/pagination.test.ts']),
      sub('subtask-2', 'Fix offset calculation', 'completed', ['src/utils/pagination.ts'])
    ],
    logs: ['[INFO] Task completed, awaiting review'],
    executionProgress: { phase: 'complete', phaseProgress: 100, overallProgress: 100, completedPhases: ['planning', 'coding', 'qa_review'] },
    metadata: { category: 'bug_fix', complexity: 'small', baseBranch: 'main' },
    createdAt: new Date(Date.now() - 7200000),
    updatedAt: new Date(Date.now() - 1800000)
  },
  {
    id: 'task-9',
    projectId: 'mock-project-1',
    specId: '009-webhook-retries',
    title: 'Retry failed webhooks with backoff',
    description: 'Retry webhook deliveries up to 5 times with exponential backoff and record each attempt.',
    status: 'human_review',
    reviewReason: 'qa_rejected',
    location: 'worktree',
    subtasks: [
      sub('subtask-1', 'Attempts table', 'completed'),
      sub('subtask-2', 'Backoff scheduler', 'completed'),
      sub('subtask-3', 'Delivery log UI', 'completed')
    ],
    logs: [],
    executionProgress: { phase: 'failed', phaseProgress: 0, overallProgress: 90, completedPhases: ['planning', 'coding', 'qa_review', 'qa_fixing'] },
    metadata: { category: 'infrastructure' },
    createdAt: new Date(Date.now() - 26 * 3600000),
    updatedAt: new Date(Date.now() - 3 * 3600000)
  },
  {
    id: 'task-10',
    projectId: 'mock-project-1',
    specId: '010-image-upload',
    title: 'Resize avatars on upload',
    description: 'Store a 256px and a 64px version of every uploaded avatar.',
    status: 'human_review',
    reviewReason: 'errors',
    subtasks: [
      sub('subtask-1', 'Upload endpoint accepts images', 'completed'),
      sub('subtask-2', 'Resize with sharp', 'failed'),
      sub('subtask-3', 'Serve the right size', 'pending')
    ],
    logs: [],
    executionProgress: { phase: 'failed', phaseProgress: 0, overallProgress: 40, completedPhases: ['planning'] },
    metadata: { category: 'feature' },
    createdAt: new Date(Date.now() - 30 * 3600000),
    updatedAt: new Date(Date.now() - 5 * 3600000)
  },
  {
    id: 'task-4',
    projectId: 'mock-project-1',
    specId: '004-refactor',
    title: 'Refactor API layer',
    description: 'Consolidate API calls into a single service',
    status: 'done',
    subtasks: [
      sub('subtask-1', 'Create API service', 'completed', ['src/services/api.ts']),
      sub('subtask-2', 'Migrate endpoints', 'completed', ['src/components/*.tsx'])
    ],
    logs: ['[INFO] Task completed successfully'],
    createdAt: new Date(Date.now() - 172800000),
    updatedAt: new Date(Date.now() - 86400000)
  },
  {
    id: 'task-5',
    projectId: 'mock-project-1',
    specId: '005-add-search',
    title: 'Add search functionality',
    description: 'Implement full-text search across all entities',
    status: 'pr_created',
    subtasks: [
      sub('subtask-1', 'Setup search index', 'completed', ['src/lib/search.ts']),
      sub('subtask-2', 'Add search UI', 'completed', ['src/components/Search.tsx'])
    ],
    logs: ['[INFO] Task completed, PR created'],
    metadata: { prUrl: 'https://github.com/example/sample-project/pull/42' },
    createdAt: new Date(Date.now() - 259200000),
    updatedAt: new Date(Date.now() - 43200000)
  }
];
