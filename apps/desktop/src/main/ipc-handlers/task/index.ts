/**
 * Task handlers module
 *
 * This module organizes all task-related IPC handlers into logical groups:
 * - CRUD operations (create, read, update, delete)
 * - Execution management (start, stop, review, status, recovery)
 * - Worktree operations (status, diff, merge, discard, list)
 * - Logs management (get, watch, unwatch)
 * - Workspace (parsed spec-dir artifacts)
 */

import { BrowserWindow } from 'electron';
import { AgentManager } from '../../agent';
import { registerTaskCRUDHandlers } from './crud-handlers';
import { registerTaskExecutionHandlers } from './execution-handlers';
import { registerWorktreeHandlers } from './worktree-handlers';
import { registerTaskLogsHandlers } from './logs-handlers';
import { registerTaskArchiveHandlers } from './archive-handlers';
import { registerTaskWorkspaceHandlers } from './workspace-handlers';

/**
 * Register all task-related IPC handlers
 */
export function registerTaskHandlers(
  agentManager: AgentManager,
  getMainWindow: () => BrowserWindow | null
): void {
  // Register CRUD handlers (create, read, update, delete)
  registerTaskCRUDHandlers(agentManager);

  // Register execution handlers (start, stop, review, status management, recovery)
  registerTaskExecutionHandlers(agentManager, getMainWindow);

  // Register worktree handlers (status, diff, merge, discard, list)
  registerWorktreeHandlers(getMainWindow);

  // Register logs handlers (get, watch, unwatch)
  registerTaskLogsHandlers(getMainWindow);

  // Register archive handlers (archive, unarchive)
  registerTaskArchiveHandlers();

  // Register workspace handlers (parsed spec, plan, timeline, architecture)
  registerTaskWorkspaceHandlers();
}

// Export shared utilities for use by other modules if needed
export { findTaskAndProject } from './shared';
