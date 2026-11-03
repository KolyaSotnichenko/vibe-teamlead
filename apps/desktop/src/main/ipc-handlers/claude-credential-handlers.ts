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
  ClaudeModelList,
} from '../../shared/types/claude-credential';
import type { IPCResult } from '../../shared/types';
import { toClaudeAuth } from '../ai/claude-code/auth';
import {
  clearClaudeKey,
  getClaudeCredentialStatus,
  resolveClaudeCredential,
  saveClaudeKey,
} from '../ai/claude-code/credential';
import { listEndpointModels } from '../ai/claude-code/models';
import { isSubscriptionModeEnabled } from '../ai/claude-code/subscription-setting';
import { resolveModelId } from '../ai/config/phase-config';
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
  if (auth.rejectedSubscriptionToken) {
    return { ok: false, error: 'This is a Claude subscription token; turn on personal mode to use it' };
  }

  // A custom endpoint (e.g. Ollama) may not serve Claude Haiku: test with a model it lists.
  let model = 'haiku';
  if (auth.baseURL) {
    const list = await listEndpointModels({ auth, refresh: true });
    if (list.error) return { ok: false, error: list.error };
    const haiku = resolveModelId('haiku');
    if (list.models.length && !list.models.some((m) => m.id === haiku)) model = list.models[0].id;
  }

  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), TEST_TIMEOUT_MS);
  try {
    await runClaudeTask({
      systemPrompt: 'You are a connection check. Reply with the single word OK.',
      prompt: 'OK?',
      model,
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
    IPC_CHANNELS.CLAUDE_MODELS_LIST,
    async (_event, options?: { refresh?: boolean }): Promise<IPCResult<ClaudeModelList>> => {
      try {
        const credential = resolveClaudeCredential();
        const auth = toClaudeAuth(credential.key, credential.baseURL, isSubscriptionModeEnabled());
        return { success: true, data: await listEndpointModels({ auth, refresh: options?.refresh }) };
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
