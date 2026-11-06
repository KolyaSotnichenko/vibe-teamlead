/**
 * @vitest-environment jsdom
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { act, fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AppUpdateNotification } from '../AppUpdateNotification';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown> | string) =>
      typeof options === 'object' && options?.count !== undefined ? `${key}:${options.count}` : key,
  }),
}));

type Listener = (payload: never) => void;
const listeners: Record<string, Listener> = {};
const on = (name: string) => (callback: Listener) => {
  listeners[name] = callback;
  return () => undefined;
};
const emit = (name: string, payload: unknown) => act(() => listeners[name](payload as never));

const install = vi.fn();
const postpone = vi.fn();
const download = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  Object.assign(window, {
    electronAPI: {
      onAppUpdateAvailable: on('available'),
      onAppUpdateDownloaded: on('downloaded'),
      onAppUpdateProgress: on('progress'),
      onAppUpdateError: on('error'),
      onAppUpdateReadOnlyVolume: on('readOnly'),
      onAppUpdateAutoInstall: on('autoInstall'),
      installAppUpdate: install,
      postponeAppUpdate: postpone,
      downloadAppUpdate: download,
      openExternal: vi.fn(),
    },
  });
  render(<AppUpdateNotification />);
});

const available = () => emit('available', { version: '2.0.0' });

describe('app update dialog', () => {
  it('shows the download already running: the app starts it by itself', () => {
    available();
    expect(screen.queryByRole('button', { name: /dialogs:appUpdate.downloadUpdate/ })).not.toBeInTheDocument();
    expect(download).not.toHaveBeenCalled();
  });

  it('can be hidden during the download, so it never blocks work', () => {
    available();
    fireEvent.click(screen.getByRole('button', { name: /dialogs:appUpdate.hide/ }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(postpone).not.toHaveBeenCalled();
  });

  it("doesn't come back when a repeated check finds the same version", () => {
    available();
    fireEvent.click(screen.getByRole('button', { name: /dialogs:appUpdate.hide/ }));
    available();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('comes back for the countdown, even if it was hidden', () => {
    available();
    fireEvent.click(screen.getByRole('button', { name: /dialogs:appUpdate.hide/ }));
    emit('downloaded', { version: '2.0.0' });
    emit('autoInstall', { kind: 'countdown', seconds: 7 });
    expect(screen.getByText('dialogs:appUpdate.restartingIn:7')).toBeInTheDocument();
  });

  it('opens for a countdown on an update it never announced, such as going back to stable', () => {
    emit('downloaded', { version: '1.9.0' });
    emit('autoInstall', { kind: 'countdown', seconds: 10 });
    expect(screen.getByText('1.9.0')).toBeInTheDocument();
  });

  it('puts the restart off with Later', () => {
    available();
    emit('downloaded', { version: '2.0.0' });
    emit('autoInstall', { kind: 'countdown', seconds: 7 });
    fireEvent.click(screen.getByRole('button', { name: /dialogs:appUpdate.installLater/ }));
    expect(postpone).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('puts the restart off when the dialog is closed: closing must not lead to a restart', () => {
    available();
    emit('downloaded', { version: '2.0.0' });
    emit('autoInstall', { kind: 'countdown', seconds: 7 });
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(postpone).toHaveBeenCalledTimes(1);
  });

  it('restarts at once on request', () => {
    available();
    emit('downloaded', { version: '2.0.0' });
    emit('autoInstall', { kind: 'countdown', seconds: 7 });
    fireEvent.click(screen.getByRole('button', { name: /dialogs:appUpdate.installAndRestart/ }));
    expect(install).toHaveBeenCalledTimes(1);
  });

  it('says it is waiting for the agents, and stays out of the way if it was hidden', () => {
    available();
    emit('downloaded', { version: '2.0.0' });
    emit('autoInstall', { kind: 'waiting', tasks: 2 });
    expect(screen.getByText('dialogs:appUpdate.waitingForTasks:2')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /dialogs:appUpdate.hide/ }));
    emit('autoInstall', { kind: 'waiting', tasks: 1 });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('opens to explain when the app cannot install from a disk image', () => {
    available();
    fireEvent.click(screen.getByRole('button', { name: /dialogs:appUpdate.hide/ }));
    emit('readOnly', { appPath: '/Volumes/x' });
    expect(screen.getByText('dialogs:appUpdate.readOnlyVolumeTitle')).toBeInTheDocument();
  });

  it('offers a retry when the download fails', () => {
    available();
    emit('error', { message: 'network down' });
    expect(screen.getByRole('button', { name: /dialogs:appUpdate.downloadUpdate/ })).toBeInTheDocument();
  });
});

describe('the rest of the app', () => {
  it("doesn't throw the user into Settings when an update has downloaded", () => {
    const app = readFileSync(resolve(__dirname, '../../App.tsx'), 'utf-8');
    expect(app).not.toMatch(/onAppUpdateDownloaded/);
  });
});
