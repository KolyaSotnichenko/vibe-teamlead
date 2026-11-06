/**
 * Installs a downloaded update without being asked: a countdown the user can
 * stop, then a restart. A restart stops the agents, so it waits until none run.
 * What is put off installs when the user quits the app. No Electron imports.
 */

import type { AppUpdateAutoInstallState } from '../../shared/types';

export type AutoInstallState = AppUpdateAutoInstallState;

const COUNTDOWN_SECONDS = 10;
const POLL_MS = 15_000;

interface AutoInstallOptions {
  running: () => string[];
  /** False when the app can't install from where it runs */
  install: () => boolean;
  onState: (state: AutoInstallState) => void;
}

export function createAutoInstall({ running, install, onState }: AutoInstallOptions) {
  let timer: ReturnType<typeof setInterval> | undefined;
  let active: string | null = null;
  let putOff: string | null = null;

  const stop = () => {
    if (timer) clearInterval(timer);
    timer = undefined;
  };

  const giveUp = () => {
    stop();
    putOff = active;
    active = null;
    onState({ kind: 'idle' });
  };

  const tryInstall = () => {
    stop();
    try {
      if (install()) return;
    } catch (error) {
      console.error('[auto-install] Install failed:', error);
    }
    giveUp();
  };

  const countdown = () => {
    stop();
    let seconds = COUNTDOWN_SECONDS;
    onState({ kind: 'countdown', seconds });
    timer = setInterval(() => {
      if (running().length > 0) {
        wait();
        return;
      }
      seconds -= 1;
      if (seconds > 0) onState({ kind: 'countdown', seconds });
      else tryInstall();
    }, 1000);
  };

  const wait = () => {
    stop();
    let tasks = running().length;
    onState({ kind: 'waiting', tasks });
    timer = setInterval(() => {
      const now = running().length;
      if (now === 0) {
        countdown();
      } else if (now !== tasks) {
        tasks = now;
        onState({ kind: 'waiting', tasks });
      }
    }, POLL_MS);
  };

  return {
    downloaded(version: string) {
      if (version === active || version === putOff) return;
      active = version;
      if (running().length > 0) wait();
      else countdown();
    },
    postpone() {
      if (active) giveUp();
    },
    cancel() {
      stop();
      active = null;
    },
  };
}
