/**
 * Brief import: a brief (a spec document, or free-form text) is analysed by
 * the brief-analyst agent into epics and tasks the user reviews before they
 * become tasks on the board.
 */

import type { IPCResult } from './common';
import type { TaskCategory, TaskComplexity, TaskPriority } from './task';

/** One proposed task. `key` is stable within a proposal and used by `dependsOn`. */
export interface BriefTaskDraft {
  key: string;
  title: string;
  /** What to build and why, in the brief's terms (markdown) */
  description: string;
  /** Key of the epic this task belongs to */
  epic?: string;
  /** Draft acceptance criteria, Given/When/Then */
  acceptanceCriteria: string[];
  /** Keys of tasks that must be finished first */
  dependsOn: string[];
  complexity: TaskComplexity;
  priority: TaskPriority;
  category: TaskCategory;
  /** Where in the brief this comes from (heading or short quote) */
  sourceSection?: string;
}

export interface BriefEpic {
  key: string;
  title: string;
  summary?: string;
}

export interface BriefProposal {
  /** Folder name under <project>/<specs root>/../briefs/ */
  briefId: string;
  title: string;
  summary: string;
  epics: BriefEpic[];
  tasks: BriefTaskDraft[];
  /** Assumptions the analyst made where the brief is silent */
  assumptions: string[];
  /** Questions for the user; the spec agents ask them again per task */
  openQuestions: string[];
  /** What the analyst asked before proposing, and the answers (empty when it asked nothing) */
  clarifications?: BriefClarification[];
}

export interface BriefClarification {
  question: string;
  /** The user's answer; undefined when they skipped it */
  answer?: string;
}

/** The analyst asks the user something (main → renderer) */
export interface BriefQuestionEvent {
  projectId: string;
  questionId: string;
  questions: import('./agent-questions').AgentQuestion[];
}

export interface BriefAnalyzeInput {
  /** Free-form text, or the brief pasted in */
  text?: string;
  /** Absolute path of a brief file (.md, .txt, .pdf, .docx, .rtf, .odt) */
  filePath?: string;
  /** Ask the user clarifying questions before proposing (Superpowers brainstorming). Default: on */
  clarify?: boolean;
}

export interface BriefCreateOptions {
  /** Put the new tasks in the queue (they start as capacity and dependencies allow) */
  queue: boolean;
}

export interface BriefCreatedTask {
  key: string;
  taskId: string;
  specId: string;
}

/** Progress lines while the analyst works (main → renderer) */
export interface BriefProgressEvent {
  projectId: string;
  message: string;
}

export interface BriefAPI {
  /** Choose a brief file in the system dialog; null when cancelled */
  pickFile: () => Promise<IPCResult<string | null>>;
  /** Absolute path of a file dropped into the renderer */
  pathForFile: (file: File) => string;
  analyze: (projectId: string, input: BriefAnalyzeInput) => Promise<IPCResult<BriefProposal>>;
  cancel: (projectId: string) => Promise<IPCResult>;
  createTasks: (
    projectId: string,
    briefId: string,
    tasks: BriefTaskDraft[],
    options: BriefCreateOptions,
  ) => Promise<IPCResult<BriefCreatedTask[]>>;
  onProgress: (callback: (event: BriefProgressEvent) => void) => () => void;
  /** The analyst's questions while it works */
  onQuestion: (callback: (event: BriefQuestionEvent) => void) => () => void;
  /**
   * Answer a question (null = skip it). `stopAsking`: answer nothing more, the
   * analyst proposes from what it has.
   */
  answer: (projectId: string, questionId: string, answers: Record<string, string> | null, stopAsking?: boolean) => Promise<IPCResult>;
}
