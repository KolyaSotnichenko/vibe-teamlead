import { create } from 'zustand';

import type { AgentAnswers, PendingAgentQuestion } from '../../shared/types/agent-questions';

interface AgentQuestionsState {
  pending: PendingAgentQuestion[];
  /** Question shown in the panel (null = panel closed) */
  openQuestionId: string | null;
  setPending: (pending: PendingAgentQuestion[]) => void;
  add: (question: PendingAgentQuestion) => void;
  remove: (questionId: string) => void;
  open: (questionId: string | null) => void;
  answer: (questionId: string, answers: AgentAnswers | null) => Promise<{ success: boolean; error?: string }>;
}

export const useAgentQuestionsStore = create<AgentQuestionsState>((set, get) => ({
  pending: [],
  openQuestionId: null,
  setPending: (pending) =>
    set((state) => ({
      pending,
      openQuestionId: state.openQuestionId ?? pending[0]?.questionId ?? null,
    })),
  add: (question) =>
    set((state) =>
      state.pending.some((q) => q.questionId === question.questionId)
        ? state
        : {
            pending: [...state.pending, question],
            // Bring the first waiting question up automatically; never steal focus from an open one.
            openQuestionId: state.openQuestionId ?? question.questionId,
          },
    ),
  remove: (questionId) =>
    set((state) => {
      const pending = state.pending.filter((q) => q.questionId !== questionId);
      return {
        pending,
        openQuestionId: state.openQuestionId === questionId ? (pending[0]?.questionId ?? null) : state.openQuestionId,
      };
    }),
  open: (questionId) => set({ openQuestionId: questionId }),
  answer: async (questionId, answers) => {
    const result = await window.electronAPI.agentQuestions.answer(questionId, answers);
    // Resolved either way (answered now, or no longer waiting).
    get().remove(questionId);
    return result;
  },
}));

/** Pending question for a task, if its agent is waiting. */
export function selectTaskQuestion(taskId: string) {
  return (state: AgentQuestionsState) => state.pending.find((q) => q.taskId === taskId);
}

/** Subscribe the store to main-process events. Returns the cleanup. */
export function initAgentQuestions(): () => void {
  const api = window.electronAPI?.agentQuestions;
  if (!api) return () => undefined;
  const store = useAgentQuestionsStore.getState();
  void api.getPending().then(store.setPending).catch(() => undefined);
  const offAsked = api.onAsked((q) => useAgentQuestionsStore.getState().add(q));
  const offResolved = api.onResolved((id) => useAgentQuestionsStore.getState().remove(id));
  return () => {
    offAsked();
    offResolved();
  };
}
