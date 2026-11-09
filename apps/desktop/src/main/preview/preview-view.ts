/**
 * The view the preview's page is shown in: a WebContentsView of its own over a
 * box the renderer reserves. The page is code agents wrote, so it gets a
 * sandbox, no Node, a session of its own per project, no permissions, and no
 * way off its local origin: links elsewhere open in the default browser.
 * A sign-in made while clicking through doesn't outlive the preview: stopping it, or
 * "Reset session", clears the page's cookies and storage.
 */

import { join } from 'node:path';
import { app, type BrowserWindow, shell, WebContentsView } from 'electron';

import type { PreviewBounds, PreviewNavigation, PreviewOverlayEvent } from '../../shared/types/preview';
import { cleanPick, relativeSourceFile } from '../../preview-overlay/protocol';
import { isAllowedPreviewUrl } from './allowed-url';

/** Around a picked element in its screenshot, in CSS pixels */
const SHOT_MARGIN = 16;
/** Longest side of a note's screenshot */
const SHOT_MAX = 800;

const routeOf = (url: string): string => {
  try {
    const parsed = new URL(url);
    return `${parsed.pathname}${parsed.search}`;
  } catch {
    return '/';
  }
};

const opensOutside = (url: string) => /^https?:\/\//i.test(url);

/** Cookies, local and session storage, IndexedDB, service workers, cache storage: the user's session in the page */
const clearSession = (session: Electron.Session): Promise<void> => session.clearStorageData().catch(() => {});

export class PreviewView {
  private view: WebContentsView | null = null;
  private origins: string[] = [];
  private bounds: PreviewBounds | null = null;
  private worktree = '';
  private notesOn = false;
  /** The last pins sent, for a page that loads anew */
  private pins: Array<{ n: number; selector: string }> = [];
  private listeners = new Set<(event: PreviewOverlayEvent) => void>();

  constructor(
    private readonly getWindow: () => BrowserWindow | null,
    private readonly makeView: (partition: string) => WebContentsView = (partition) =>
      new WebContentsView({
        webPreferences: {
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
          partition,
          spellcheck: false,
          // Runs the notes overlay in the page and relays its messages (scripts/build-preview-assets.mjs)
          preload: join(app.getAppPath(), 'out', 'preview', 'view-preload.js'),
        },
      }),
  ) {}

  /** Show `url` for this project, creating the view the first time. */
  show(projectId: string, url: string, origins: string[]): void {
    const window = this.getWindow();
    if (!window || window.isDestroyed()) return;
    this.origins = origins;
    if (!this.view) {
      const view = this.makeView(`persist:preview-${projectId}`);
      const contents = view.webContents;
      contents.session.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
      const guard = (event: { preventDefault(): void }, target: string, openOutside: boolean) => {
        if (isAllowedPreviewUrl(target, this.origins)) return;
        event.preventDefault();
        if (openOutside && opensOutside(target)) void shell.openExternal(target);
      };
      contents.on('will-navigate', (event, target) => guard(event, target, true));
      const route = (_event: unknown, url: string) => this.emit({ type: 'route', route: routeOf(url) });
      contents.on('did-navigate', route);
      contents.on('did-navigate-in-page', route);
      // A full load starts a new overlay: tell it the mode again (the pins follow the route)
      contents.on('dom-ready', () => {
        if (this.notesOn) this.command({ type: 'mode', on: true });
        if (this.pins.length) this.command({ type: 'pins', pins: this.pins });
      });
      contents.on('will-redirect', (event, target) => guard(event, target, false));
      contents.setWindowOpenHandler(({ url: target }) => {
        if (opensOutside(target)) void shell.openExternal(target);
        return { action: 'deny' };
      });
      window.contentView.addChildView(view);
      this.view = view;
    }
    this.view.setVisible(this.bounds !== null);
    if (this.bounds) this.view.setBounds(this.bounds);
    void this.view.webContents.loadURL(url);
  }

  /** Off the screen while the preview isn't ready, e.g. reinstalling after a merge */
  hide(): void {
    this.view?.setVisible(false);
  }

  /** null hides it (the box left the screen) */
  setBounds(bounds: PreviewBounds | null): void {
    this.bounds = bounds;
    if (!this.view) return;
    if (bounds) {
      this.view.setVisible(true);
      this.view.setBounds(bounds);
    } else {
      this.view.setVisible(false);
    }
  }

  navigate(navigation: PreviewNavigation): void {
    const contents = this.view?.webContents;
    if (!contents) return;
    if ('url' in navigation) {
      // A bare path opens on the page's own address; the origin check below still decides
      const typed = navigation.url.trim();
      let target = typed;
      if (typed.startsWith('/') && !typed.startsWith('//') && this.origins[0]) {
        try {
          target = new URL(typed, this.origins[0]).toString();
        } catch {
          return;
        }
      }
      if (isAllowedPreviewUrl(target, this.origins)) void contents.loadURL(target);
    } else if (navigation.action === 'reload') {
      contents.reload();
    } else if (navigation.action === 'signOut') {
      void clearSession(contents.session).then(() => {
        if (!contents.isDestroyed()) contents.reload();
      });
    } else if (navigation.action === 'back') {
      if (contents.navigationHistory.canGoBack()) contents.navigationHistory.goBack();
    } else if (contents.navigationHistory.canGoForward()) {
      contents.navigationHistory.goForward();
    }
  }

  /** The previewed worktree, to make the page's source paths relative to it */
  setWorktree(worktree: string): void {
    this.worktree = worktree;
  }

  onOverlayEvent(listener: (event: PreviewOverlayEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(event: PreviewOverlayEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  private command(command: Record<string, unknown>): void {
    const contents = this.view?.webContents;
    if (contents && !contents.isDestroyed()) contents.send('preview:overlay-command', command);
  }

  setNotesMode(on: boolean): void {
    this.notesOn = on;
    this.command({ type: 'mode', on });
    // The panel may open on a page that loaded before it: say which page it is, for its pins
    const contents = this.view?.webContents;
    if (on && contents && !contents.isDestroyed()) this.emit({ type: 'route', route: routeOf(contents.getURL()) });
  }

  setPins(pins: Array<{ n: number; selector: string }>): void {
    this.pins = pins;
    this.command({ type: 'pins', pins });
  }

  focusPin(n: number): void {
    this.command({ type: 'focus', n });
  }

  /** Whether a message comes from the previewed page itself */
  isOwnPage(webContentsId: number): boolean {
    return !!this.view && !this.view.webContents.isDestroyed() && this.view.webContents.id === webContentsId;
  }

  /** A message from the page's overlay, relayed by its preload: data from code agents wrote. */
  async handleOverlayMessage(webContentsId: number, raw: unknown): Promise<void> {
    if (!this.isOwnPage(webContentsId) || !raw || typeof raw !== 'object') return;
    const message = raw as Record<string, unknown>;
    if (message.type === 'escape') return this.emit({ type: 'escape' });
    if (message.type === 'detached') {
      const ns = (Array.isArray(message.ns) ? message.ns : []).filter((n): n is number => typeof n === 'number').slice(0, 200);
      return this.emit({ type: 'detached', ns });
    }
    if (message.type !== 'picked' || !this.notesOn) return;
    const pick = cleanPick(message.pick);
    const contents = this.view?.webContents;
    if (!pick || !contents) return;
    pick.frames = pick.frames.flatMap((frame) => {
      const file = relativeSourceFile(frame.file, this.worktree);
      return file ? [{ ...frame, file }] : [];
    });
    this.emit({ type: 'picked', route: routeOf(contents.getURL()), width: this.bounds?.width ?? 0, pick, image: await this.shot(pick.rect) });
  }

  /** The picked area with a margin, at most SHOT_MAX on its longest side */
  private async shot(rect: { x: number; y: number; width: number; height: number }): Promise<string | undefined> {
    const contents = this.view?.webContents;
    if (!contents) return undefined;
    const x = Math.max(0, Math.floor(rect.x - SHOT_MARGIN));
    const y = Math.max(0, Math.floor(rect.y - SHOT_MARGIN));
    const right = Math.ceil(rect.x + rect.width + SHOT_MARGIN);
    const bottom = Math.ceil(rect.y + rect.height + SHOT_MARGIN);
    const maxW = this.bounds?.width ?? right;
    const maxH = this.bounds?.height ?? bottom;
    const area = { x, y, width: Math.max(1, Math.min(right, maxW) - x), height: Math.max(1, Math.min(bottom, maxH) - y) };
    try {
      const image = await contents.capturePage(area);
      const { width, height } = image.getSize();
      const longest = Math.max(width, height);
      const sized = longest > SHOT_MAX ? image.resize(width >= height ? { width: SHOT_MAX } : { height: SHOT_MAX }) : image;
      return sized.toDataURL();
    } catch {
      return undefined;
    }
  }

  destroy(): void {
    this.notesOn = false;
    this.pins = [];
    const view = this.view;
    this.view = null;
    this.origins = [];
    if (!view) return;
    const window = this.getWindow();
    if (window && !window.isDestroyed()) window.contentView.removeChildView(view);
    if (!view.webContents.isDestroyed()) {
      void clearSession(view.webContents.session);
      view.webContents.close();
    }
  }
}
