import type { TaskLogs } from '../../../shared/types';
/**
 * Mock implementation for task operations
 */

import type { TaskRecoveryOptions } from '../../../shared/types';
import { mockTasks } from './mock-data';

export const taskMock = {
  getTasks: async (projectId: string) => ({
    success: true,
    data: mockTasks.filter(t => t.projectId === projectId)
  }),

  createTask: async (projectId: string, title: string, description: string) => ({
    success: true,
    data: {
      id: `task-${Date.now()}`,
      projectId,
      specId: `00${mockTasks.length + 1}-new-task`,
      title,
      description,
      status: 'backlog' as const,
      subtasks: [],
      logs: [],
      createdAt: new Date(),
      updatedAt: new Date()
    }
  }),

  deleteTask: async () => ({ success: true }),

  updateTask: async (_taskId: string, updates: { title?: string; description?: string }) => ({
    success: true,
    data: {
      id: _taskId,
      projectId: 'mock-project-1',
      specId: '001-updated',
      title: updates.title || 'Updated Task',
      description: updates.description || 'Updated description',
      status: 'backlog' as const,
      subtasks: [],
      logs: [],
      createdAt: new Date(),
      updatedAt: new Date()
    }
  }),

  startTask: () => {
    console.warn('[Browser Mock] startTask called');
  },

  stopTask: () => {
    console.warn('[Browser Mock] stopTask called');
  },

  submitReview: async () => ({ success: true }),

  // Task archive operations
  archiveTasks: async () => ({ success: true, data: true }),
  unarchiveTasks: async () => ({ success: true, data: true }),

  // Task status operations
  updateTaskStatus: async (_taskId: string, _status: string, _options?: { forceCleanup?: boolean }) => ({ success: true }),

  recoverStuckTask: async (taskId: string, options?: TaskRecoveryOptions) => ({
    success: true,
    data: {
      taskId,
      recovered: true,
      newStatus: options?.targetStatus || 'backlog',
      message: '[Browser Mock] Task recovered successfully'
    }
  }),

  checkTaskRunning: async () => ({ success: true, data: false }),

  resumePausedTask: async () => ({ success: true }),

  // Worktree change detection
  checkWorktreeChanges: async (_taskId: string) => ({
    success: true as const,
    data: { hasChanges: false }
  }),

  // Image operations
  loadImageThumbnail: async (_projectPath: string, _specId: string, _imagePath: string) => ({
    success: false,
    error: 'Image loading not available in browser mode'
  }),

  // Task logs operations
  getTaskLogs: async (_projectId: string, specId: string) => {
    // Sample phase logs so the Logs tab can be reviewed in the browser
    const at = (m: number) => new Date(Date.now() - m * 60_000).toISOString();
    const e = (m: number, type: string, content: string, extra: Record<string, string> = {}) => ({ timestamp: at(m), type, content, phase: 'coding', ...extra });
    return {
      success: true as const,
      data: {
        spec_id: specId,
        created_at: at(30),
        updated_at: at(0),
        phases: {
          planning: { phase: 'planning', status: 'completed', started_at: at(30), completed_at: at(20), entries: [{ timestamp: at(25), type: 'text', content: 'Spec written', phase: 'planning' }] },
          coding: {
            phase: 'coding', status: 'active', started_at: at(20), completed_at: null,
            entries: [
              e(9, 'text', 'Starting subtask 1-1: add the rate limiter middleware'),
              e(8, 'tool_start', '', { tool_name: 'Read', tool_input: 'apps/api/src/main.ts' }),
              e(8, 'tool_end', '', { tool_name: 'Read', detail: 'import { NestFactory } from "@nestjs/core";' }),
              e(7, 'tool_start', '', { tool_name: 'Bash', tool_input: 'cat apps/api/prisma/schema.prisma' }),
              e(7, 'tool_end', '', { tool_name: 'Bash', detail: 'model User {\n  id String @id\n}' }),
              e(6, 'tool_start', '', { tool_name: 'mcp__vibe-teamlead__update_subtask_status', tool_input: 'subtask-1-1 in_progress' }),
              e(6, 'tool_end', '', { tool_name: 'mcp__vibe-teamlead__update_subtask_status' }),
              e(5, 'error', 'Test failed: expected 429, got 200', { detail: 'AssertionError: expected 200 to be 429' }),
              e(4, 'success', 'Tests pass'),
              e(1, 'tool_start', '', { tool_name: 'Bash', tool_input: 'pnpm --filter api test' }),
            ],
          },
          validation: { phase: 'validation', status: 'pending', started_at: null, completed_at: null, entries: [] },
        },
      } as unknown as TaskLogs,
    };
  },

  watchTaskLogs: async () => ({ success: true }),

  unwatchTaskLogs: async () => ({ success: true }),

  // Event Listeners (no-op in browser)
  onTaskProgress: () => () => {},
  onTaskError: () => () => {},
  onTaskLog: () => () => {},
  onTaskStatusChange: () => () => {},
  onTaskExecutionProgress: () => () => {},
  onTaskLogsChanged: () => () => {},
  onTaskLogsStream: () => () => {},
  onMergeProgress: () => () => {}
};
