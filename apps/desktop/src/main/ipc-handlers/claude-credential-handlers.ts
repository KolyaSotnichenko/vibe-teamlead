/**
 * IPC for the app's Claude credential (Settings → Claude, onboarding).
 * The key goes in, a status comes out; the key itself is never sent back.
 */

import { ipcMain } from 'electron';

import { IPC_CHANNELS } from '../../shared/constants';
import type {
  ClaudeConnectionTestInput,
  ClaudeConnectionTestResult,
  ClaudeCredentialStatus,
} from '../../shared/types/claude-credential';
import type { IPCResult } from '../../shared/types';
import { toClaudeAuth } from '../ai/claude-code/auth';
import {
  clearClaudeKey,
  getClaudeCredentialStatus,
  resolveClaudeCredential,
  saveClaudeKey,
} from '../ai/claude-code/credential';
import { isSubscriptionModeEnabled } from '../ai/claude-code/subscription-setting';
import { runClaudeTask } from '../ai/claude-code/task';

const TEST_TIMEOUT_MS = 60_000;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function testConnection(input: ClaudeConnectionTestInput = {}): Promise<ClaudeConnectionTestResult> {
  const stored = resolveClaudeCredential();
  const key = input.apiKey?.trim() || stored.key;
  const baseURL = input.baseUrl !== undefined ? input.baseUrl.trim() || undefined : stored.baseURL;
  const auth = toClaudeAuth(key, baseURL, isSubscriptionModeEnabled());

  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), TEST_TIMEOUT_MS);
  try {
    await runClaudeTask({
      systemPrompt: 'You are a connection check. Reply with the single word OK.',
      prompt: 'OK?',
      model: 'haiku',
      maxTurns: 1,
      auth,
      abortSignal: abort.signal,
    });
    return { ok: true };
  } catch (error) {
    return { ok: false, error: abort.signal.aborted ? 'Timed out' : errorMessage(error) };
  } finally {
    clearTimeout(timer);
  }
}

export function registerClaudeCredentialHandlers(): void {
  ipcMain.handle(
    IPC_CHANNELS.CLAUDE_CREDENTIAL_GET_STATUS,
    async (): Promise<IPCResult<ClaudeCredentialStatus>> => {
      try {
        return { success: true, data: getClaudeCredentialStatus() };
      } catch (error) {
        return { success: false, error: errorMessage(error) };
      }
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.CLAUDE_CREDENTIAL_SAVE,
    async (_event, apiKey: string): Promise<IPCResult<ClaudeCredentialStatus>> => {
      try {
        saveClaudeKey(apiKey);
        return { success: true, data: getClaudeCredentialStatus() };
      } catch (error) {
        return { success: false, error: errorMessage(error) };
      }
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.CLAUDE_CREDENTIAL_CLEAR,
    async (): Promise<IPCResult<ClaudeCredentialStatus>> => {
      try {
        clearClaudeKey();
        return { success: true, data: getClaudeCredentialStatus() };
      } catch (error) {
        return { success: false, error: errorMessage(error) };
      }
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.CLAUDE_CREDENTIAL_TEST,
    async (_event, input?: ClaudeConnectionTestInput): Promise<IPCResult<ClaudeConnectionTestResult>> => {
      return { success: true, data: await testConnection(input) };
    },
  );
}
