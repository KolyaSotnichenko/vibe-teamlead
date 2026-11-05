/**
 * Task workspace types
 *
 * A parsed view of the artifacts the agents write into a task's spec directory
 * (spec.md, implementation_plan.json, qa_report.md, task_logs.json, architecture/).
 * Everything here comes from files on disk; nothing is predicted or estimated.
 */

import type { TaskLogPhase, TaskLogPhaseStatus } from './task';

/** How an acceptance criterion is meant to be proved (from "— Test: <level>" in spec.md) */
export type AcTestLevel = 'unit' | 'integration' | 'e2e' | 'manual';

/** Coverage status merged from qa_report.md */
export type AcStatus = 'pass' | 'fail' | 'untested';

/** One row of the QA report's AC coverage table */
export interface AcTestResult {
  /** Test reference as written, e.g. "tests/test_x.py::test_y" */
  test: string;
  /** "Asserts the criterion?" column, as written (e.g. "yes", "no") */
  asserts: string;
  /** Result column, normalized */
  result: 'pass' | 'fail' | 'unknown';
}

export interface WorkspaceAcceptanceCriterion {
  /** e.g. "AC-1" */
  id: string;
  /** Given/When/Then text without the ID marker and the test-level suffix */
  text: string;
  testLevel: AcTestLevel | null;
  status: AcStatus;
  tests: AcTestResult[];
  /** IDs of plan subtasks whose description starts with this AC in its [AC-..] prefix */
  coveredBy: string[];
}

export type WorkspaceSubtaskStatus = 'pending' | 'in_progress' | 'completed' | 'blocked' | 'failed';

export interface WorkspacePlanSubtask {
  id: string;
  title: string;
  description: string;
  status: WorkspaceSubtaskStatus;
  phaseId: string;
  /** AC IDs listed in the description's leading [AC-..] prefix */
  acIds: string[];
  /** Explicit subtask dependencies (subtask IDs), when the plan declares them */
  dependsOn: string[];
  files: string[];
  verification?: { type: string; run?: string };
}

export interface WorkspacePlanPhase {
  id: string;
  name: string;
  type?: string;
  /** Phase IDs this phase depends on */
  dependsOn: string[];
  subtasks: WorkspacePlanSubtask[];
}

export interface WorkspacePlan {
  feature?: string;
  phases: WorkspacePlanPhase[];
}

export type WorkspaceTimelineKind = 'phase' | 'session' | 'subtask';

/** A span of real activity reconstructed from task_logs.json timestamps */
export interface WorkspaceTimelineItem {
  id: string;
  kind: WorkspaceTimelineKind;
  phase: TaskLogPhase;
  /** ISO timestamp of the first recorded activity */
  startedAt: string;
  /** ISO timestamp of the last recorded activity; null while still running */
  endedAt: string | null;
  status: TaskLogPhaseStatus;
  /** Session number for kind === 'session' */
  session?: number;
  /** Subtask ID for kind === 'subtask' */
  subtaskId?: string;
  /** Number of log entries in the span */
  entryCount: number;
}

export interface WorkspaceAdr {
  /** File name inside architecture/adr/ */
  fileName: string;
  title: string;
  /** MADR status (proposed, accepted, superseded, ...) when stated */
  status?: string;
  markdown: string;
}

export interface WorkspaceDiagram {
  /** Base file name without extension */
  name: string;
  kind: 'drawio' | 'mermaid';
  /** Path relative to the spec directory, for "Open in draw.io" */
  drawioPath?: string;
  /** Rendered PNG next to the .drawio file, relative to the spec directory (fetch with getTaskWorkspaceImage) */
  pngPath?: string;
  /** Changes when the PNG is re-rendered (mtime); cache key for the fetched image */
  pngVersion?: number;
  /** Mermaid source of a .mmd file */
  mermaidSource?: string;
}

export interface WorkspaceArchitecture {
  markdown?: string;
  adrs: WorkspaceAdr[];
  diagrams: WorkspaceDiagram[];
}

export interface WorkspaceSecurityFinding {
  source: 'gitleaks' | 'osv-scanner' | 'semgrep' | 'strix';
  title: string;
  /** Strix severity; gate findings are always blocking */
  severity?: string;
  location?: string;
  detail?: string;
  blocking: boolean;
}

export interface WorkspaceSecurity {
  /** gitleaks + OSV-Scanner + Semgrep (when installed), from security_gates.json (runs before every QA review) */
  gates?: {
    ran: string[];
    skipped: { gate: string; reason: string }[];
    findings: WorkspaceSecurityFinding[];
  };
  /** Strix penetration test, from security_qa.json (after QA approval) */
  pentest?: {
    status: 'clear' | 'findings' | 'skipped' | 'error' | 'cancelled';
    reason?: string;
    scanMode?: string;
    failOn?: string;
    costUsd?: number;
    findings: WorkspaceSecurityFinding[];
    /** Strix report path relative to the spec directory */
    reportPath?: string;
  };
}

export interface TurnLimitHit {
  agentType: string;
  subtaskId?: string;
  limit: number;
  count: number;
}

export interface TaskWorkspace {
  /** Absolute spec directory the artifacts were read from */
  specDir: string;
  spec?: {
    markdown: string;
    criteria: WorkspaceAcceptanceCriterion[];
  };
  /** True when qa_report.md exists and contains an AC coverage table */
  hasQaCoverage: boolean;
  plan?: WorkspacePlan;
  timeline: WorkspaceTimelineItem[];
  architecture: WorkspaceArchitecture;
  security: WorkspaceSecurity;
  /** Why the last QA run ended without approval (qa_outcome.json) */
  qaOutcome?: QaOutcomeInfo;
  /** Sessions of this run that stopped at their turn limit */
  turnLimits?: TurnLimitHit[];
  /** A merge the model resolved, waiting for the user's decision */
  mergeReview?: { files: string[] };
}

/** What blocked QA, in the words the task window shows */
export interface QaOutcomeInfo {
  approved: boolean;
  /** max_iterations | recurring_issues | consecutive_errors | error | cancelled */
  reason?: string;
  iterations: number;
  /** The reviewer itself approved; only the automatic checks blocked it */
  reviewerApproved: boolean;
  /** The checks keep finding the same thing after the fixer's round; the review is waiting for them */
  checksRepeat?: boolean;
  blocking: Array<{
    source: 'security' | 'design' | 'qa';
    title: string;
    location?: string;
    /** For design findings: the exact text the check matched */
    match?: string;
  }>;
  error?: string;
  /** Project files the QA reviewer changed although it must not; left as they are for the user to review */
  reviewerChangedFiles?: string[];
  /** A worktree snapshot failed, so whether the reviewer changed project files is unknown */
  reviewerChangesUnknown?: boolean;
  /** The QA reviewer made a commit: HEAD before its first session and after its last; left as is */
  reviewerCommitted?: { from: string; to: string };
  at: string;
}
