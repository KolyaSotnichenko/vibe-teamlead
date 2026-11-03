/**
 * Brief import IPC: choose a brief, analyse it into epics and tasks, create
 * the tasks the user confirmed (in dependency order, with dependencies stored
 * as spec ids so the queue waits for them).
 */

import { existsSync } from 'node:fs';
import path from 'node:path';

import { type BrowserWindow, dialog, ipcMain } from 'electron';

import { AUTO_BUILD_PATHS, IPC_CHANNELS } from '../../shared/constants';
import type { BriefAnalyzeInput, BriefCreatedTask, BriefCreateOptions, BriefProposal, BriefTaskDraft, IPCResult } from '../../shared/types';
import { BriefError, analyzeBrief, briefsRoot, taskDescription } from '../ai/runners/brief-import';
import { projectStore } from '../project-store';
import { persistPlanStatus } from './task/plan-file-utils';
import { createTaskInProject } from './task/crud-handlers';
import { resolveDefaultTaskModels } from '../../shared/utils/task-models';
import { readSettingsFile } from '../settings-utils';

const BRIEF_FILE_EXTENSIONS = ['md', 'markdown', 'txt', 'pdf', 'docx', 'doc', 'rtf', 'odt', 'html', 'htm'];

/** Order tasks so every task comes after the tasks it depends on (input order otherwise). */
export function orderByDependencies(tasks: BriefTaskDraft[]): BriefTaskDraft[] {
  const byKey = new Map(tasks.map((t) => [t.key, t]));
  const ordered: BriefTaskDraft[] = [];
  const state = new Map<string, 'visiting' | 'done'>();
  const visit = (task: BriefTaskDraft) => {
    if (state.get(task.key) === 'done' || state.get(task.key) === 'visiting') return; // cycles are broken here
    state.set(task.key, 'visiting');
    for (const dep of task.dependsOn) {
      const prerequisite = byKey.get(dep);
      if (prerequisite) visit(prerequisite);
    }
    state.set(task.key, 'done');
    ordered.push(task);
  };
  for (const task of tasks) visit(task);
  return ordered;
}

export function registerBriefHandlers(getMainWindow: () => BrowserWindow | null): void {
  const running = new Map<string, AbortController>();

  ipcMain.handle(IPC_CHANNELS.BRIEF_PICK_FILE, async (): Promise<IPCResult<string | null>> => {
    const window = getMainWindow();
    const options: Electron.OpenDialogOptions = {
      properties: ['openFile'],
      filters: [{ name: 'Brief', extensions: BRIEF_FILE_EXTENSIONS }],
    };
    const result = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options);
    return { success: true, data: result.canceled ? null : (result.filePaths[0] ?? null) };
  });

  ipcMain.handle(
    IPC_CHANNELS.BRIEF_ANALYZE,
    async (_event, projectId: string, input: BriefAnalyzeInput): Promise<IPCResult<BriefProposal>> => {
      const project = projectStore.getProject(projectId);
      if (!project) return { success: false, error: 'Project not found' };
      if (!project.autoBuildPath) return { success: false, error: 'Initialize the project first.' };

      running.get(projectId)?.abort();
      const controller = new AbortController();
      running.set(projectId, controller);
      try {
        const proposal = await analyzeBrief({
          projectPath: project.path,
          autoBuildPath: project.autoBuildPath,
          input: { text: typeof input?.text === 'string' ? input.text : undefined, filePath: typeof input?.filePath === 'string' ? input.filePath : undefined },
          signal: controller.signal,
          onProgress: (message) => getMainWindow()?.webContents.send(IPC_CHANNELS.BRIEF_PROGRESS, { projectId, message }),
        });
        return { success: true, data: proposal };
      } catch (error) {
        if (controller.signal.aborted) return { success: false, error: 'Cancelled' };
        const message = error instanceof BriefError || error instanceof Error ? error.message : 'Brief analysis failed';
        return { success: false, error: message };
      } finally {
        if (running.get(projectId) === controller) running.delete(projectId);
      }
    },
  );

  ipcMain.handle(IPC_CHANNELS.BRIEF_CANCEL, async (_event, projectId: string): Promise<IPCResult> => {
    running.get(projectId)?.abort();
    running.delete(projectId);
    return { success: true };
  });

  ipcMain.handle(
    IPC_CHANNELS.BRIEF_CREATE_TASKS,
    async (
      _event,
      projectId: string,
      briefId: string,
      tasks: BriefTaskDraft[],
      options: BriefCreateOptions,
    ): Promise<IPCResult<BriefCreatedTask[]>> => {
      const project = projectStore.getProject(projectId);
      if (!project) return { success: false, error: 'Project not found' };
      if (typeof briefId !== 'string' || !/^[\w.-]+$/.test(briefId)) return { success: false, error: 'Invalid brief' };
      const briefDir = path.join(briefsRoot(project.path, project.autoBuildPath), briefId);
      if (!existsSync(briefDir)) return { success: false, error: 'The brief was not found in this project.' };
      if (!Array.isArray(tasks) || tasks.length === 0) return { success: false, error: 'No tasks to create.' };

      const briefFile = existsSync(path.join(briefDir, 'brief.md')) ? 'brief.md' : 'source.pdf';
      const briefRelPath = path.relative(project.path, path.join(briefDir, briefFile));
      const specIdByKey = new Map<string, string>();
      const created: BriefCreatedTask[] = [];

      try {
        for (const draft of orderByDependencies(tasks)) {
          const dependencies = draft.dependsOn.map((key) => specIdByKey.get(key)).filter((id): id is string => !!id);
          const task = await createTaskInProject(project, draft.title, taskDescription(draft, briefRelPath), {
            // The user's default models (agent profile + custom phase models), as the task wizard sets them
            ...resolveDefaultTaskModels(readSettingsFile() as never),
            sourceType: 'brief',
            briefId,
            briefTaskKey: draft.key,
            category: draft.category,
            complexity: draft.complexity,
            priority: draft.priority,
            acceptanceCriteria: draft.acceptanceCriteria,
            ...(dependencies.length ? { dependencies } : {}),
          });
          specIdByKey.set(draft.key, task.specId);
          if (options?.queue && task.specsPath) {
            await persistPlanStatus(path.join(task.specsPath, AUTO_BUILD_PATHS.IMPLEMENTATION_PLAN), 'queue', projectId);
          }
          created.push({ key: draft.key, taskId: task.id, specId: task.specId });
        }
        projectStore.invalidateTasksCache(projectId);
        return { success: true, data: created };
      } catch (error) {
        projectStore.invalidateTasksCache(projectId);
        const message = error instanceof Error ? error.message : 'Failed to create tasks';
        return {
          success: false,
          error: created.length ? `${message} (${created.length} of ${tasks.length} tasks were created)` : message,
        };
      }
    },
  );
}
