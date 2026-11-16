/**
 * One running app per user: a second launch (a double-click on the shortcut, a
 * second start from the Start menu) hands over to the running app, which brings
 * its window to the front, and then exits. Two instances would share the same
 * settings, database and worktrees. Also the application menu policy: a packaged
 * Windows build shows no default File/Edit/View menu bar.
 */

export interface InstanceApp {
  requestSingleInstanceLock(): boolean;
  on(event: 'second-instance', listener: () => void): unknown;
  exit(code?: number): void;
}

/** False (after exiting) when another instance holds the lock. */
export function claimSingleInstance(app: InstanceApp, focus: () => void): boolean {
  if (!app.requestSingleInstanceLock()) {
    app.exit(0);
    return false;
  }
  app.on('second-instance', focus);
  return true;
}

export interface FocusableWindow {
  isDestroyed(): boolean;
  isMinimized(): boolean;
  restore(): void;
  show(): void;
  focus(): void;
}

/** Bring the window to the front, restoring it when minimized. */
export function focusWindow(win: FocusableWindow | null | undefined): void {
  if (!win || win.isDestroyed()) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

/** Windows shows Electron's default menu bar under the title bar: none in a packaged build. */
export function removesAppMenu(platform: 'darwin' | 'win32' | 'linux', dev: boolean): boolean {
  return platform === 'win32' && !dev;
}
