import { assign, createMachine } from 'xstate';

/**
 * Terminal lifecycle state machine context.
 *
 * Tracks Claude Code session state and error information
 * for a single terminal instance.
 */
export interface TerminalContext {
  claudeSessionId?: string;
  isBusy: boolean;
  error?: string;
}

/**
 * Discriminated union of all terminal lifecycle events.
 */
export type TerminalEvent =
  | { type: 'SHELL_READY' }
  | { type: 'CLAUDE_START' }
  | { type: 'CLAUDE_ACTIVE'; claudeSessionId?: string }
  | { type: 'CLAUDE_BUSY'; isBusy: boolean }
  | { type: 'CLAUDE_EXITED'; exitCode?: number; error?: string }
  | { type: 'RESUME_REQUESTED'; claudeSessionId: string }
  | { type: 'RESUME_COMPLETE'; claudeSessionId?: string }
  | { type: 'RESUME_FAILED'; error: string }
  | { type: 'SHELL_EXITED'; exitCode?: number; signal?: string }
  | { type: 'RESET' };

export const terminalMachine = createMachine(
  {
    id: 'terminal',
    initial: 'idle',
    types: {} as {
      context: TerminalContext;
      events: TerminalEvent;
    },
    context: {
      claudeSessionId: undefined,
      isBusy: false,
      error: undefined,
    },
    states: {
      idle: {
        on: {
          SHELL_READY: 'shell_ready',
          RESET: { target: 'idle', actions: 'resetContext' },
        },
      },
      shell_ready: {
        on: {
          CLAUDE_START: { target: 'claude_starting', actions: 'clearError' },
          CLAUDE_ACTIVE: { target: 'claude_active', actions: 'setClaudeSessionId' },
          RESUME_REQUESTED: { target: 'pending_resume', actions: 'setClaudeSessionId' },
          SHELL_EXITED: { target: 'exited', actions: 'clearSession' },
          RESET: { target: 'idle', actions: 'resetContext' },
        },
      },
      claude_starting: {
        on: {
          CLAUDE_ACTIVE: { target: 'claude_active', actions: 'setClaudeSessionId' },
          CLAUDE_BUSY: { actions: 'setBusy' },
          CLAUDE_EXITED: { target: 'shell_ready', actions: ['setError', 'clearSession'] },
          SHELL_EXITED: { target: 'exited', actions: 'clearSession' },
          RESET: { target: 'idle', actions: 'resetContext' },
        },
      },
      claude_active: {
        on: {
          CLAUDE_ACTIVE: { actions: 'updateClaudeSessionId' },
          CLAUDE_BUSY: { actions: 'setBusy' },
          CLAUDE_EXITED: { target: 'shell_ready', actions: ['setError', 'clearSession'] },
          RESUME_REQUESTED: { target: 'pending_resume', actions: 'setClaudeSessionId' },
          SHELL_EXITED: { target: 'exited', actions: 'clearSession' },
          RESET: { target: 'idle', actions: 'resetContext' },
        },
      },
      pending_resume: {
        on: {
          CLAUDE_ACTIVE: { target: 'claude_active', actions: 'setClaudeSessionId' },
          CLAUDE_BUSY: { actions: 'setBusy' },
          RESUME_COMPLETE: { target: 'claude_active', actions: 'setClaudeSessionId' },
          RESUME_FAILED: { target: 'shell_ready', actions: ['setError', 'clearSession'] },
          SHELL_EXITED: { target: 'exited', actions: 'clearSession' },
          RESET: { target: 'idle', actions: 'resetContext' },
        },
      },
      exited: {
        on: {
          SHELL_READY: { target: 'shell_ready', actions: 'clearError' },
          RESET: { target: 'idle', actions: 'resetContext' },
        },
      },
    },
  },
  {
    actions: {
      setClaudeSessionId: assign({
        claudeSessionId: ({ event }) => {
          if (event.type === 'CLAUDE_ACTIVE') return event.claudeSessionId;
          if (event.type === 'RESUME_COMPLETE') return event.claudeSessionId;
          if (event.type === 'RESUME_REQUESTED') return event.claudeSessionId;
          return undefined;
        },
        // Clear isBusy when entering claude_active from another state
        isBusy: () => false,
        error: () => undefined,
      }),
      // Self-transition action for CLAUDE_ACTIVE within claude_active state:
      // Updates sessionId but preserves isBusy (avoids resetting busy indicator
      // when the session ID is refreshed without a state change)
      updateClaudeSessionId: assign({
        claudeSessionId: ({ event }) =>
          event.type === 'CLAUDE_ACTIVE' ? event.claudeSessionId : undefined,
        error: () => undefined,
      }),
      setBusy: assign({
        isBusy: ({ event }) =>
          event.type === 'CLAUDE_BUSY' ? event.isBusy : false,
      }),
      setError: assign({
        error: ({ event }) => {
          if (event.type === 'CLAUDE_EXITED') return event.error;
          if (event.type === 'RESUME_FAILED') return event.error;
          return undefined;
        },
      }),
      clearError: assign({ error: () => undefined }),
      clearSession: assign({
        claudeSessionId: () => undefined,
        isBusy: () => false,
      }),
      resetContext: assign({
        claudeSessionId: () => undefined,
        isBusy: () => false,
        error: () => undefined,
      }),
    },
  }
);
