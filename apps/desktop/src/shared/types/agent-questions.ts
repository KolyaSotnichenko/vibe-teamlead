/**
 * Questions agents ask the user (Claude Code AskUserQuestion), shared by the
 * main process, preload and renderer.
 */

export interface AgentQuestionOption {
  label: string;
  description: string;
  preview?: string;
}

export interface AgentQuestion {
  /** Full question text (also the key for its answer) */
  question: string;
  /** Short chip label, max ~12 chars */
  header: string;
  options: AgentQuestionOption[];
  multiSelect: boolean;
}

/** Answers keyed by question text; multi-select = comma-separated labels; free text allowed. */
export type AgentAnswers = Record<string, string>;

/** A set of questions waiting for the user. */
export interface PendingAgentQuestion {
  questionId: string;
  taskId: string;
  projectId?: string;
  /** Which agent is asking (spec_gatherer, coder, ...) */
  agentType: string;
  questions: AgentQuestion[];
  /** Epoch ms */
  askedAt: number;
}

export interface AgentQuestionsAPI {
  /** Questions currently waiting for an answer */
  getPending: () => Promise<PendingAgentQuestion[]>;
  /** Answer (or dismiss with null — the agent then proceeds on a stated assumption) */
  answer: (questionId: string, answers: AgentAnswers | null) => Promise<{ success: boolean; error?: string }>;
  onAsked: (callback: (question: PendingAgentQuestion) => void) => () => void;
  onResolved: (callback: (questionId: string, taskId: string) => void) => () => void;
}
