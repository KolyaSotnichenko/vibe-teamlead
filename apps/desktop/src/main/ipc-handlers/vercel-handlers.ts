/**
 * Vercel IPC (Settings → Vercel): status, browser sign-in with progress and
 * cancel, a pasted token, disconnect. Tokens never travel to the renderer.
 */
import { type BrowserWindow, ipcMain } from 'electron';

import { IPC_CHANNELS } from '../../shared/constants';
import type { IPCResult } from '../../shared/types';
import type { VercelStatus } from '../../shared/types/deploy';
import { connectVercel, disconnectVercel, setVercelToken, vercelStatus } from '../deploy/vercel-credential';
import { safeSendToRenderer } from './utils';

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function registerVercelHandlers(getMainWindow: () => BrowserWindow | null): void {
  let running: AbortController | null = null;

  ipcMain.handle(IPC_CHANNELS.VERCEL_STATUS, async (): Promise<IPCResult<VercelStatus>> => {
    try {
      return { success: true, data: await vercelStatus() };
    } catch (error) {
      return { success: false, error: errorMessage(error) };
    }
  });

  ipcMain.handle(IPC_CHANNELS.VERCEL_CONNECT, async (): Promise<IPCResult<VercelStatus>> => {
    if (running) return { success: false, error: 'A Vercel sign-in is already running' };
    const controller = new AbortController();
    running = controller;
    try {
      await connectVercel(
        (state) => safeSendToRenderer(getMainWindow, IPC_CHANNELS.VERCEL_CONNECT_STATE, state),
        controller.signal,
      );
      return { success: true, data: await vercelStatus() };
    } catch (error) {
      return { success: false, error: errorMessage(error) };
    } finally {
      if (running === controller) running = null;
    }
  });

  ipcMain.handle(IPC_CHANNELS.VERCEL_CANCEL_CONNECT, async (): Promise<IPCResult> => {
    running?.abort();
    return { success: true };
  });

  ipcMain.handle(IPC_CHANNELS.VERCEL_SET_TOKEN, async (_event, token: string): Promise<IPCResult<VercelStatus>> => {
    try {
      return { success: true, data: await setVercelToken(String(token ?? '')) };
    } catch (error) {
      return { success: false, error: errorMessage(error) };
    }
  });

  ipcMain.handle(IPC_CHANNELS.VERCEL_DISCONNECT, async (): Promise<IPCResult<VercelStatus>> => {
    try {
      running?.abort();
      await disconnectVercel();
      return { success: true, data: { connected: false } };
    } catch (error) {
      return { success: false, error: errorMessage(error) };
    }
  });
}
