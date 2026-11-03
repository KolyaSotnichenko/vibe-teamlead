import { ipcRenderer } from 'electron';

import { IPC_CHANNELS } from '../../shared/constants';
import type { AgentAnswers, AgentQuestionsAPI, PendingAgentQuestion } from '../../shared/types/agent-questions';

export type { AgentQuestionsAPI };

export const createAgentQuestionsAPI = (): AgentQuestionsAPI => ({
  getPending: () => ipcRenderer.invoke(IPC_CHANNELS.AGENT_QUESTION_PENDING),
  answer: (questionId: string, answers: AgentAnswers | null) =>
    ipcRenderer.invoke(IPC_CHANNELS.AGENT_QUESTION_ANSWER, questionId, answers),
  onAsked: (callback) => {
    const handler = (_event: Electron.IpcRendererEvent, question: PendingAgentQuestion) => callback(question);
    ipcRenderer.on(IPC_CHANNELS.AGENT_QUESTION_ASKED, handler);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.AGENT_QUESTION_ASKED, handler);
  },
  onResolved: (callback) => {
    const handler = (_event: Electron.IpcRendererEvent, questionId: string, taskId: string) =>
      callback(questionId, taskId);
    ipcRenderer.on(IPC_CHANNELS.AGENT_QUESTION_RESOLVED, handler);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.AGENT_QUESTION_RESOLVED, handler);
  },
});
