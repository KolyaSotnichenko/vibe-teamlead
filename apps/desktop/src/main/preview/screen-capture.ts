/**
 * The screen check's camera: a hidden, sandboxed window on a session of its own (nothing kept,
 * no permissions, no downloads, never leaving the app's origin) opens the running app, signs in by
 * the catalog's steps, and for each screen moves to its path inside the app, follows its steps,
 * hides the parts that change on their own and takes a picture of the whole page at its width.
 * Asked for the elements instead (the element check, element-check.ts), it lists what a person can
 * use on each page and takes no picture.
 */

import { randomUUID } from 'node:crypto';

import { BrowserWindow, nativeImage, session } from 'electron';

import { builtElementsOf } from '../ai/design/element-check';
import type { ScreenCatalog, ScreenStep } from '../ai/design/screen-catalog';
import type { Bitmap } from './screen-compare';
import type { ScreenCheckDeps, ScreenShot } from './screen-check';
import { elementsScript, maskScript, navigateScript, stepScript, unmaskScript } from './screen-replay';

const VIEW_HEIGHT = 900;
/** A page script that doesn't answer in this time fails its screen */
const SCRIPT_TIMEOUT_MS = 20_000;
/** The whole capture: past it, the screens left fail */
const CAPTURE_TIMEOUT_MS = 10 * 60_000;
const MAX_HEIGHT = 4000;
const LOAD_TIMEOUT_MS = 30_000;
const SETTLE_MS = 700;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Resolves after the window paints a frame, or after `timeoutMs`. */
function nextPaint(win: BrowserWindow, timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(done, timeoutMs);
    function done() {
      clearTimeout(timer);
      win.webContents.removeListener('paint', done);
      resolve();
    }
    win.webContents.once('paint', done);
    win.webContents.invalidate();
  });
}

/** A promise, or a rejection after `ms`. */
function within<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} took longer than ${Math.round(ms / 1000)} s`)), ms);
  });
  return Promise.race([promise, late]).finally(() => clearTimeout(timer));
}

async function run(win: BrowserWindow, script: string): Promise<{ ok: boolean; error?: string }> {
  try {
    return (await within(win.webContents.executeJavaScript(script, true), SCRIPT_TIMEOUT_MS, 'the page')) as { ok: boolean; error?: string };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

async function runSteps(win: BrowserWindow, steps: ScreenStep[]): Promise<string | undefined> {
  for (const step of steps) {
    const result = await run(win, stepScript(step));
    if (!result.ok) return result.error ?? 'a step failed';
    await sleep(250);
  }
  return undefined;
}

/**
 * Captures every screen of the catalog at `baseUrl`. One window, screens one after another. With
 * `elements`, each screen's shot is what a person can use on it, with no masks and no picture.
 * Never throws.
 */
export async function captureScreens(baseUrl: string, catalog: ScreenCatalog, signal?: AbortSignal, options: { elements?: boolean } = {}): Promise<ScreenShot[]> {
  const origin = new URL(baseUrl).origin;
  const partition = `screen-check-${randomUUID()}`;
  const own = session.fromPartition(partition, { cache: false });
  own.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  own.on('will-download', (event) => event.preventDefault());
  const win = new BrowserWindow({
    show: false,
    width: 1280,
    height: VIEW_HEIGHT,
    webPreferences: { offscreen: true, sandbox: true, contextIsolation: true, nodeIntegration: false, partition },
  });
  const shots: ScreenShot[] = [];
  try {
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    // Never leave the app: a link, a redirect or a frame elsewhere is stopped
    const guard = (event: { preventDefault: () => void }, url: string) => {
      try {
        if (new URL(url).origin !== origin) event.preventDefault();
      } catch {
        event.preventDefault();
      }
    };
    win.webContents.on('will-navigate', guard);
    win.webContents.on('will-redirect', guard);
    win.webContents.on('will-frame-navigate', (event) => guard(event, event.url));
    const onApp = () => {
      try {
        return new URL(win.webContents.getURL()).origin === origin;
      } catch {
        return false;
      }
    };
    const deadline = Date.now() + CAPTURE_TIMEOUT_MS;
    const start = new URL(catalog.signIn?.path ?? '/', origin).toString();
    await Promise.race([win.loadURL(start), sleep(LOAD_TIMEOUT_MS).then(() => Promise.reject(new Error('the app did not load')))]);
    await sleep(SETTLE_MS);
    const signInError = catalog.signIn ? await runSteps(win, catalog.signIn.steps) : undefined;
    if (signInError) {
      return catalog.screens.map((s) => ({ id: s.id, width: s.width, error: `sign-in failed: ${signInError}` }));
    }
    await sleep(SETTLE_MS);

    for (const screen of catalog.screens) {
      if (signal?.aborted) break;
      if (Date.now() > deadline) {
        shots.push({ id: screen.id, width: screen.width, error: 'the screen check ran out of time' });
        continue;
      }
      try {
        win.setContentSize(screen.width, VIEW_HEIGHT);
        await run(win, navigateScript(screen.path));
        await sleep(SETTLE_MS);
        const stepError = await runSteps(win, screen.steps);
        if (stepError) {
          shots.push({ id: screen.id, width: screen.width, error: stepError });
          continue;
        }
        await sleep(SETTLE_MS);
        if (options.elements) {
          const listed = (await run(win, elementsScript())) as { ok: boolean; error?: string; elements?: unknown };
          // The page is the task's code: what it reports is kept only as kinds and names
          const elements = listed.ok ? builtElementsOf(listed.elements) : null;
          if (!onApp()) shots.push({ id: screen.id, width: screen.width, error: 'the page left the app' });
          else if (!elements) shots.push({ id: screen.id, width: screen.width, error: typeof listed.error === 'string' ? listed.error.slice(0, 300) : 'the page could not be read' });
          else shots.push({ id: screen.id, width: screen.width, elements });
          continue;
        }
        if (screen.mask.length) {
          const masked = await run(win, maskScript(screen.mask));
          if (!masked.ok) {
            shots.push({ id: screen.id, width: screen.width, error: masked.error ?? 'the masks failed' });
            continue;
          }
        }
        const height = Number(await within(win.webContents.executeJavaScript('Math.ceil(document.documentElement.scrollHeight)', true), SCRIPT_TIMEOUT_MS, 'the page').catch(() => VIEW_HEIGHT));
        const pageHeight = Math.min(MAX_HEIGHT, Math.max(VIEW_HEIGHT, Number.isFinite(height) ? height : VIEW_HEIGHT));
        win.setContentSize(screen.width, pageHeight);
        await nextPaint(win, 1500);
        await sleep(300);
        if (!onApp()) {
          shots.push({ id: screen.id, width: screen.width, error: 'the page left the app' });
          continue;
        }
        const image = await within(win.webContents.capturePage({ x: 0, y: 0, width: screen.width, height: pageHeight }), SCRIPT_TIMEOUT_MS, 'the picture');
        shots.push(image.isEmpty() ? { id: screen.id, width: screen.width, error: 'the picture was empty' } : { id: screen.id, width: screen.width, png: image.toPNG() });
      } catch (error) {
        shots.push({ id: screen.id, width: screen.width, error: error instanceof Error ? error.message : String(error) });
      } finally {
        // The next screen is in the same page: what this one hid is shown again
        if (screen.mask.length && !options.elements) await run(win, unmaskScript());
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const done = new Set(shots.map((s) => `${s.id}@${s.width}`));
    for (const s of catalog.screens) if (!done.has(`${s.id}@${s.width}`)) shots.push({ id: s.id, width: s.width, error: message });
  } finally {
    if (!win.isDestroyed()) win.destroy();
    await own.clearStorageData().catch(() => {});
  }
  return shots;
}

/** A PNG's pixels, through Electron's image decoder */
export function pngBitmap(png: Buffer): Bitmap {
  const image = nativeImage.createFromBuffer(png);
  const { width, height } = image.getSize();
  return { width, height, data: new Uint8Array(image.toBitmap()) };
}

export const electronScreenDeps: ScreenCheckDeps = { capture: captureScreens, bitmap: pngBitmap };
