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
    session: { setPermissionRequestHandler: vi.fn((handler: Handler) => { permissionHandler = handler; }), setPermissionCheckHandler: vi.fn(), clearStorageData: vi.fn(async () => {}) },
    loadURL: vi.fn(async () => {}),
    reload: vi.fn(),
    navigationHistory: { canGoBack: () => true, goBack: vi.fn(), canGoForward: () => false, goForward: vi.fn() },
    isDestroyed: () => false,
    close: vi.fn(),
    send: vi.fn(),
    id: 77,
    getURL: () => 'http://localhost:4100/login?next=/app',
    capturePage: vi.fn(async () => {
      const small = { toDataURL: () => 'data:image/png;base64,SMALL' };
      return { getSize: () => ({ width: 1600, height: 400 }), resize: vi.fn(() => small), toDataURL: () => 'data:image/png;base64,BIG' };
    }),
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
  it("signing out clears the page's cookies and storage, then reloads it", async () => {
    const { preview, contents } = setup();
    preview.navigate({ action: 'signOut' });
    await vi.waitFor(() => expect(contents.reload).toHaveBeenCalled());
    expect(contents.session.clearStorageData).toHaveBeenCalled();
    expect(contents.session.clearStorageData.mock.invocationCallOrder[0]).toBeLessThan(contents.reload.mock.invocationCallOrder[0]);
  });

  it('a stopped preview leaves no session behind: the next one starts signed out', () => {
    const { preview, contents } = setup();
    preview.destroy();
    expect(contents.session.clearStorageData).toHaveBeenCalled();
  });

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

  it("opens a bare path on the page's own address, and never a protocol-relative one elsewhere", () => {
    const { preview, contents } = setup();
    contents.loadURL.mockClear();
    preview.navigate({ url: '/login?next=/app' });
    expect(contents.loadURL).toHaveBeenCalledWith('http://localhost:4100/login?next=/app');
    contents.loadURL.mockClear();
    preview.navigate({ url: '//evil.example/x' });
    expect(contents.loadURL).not.toHaveBeenCalled();
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

describe('notes in the preview view', () => {
  const pick = {
    kind: 'element',
    rect: { x: 10, y: 20, width: 300, height: 40 },
    selector: 'main > h1',
    text: 'Roadmaply',
    html: '<h1>Roadmaply</h1>',
    frames: [{ file: '/wt/p1/apps/web/src/app/page.tsx', line: 7 }, { file: '/Users/me/elsewhere/x.ts', line: 1 }],
  };

  function notes() {
    const ctx = setup();
    const events: unknown[] = [];
    ctx.preview.onOverlayEvent((event) => events.push(event));
    ctx.preview.setWorktree('/wt/p1');
    ctx.preview.setBounds({ x: 0, y: 40, width: 1280, height: 800 });
    return { ...ctx, events };
  }

  it('tells the page overlay the mode and the pins', () => {
    const { preview, contents } = notes();
    preview.setNotesMode(true);
    preview.setPins([{ n: 1, selector: '#title' }]);
    preview.focusPin(1);
    expect(contents.send).toHaveBeenCalledWith('preview:overlay-command', { type: 'mode', on: true });
    expect(contents.send).toHaveBeenCalledWith('preview:overlay-command', { type: 'pins', pins: [{ n: 1, selector: '#title' }] });
    expect(contents.send).toHaveBeenCalledWith('preview:overlay-command', { type: 'focus', n: 1 });
  });

  it('turns a pick into a note draft: route, width, source frames relative to the worktree, and a screenshot of the element', async () => {
    const { preview, contents, events } = notes();
    preview.setNotesMode(true);
    await preview.handleOverlayMessage(77, { type: 'picked', pick });
    expect(contents.capturePage).toHaveBeenCalledWith({ x: 0, y: 4, width: 326, height: 72 });
    expect(events.filter((e) => (e as { type: string }).type !== 'route')).toEqual([
      {
        type: 'picked',
        route: '/login?next=/app',
        width: 1280,
        image: 'data:image/png;base64,SMALL',
        pick: { ...pick, kind: 'element', frames: [{ file: 'apps/web/src/app/page.tsx', line: 7 }] },
      },
    ]);
  });

  it('ignores picks while notes mode is off, from another page, or that are not picks', async () => {
    const { preview, events } = notes();
    await preview.handleOverlayMessage(77, { type: 'picked', pick });
    preview.setNotesMode(true);
    await preview.handleOverlayMessage(12, { type: 'picked', pick });
    await preview.handleOverlayMessage(77, { type: 'picked', pick: { kind: 'evil' } });
    expect(events.filter((e) => (e as { type: string }).type === 'picked')).toEqual([]);
  });

  it('passes on detached pins and Escape, and reports the route as the page moves', async () => {
    const { preview, events, handlers } = notes();
    await preview.handleOverlayMessage(77, { type: 'detached', ns: [2, 'x'] });
    await preview.handleOverlayMessage(77, { type: 'escape' });
    handlers['did-navigate-in-page']({}, 'http://localhost:4100/p/demo#top', true);
    expect(events).toEqual([{ type: 'detached', ns: [2] }, { type: 'escape' }, { type: 'route', route: '/p/demo' }]);
  });

  it('serves the overlay only to its own page', () => {
    const { preview } = notes();
    expect(preview.isOwnPage(77)).toBe(true);
    expect(preview.isOwnPage(5)).toBe(false);
  });

  it('turns notes mode on again in a page that loaded anew', () => {
    const { preview, contents, handlers } = notes();
    preview.setNotesMode(true);
    contents.send.mockClear();
    handlers['dom-ready']();
    expect(contents.send).toHaveBeenCalledWith('preview:overlay-command', { type: 'mode', on: true });
  });

  it("names the page's route when notes mode turns on, so pins show on a page already open", () => {
    const { preview, events } = notes();
    preview.setNotesMode(true);
    expect(events).toContainEqual({ type: 'route', route: '/login?next=/app' });
  });

  it('gives a page that loaded anew its pins again', () => {
    const { preview, contents, handlers } = notes();
    preview.setNotesMode(true);
    preview.setPins([{ n: 1, selector: '#a' }]);
    contents.send.mockClear();
    handlers['dom-ready']();
    expect(contents.send).toHaveBeenCalledWith('preview:overlay-command', { type: 'pins', pins: [{ n: 1, selector: '#a' }] });
  });
});
