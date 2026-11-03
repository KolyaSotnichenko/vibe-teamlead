/**
 * Task workspace IPC handlers
 *
 * TASK_WORKSPACE_GET   → parsed view of a task's spec directory (spec, ACs, plan,
 *                        timeline from real log timestamps, architecture docs)
 * TASK_WORKSPACE_OPEN_FILE → open a file inside the spec directory with the
 *                        system default app (e.g. a .drawio in draw.io)
 */

import { ipcMain, shell } from 'electron';
import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import path from 'path';
import { IPC_CHANNELS, getSpecsDir } from '../../../shared/constants';
import type { IPCResult } from '../../../shared/types';
import type { TaskWorkspace, WorkspaceAdr, WorkspaceArchitecture, WorkspaceDiagram } from '../../../shared/types/task-workspace';
import { ensureAbsolutePath } from '../../utils/path-helpers';
import { findTaskAndProject } from './shared';
import {
  buildTimeline,
  mergeCriteria,
  parseAcceptanceCriteria,
  parseAdr,
  parsePlan,
  parseQaCoverage,
} from './workspace-parsers';

/** Markdown/JSON larger than this is skipped rather than shipped over IPC */
const MAX_TEXT_BYTES = 2 * 1024 * 1024;
/** PNG previews larger than this are skipped */
const MAX_PNG_BYTES = 8 * 1024 * 1024;

function readText(filePath: string): string | undefined {
  try {
    if (!existsSync(filePath)) return undefined;
    const stats = statSync(filePath);
    if (!stats.isFile() || stats.size > MAX_TEXT_BYTES) return undefined;
    return readFileSync(filePath, 'utf-8');
  } catch {
    return undefined;
  }
}

function readJson(filePath: string): unknown {
  const text = readText(filePath);
  if (text === undefined) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function listFiles(dir: string): string[] {
  try {
    if (!existsSync(dir)) return [];
    return readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isFile())
      .map((d) => d.name)
      .sort((a, b) => a.localeCompare(b));
  } catch {
    return [];
  }
}

function readPngDataUrl(filePath: string): string | undefined {
  try {
    if (!existsSync(filePath)) return undefined;
    const stats = statSync(filePath);
    if (!stats.isFile() || stats.size > MAX_PNG_BYTES) return undefined;
    return `data:image/png;base64,${readFileSync(filePath).toString('base64')}`;
  } catch {
    return undefined;
  }
}

export function loadArchitecture(specDir: string): WorkspaceArchitecture {
  const archDir = path.join(specDir, 'architecture');
  const markdown = readText(path.join(archDir, 'architecture.md'));

  const adrDir = path.join(archDir, 'adr');
  const adrs: WorkspaceAdr[] = [];
  for (const fileName of listFiles(adrDir)) {
    if (!/\.md$/i.test(fileName) || /^(readme|template)/i.test(fileName)) continue;
    const text = readText(path.join(adrDir, fileName));
    if (text !== undefined) adrs.push(parseAdr(fileName, text));
  }

  const diagramDir = path.join(archDir, 'diagrams');
  const diagrams: WorkspaceDiagram[] = [];
  for (const fileName of listFiles(diagramDir)) {
    const ext = path.extname(fileName).toLowerCase();
    const name = path.basename(fileName, path.extname(fileName));
    if (ext === '.drawio') {
      const pngDataUrl = readPngDataUrl(path.join(diagramDir, `${name}.png`)) ?? readPngDataUrl(path.join(diagramDir, `${name}.drawio.png`));
      diagrams.push({
        name,
        kind: 'drawio',
        drawioPath: path.posix.join('architecture', 'diagrams', fileName),
        ...(pngDataUrl ? { pngDataUrl } : {}),
      });
    } else if (ext === '.mmd' || ext === '.mermaid') {
      const source = readText(path.join(diagramDir, fileName));
      if (source?.trim()) diagrams.push({ name, kind: 'mermaid', mermaidSource: source });
    }
  }

  return { ...(markdown !== undefined ? { markdown } : {}), adrs, diagrams };
}

/** Read and parse every workspace artifact in a spec directory. Never throws. */
export function loadTaskWorkspace(specDir: string): TaskWorkspace {
  const specMarkdown = readText(path.join(specDir, 'spec.md'));
  const plan = parsePlan(readJson(path.join(specDir, 'implementation_plan.json')));
  const qaMarkdown = readText(path.join(specDir, 'qa_report.md'));
  const qaRows = qaMarkdown !== undefined ? parseQaCoverage(qaMarkdown) : null;
  const timeline = buildTimeline(readJson(path.join(specDir, 'task_logs.json')));

  return {
    specDir,
    ...(specMarkdown !== undefined
      ? { spec: { markdown: specMarkdown, criteria: mergeCriteria(parseAcceptanceCriteria(specMarkdown), qaRows, plan) } }
      : {}),
    hasQaCoverage: qaRows !== null,
    ...(plan ? { plan } : {}),
    timeline,
    architecture: loadArchitecture(specDir),
  };
}

function resolveSpecDir(taskId: string, projectId?: string): string | null {
  const { task, project } = findTaskAndProject(taskId, projectId);
  if (!task || !project) return null;
  if (task.specsPath) return task.specsPath;
  return path.join(ensureAbsolutePath(project.path), getSpecsDir(project.autoBuildPath), task.specId);
}

/** True when `target` is `root` or lies inside it (after resolving `..`). */
export function isInside(root: string, target: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

export function registerTaskWorkspaceHandlers(): void {
  ipcMain.handle(
    IPC_CHANNELS.TASK_WORKSPACE_GET,
    async (_, taskId: string, projectId?: string): Promise<IPCResult<TaskWorkspace | null>> => {
      try {
        const specDir = resolveSpecDir(taskId, projectId);
        if (!specDir) return { success: false, error: 'Task not found' };
        if (!existsSync(specDir)) return { success: true, data: null };
        return { success: true, data: loadTaskWorkspace(specDir) };
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : 'Failed to load task workspace' };
      }
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.TASK_WORKSPACE_OPEN_FILE,
    async (_, taskId: string, relativePath: string, projectId?: string): Promise<IPCResult> => {
      try {
        const specDir = resolveSpecDir(taskId, projectId);
        if (!specDir) return { success: false, error: 'Task not found' };
        if (typeof relativePath !== 'string' || !relativePath || path.isAbsolute(relativePath)) {
          return { success: false, error: 'Invalid path' };
        }
        const target = path.resolve(specDir, relativePath);
        if (!isInside(specDir, target) || !existsSync(target)) {
          return { success: false, error: 'File not found' };
        }
        const error = await shell.openPath(target);
        return error ? { success: false, error } : { success: true };
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : 'Failed to open file' };
      }
    }
  );
}
