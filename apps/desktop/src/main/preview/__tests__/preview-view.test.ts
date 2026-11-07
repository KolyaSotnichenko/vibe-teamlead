import { beforeEach, describe, expect, it, vi } from 'vitest';

import { shell } from 'electron';

import { PreviewView } from '../preview-view';

type Handler = (...args: unknown[]) => unknown;

function fakeView() {
  const handlers: Record<string, Handler> = {};
  let openHandler: Handler | undefined;
  let permissionHandler: Handler | undefined;
  const contents = {
    on: vi.fn((event: string, handler: Handler) => { handlers[event] = handler; }),
    setWindowOpenHandler: vi.fn((handler: Handler) => { openHandler = handler; }),
    session: { setPermissionRequestHandler: vi.fn((handler: Handler) => { permissionHandler = handler; }), setPermissionCheckHandler: vi.fn() },
    loadURL: vi.fn(async () => {}),
    reload: vi.fn(),
    navigationHistory: { canGoBack: () => true, goBack: vi.fn(), canGoForward: () => false, goForward: vi.fn() },
    isDestroyed: () => false,
    close: vi.fn(),
  };
  const view = { webContents: contents, setBounds: vi.fn(), setVisible: vi.fn() };
  return { view, contents, handlers, open: (url: string) => openHandler?.({ url }), permission: () => { const cb = vi.fn(); permissionHandler?.({}, 'media', cb); return cb; } };
}

function setup() {
  const fake = fakeView();
  const window = { isDestroyed: () => false, contentView: { addChildView: vi.fn(), removeChildView: vi.fn() } };
  const makeView = vi.fn(() => fake.view);
  const preview = new PreviewView(() => window as never, makeView as never);
  preview.show('p1', 'http://localhost:4100/', ['http://localhost:4100']);
  return { ...fake, window, makeView, preview };
}

const navigateEvent = () => ({ preventDefault: vi.fn() });

beforeEach(() => vi.mocked(shell.openExternal).mockClear());

describe('the preview view', () => {
  it("uses the project's own partition and loads the page", () => {
    const { makeView, contents, window } = setup();
    expect(makeView).toHaveBeenCalledWith('persist:preview-p1');
    expect(contents.loadURL).toHaveBeenCalledWith('http://localhost:4100/');
    expect(window.contentView.addChildView).toHaveBeenCalled();
  });

  it('a link to another site is not loaded and opens in the browser', () => {
    const { handlers } = setup();
    const event = navigateEvent();
    handlers['will-navigate'](event, 'https://example.com/docs');
    expect(event.preventDefault).toHaveBeenCalled();
    expect(shell.openExternal).toHaveBeenCalledWith('https://example.com/docs');
  });

  it('a link within the page is loaded', () => {
    const { handlers } = setup();
    const event = navigateEvent();
    handlers['will-navigate'](event, 'http://localhost:4100/login');
    expect(event.preventDefault).not.toHaveBeenCalled();
  });

  it('a redirect elsewhere is stopped and never opened outside', () => {
    const { handlers } = setup();
    const event = navigateEvent();
    handlers['will-redirect'](event, 'https://accounts.google.com/o/oauth2');
    expect(event.preventDefault).toHaveBeenCalled();
    expect(shell.openExternal).not.toHaveBeenCalled();
  });

  it('file: and javascript: links are refused without opening anything', () => {
    const { handlers, open } = setup();
    for (const url of ['file:///etc/passwd', 'javascript:alert(1)']) {
      const event = navigateEvent();
      handlers['will-navigate'](event, url);
      expect(event.preventDefault).toHaveBeenCalled();
      expect(open(url)).toEqual({ action: 'deny' });
    }
    expect(shell.openExternal).not.toHaveBeenCalled();
  });

  it('new windows are denied, http(s) ones open in the browser', () => {
    const { open } = setup();
    expect(open('https://example.com')).toEqual({ action: 'deny' });
    expect(shell.openExternal).toHaveBeenCalledWith('https://example.com');
  });

  it('every permission request is refused', () => {
    const { permission } = setup();
    expect(permission()).toHaveBeenCalledWith(false);
  });

  it("navigating by address stays on the page's origin", () => {
    const { preview, contents } = setup();
    contents.loadURL.mockClear();
    preview.navigate({ url: 'https://evil.example' });
    expect(contents.loadURL).not.toHaveBeenCalled();
    preview.navigate({ url: 'http://localhost:4100/settings' });
    expect(contents.loadURL).toHaveBeenCalledWith('http://localhost:4100/settings');
  });

  it('hide keeps the page but takes it off the screen, and show brings it back', () => {
    const { preview, view } = setup();
    preview.setBounds({ x: 0, y: 40, width: 800, height: 600 });
    preview.hide();
    expect(view.setVisible).toHaveBeenLastCalledWith(false);
    preview.show('p1', 'http://localhost:4100/', ['http://localhost:4100']);
    expect(view.setVisible).toHaveBeenLastCalledWith(true);
  });

  it('destroy removes the view and closes its page', () => {
    const { preview, window, contents } = setup();
    preview.destroy();
    expect(window.contentView.removeChildView).toHaveBeenCalled();
    expect(contents.close).toHaveBeenCalled();
  });
});
