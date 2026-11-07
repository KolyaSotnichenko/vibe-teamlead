/**
 * The view the preview's page is shown in: a WebContentsView of its own over a
 * box the renderer reserves. The page is code agents wrote, so it gets a
 * sandbox, no Node, a session of its own per project, no permissions, and no
 * way off its local origin: links elsewhere open in the default browser.
 */

import { type BrowserWindow, shell, WebContentsView } from 'electron';

import type { PreviewBounds, PreviewNavigation } from '../../shared/types/preview';
import { isAllowedPreviewUrl } from './allowed-url';

const opensOutside = (url: string) => /^https?:\/\//i.test(url);

export class PreviewView {
  private view: WebContentsView | null = null;
  private origins: string[] = [];
  private bounds: PreviewBounds | null = null;

  constructor(
    private readonly getWindow: () => BrowserWindow | null,
    private readonly makeView: (partition: string) => WebContentsView = (partition) =>
      new WebContentsView({ webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, partition, spellcheck: false } }),
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
      contents.on('will-redirect', (event, target) => guard(event, target, false));
      contents.setWindowOpenHandler(({ url: target }) => {
        if (opensOutside(target)) void shell.openExternal(target);
        return { action: 'deny' };
      });
      window.contentView.addChildView(view);
      this.view = view;
    }
    if (this.bounds) this.view.setBounds(this.bounds);
    void this.view.webContents.loadURL(url);
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
      if (isAllowedPreviewUrl(navigation.url, this.origins)) void contents.loadURL(navigation.url);
    } else if (navigation.action === 'reload') {
      contents.reload();
    } else if (navigation.action === 'back') {
      if (contents.navigationHistory.canGoBack()) contents.navigationHistory.goBack();
    } else if (contents.navigationHistory.canGoForward()) {
      contents.navigationHistory.goForward();
    }
  }

  destroy(): void {
    const view = this.view;
    this.view = null;
    this.origins = [];
    if (!view) return;
    const window = this.getWindow();
    if (window && !window.isDestroyed()) window.contentView.removeChildView(view);
    if (!view.webContents.isDestroyed()) view.webContents.close();
  }
}
