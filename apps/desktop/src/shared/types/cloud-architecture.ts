/**
 * Cloud architecture diagrams (TerraVision, experimental): what the project's
 * Context → Architecture tab and Settings → Agents show.
 */

import type { IPCResult } from './common';

/** In the description of the task Context → Architecture creates: always a cloud task for the architect. */
export const CLOUD_DESIGN_MARKER = '<!-- vibe-teamlead:cloud-architecture-design -->';

export type CloudTool = 'uv' | 'graphviz' | 'git' | 'terraform';

export type CloudDrawStatus = 'drawn' | 'unavailable' | 'needs_cloud_access' | 'refused' | 'failed';

export interface CloudToolsState {
  /** TerraVision can draw (uv or terravision, Graphviz, Git) */
  ready: boolean;
  /** Terraform or OpenTofu too: it can draw from code */
  drawFromCode: boolean;
  missing: CloudTool[];
  /** One install line per tool for this platform */
  hints: Record<CloudTool, string>;
}

export interface CloudFromCode {
  /** The latest drawing */
  drawn?: {
    commit: string;
    taskId?: string;
    taskTitle?: string;
    drawnAt: string;
    source: string;
    files: { svg?: string; drawio?: string; html?: string; graph?: string };
  };
  lastAttempt?: { at: string; commit: string; status: CloudDrawStatus; detail?: string; missing?: CloudTool[] };
  /** The drawing's SVG as a data URL */
  svg?: string;
}

export interface CloudDesigned {
  taskId: string;
  taskTitle: string;
  /** The architect's TerraVision SVG as a data URL */
  svg?: string;
  hasDrawio: boolean;
  /** mtime of the SVG, ms */
  at: number;
}

export interface CloudDecision {
  taskId: string;
  taskTitle: string;
  fileName: string;
  title: string;
  status?: string;
  /** mtime of the ADR, ms */
  at: number;
  /** The ADR as written, to read it in place */
  markdown: string;
}

export interface CloudArchitectureView {
  /** Settings → Agents → Cloud architecture diagrams */
  enabled: boolean;
  tools: CloudToolsState;
  fromCode?: CloudFromCode;
  /** The latest architect's design (a task's TerraVision diagram) */
  designed?: CloudDesigned;
  /** ADRs of merged tasks, newest first */
  decisions: CloudDecision[];
}

export type CloudArchitectureFile = 'svg' | 'drawio' | 'html' | 'folder' | 'designed-drawio' | 'designed-svg';

export interface CloudArchitectureAPI {
  get: (projectId: string) => Promise<IPCResult<CloudArchitectureView>>;
  open: (projectId: string, file: CloudArchitectureFile) => Promise<IPCResult>;
  tools: () => Promise<IPCResult<CloudToolsState>>;
  /** After a merge redrew (or tried to redraw) a project's cloud architecture */
  onUpdated: (callback: (projectId: string) => void) => () => void;
}
