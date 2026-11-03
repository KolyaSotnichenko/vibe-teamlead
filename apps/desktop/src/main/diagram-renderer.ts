/**
 * Offline draw.io renderer (main process).
 *
 * Renders a .drawio file to PNG with the bundled draw.io viewer
 * (vendor/drawio-viewer, Apache-2.0) in a hidden window — no draw.io Desktop,
 * no cloud. The architect agent uses it to look at its own diagrams and fix
 * layout problems; the app shows the PNG in the task workspace.
 */

import { readFile, writeFile } from 'node:fs/promises';

import { BrowserWindow, type NativeImage } from 'electron';

import { cleanMermaidSource } from '../shared/utils/mermaid-source';

export interface RenderedDiagram {
  pngPath: string;
  width: number;
  height: number;
}

const RENDER_TIMEOUT_MS = 20_000;
const PADDING = 20;

/** Blank page the viewer is injected into (the viewer misbehaves on file:// origins). */
export const BLANK_PAGE =
  'data:text/html;charset=utf-8,' +
  encodeURIComponent(
    '<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;padding:0;background:#fff}' +
      '#d button{display:none!important}</style></head><body><div id="d"></div></body></html>',
  );

/** Script that renders the diagram XML into #d. Exported for tests. */
export function buildRenderScript(xml: string): string {
  return `(() => {
    const node = mxUtils.parseXml(${JSON.stringify(xml)}).documentElement;
    new GraphViewer(document.getElementById('d'), node, { toolbar: '', nav: false, lightbox: false, border: ${PADDING} });
    return true;
  })()`;
}

/** Script evaluated in the page: bounds of the rendered SVG, or null while rendering. */
export const MEASURE_SCRIPT = `(() => {
  const svg = document.querySelector('#d svg');
  if (!svg) return null;
  const r = svg.getBoundingClientRect();
  return r.width > 0 && r.height > 0 ? { x: r.left, y: r.top, width: Math.ceil(r.width), height: Math.ceil(r.height) } : null;
})()`;

export function pngPathFor(diagramPath: string): string {
  return diagramPath.replace(/\.(drawio(\.xml)?|mmd|mermaid)$/i, '') + '.png';
}

/** The viewer script, read once (it is ~5 MB). */
let viewerSource: { path: string; code: Promise<string> } | null = null;
function loadViewer(viewerScriptPath: string): Promise<string> {
  if (viewerSource?.path !== viewerScriptPath) {
    viewerSource = { path: viewerScriptPath, code: readFile(viewerScriptPath, 'utf-8') };
  }
  return viewerSource.code;
}

/** Renders run one at a time: each uses a hidden window, and the architect renders often. */
let queue: Promise<unknown> = Promise.resolve();

export function renderDrawioToPng(drawioPath: string, viewerScriptPath: string): Promise<RenderedDiagram> {
  const job = queue.then(() => renderOne(drawioPath, viewerScriptPath));
  queue = job.catch(() => undefined);
  return job;
}

/** Whether an image is (nearly) one flat colour: a frame captured before the diagram was painted. */
export function isBlankImage(bitmap: Buffer, step = 13): boolean {
  if (bitmap.length < 4) return true;
  const [b0, g0, r0] = [bitmap[0], bitmap[1], bitmap[2]];
  for (let i = 0; i + 3 < bitmap.length; i += 4 * step) {
    if (Math.abs(bitmap[i] - b0) > 8 || Math.abs(bitmap[i + 1] - g0) > 8 || Math.abs(bitmap[i + 2] - r0) > 8) return false;
  }
  return true;
}

/**
 * The painted diagram. An offscreen window paints asynchronously, so a capture
 * right after the SVG appears in the DOM can be an empty white frame (seen on
 * macOS). Wait for real paints and retry until the frame has content.
 */
async function captureRendered(win: BrowserWindow, rect: { x: number; y: number; width: number; height: number }): Promise<NativeImage> {
  let last: NativeImage | undefined;
  for (let attempt = 0; attempt < 6; attempt++) {
    await nextPaint(win, 1500);
    await new Promise((r) => setTimeout(r, 150 + attempt * 250));
    last = await win.webContents.capturePage(rect);
    if (!last.isEmpty() && !isBlankImage(last.toBitmap())) return last;
  }
  if (!last || last.isEmpty()) throw new Error('The diagram could not be captured');
  return last;
}

/** Resolve after the window paints a new frame (or after `timeoutMs`). */
function nextPaint(win: BrowserWindow, timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(done, timeoutMs);
    function done() {
      clearTimeout(timer);
      win.webContents.off('paint', done);
      resolve();
    }
    win.webContents.on('paint', done);
    win.webContents.invalidate();
  });
}

async function renderOne(drawioPath: string, viewerScriptPath: string): Promise<RenderedDiagram> {
  const [xml, viewer] = await Promise.all([readFile(drawioPath, 'utf-8'), loadViewer(viewerScriptPath)]);
  if (!/<mxfile|<mxGraphModel/.test(xml)) {
    throw new Error('Not a draw.io file: expected <mxfile> or <mxGraphModel> XML');
  }

  const win = new BrowserWindow({
    show: false,
    width: 3000,
    height: 2200,
    webPreferences: { offscreen: true, sandbox: true, contextIsolation: true, nodeIntegration: false },
  });

  try {
    // Never let a diagram navigate anywhere or open windows.
    win.webContents.on('will-navigate', (event) => event.preventDefault());
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    await win.loadURL(BLANK_PAGE);
    await win.webContents.executeJavaScript(viewer);
    await win.webContents.executeJavaScript(buildRenderScript(xml));

    const deadline = Date.now() + RENDER_TIMEOUT_MS;
    let bounds: { x: number; y: number; width: number; height: number } | null = null;
    while (Date.now() < deadline) {
      bounds = await win.webContents.executeJavaScript(MEASURE_SCRIPT);
      if (bounds) break;
      await new Promise((r) => setTimeout(r, 150));
    }
    if (!bounds) throw new Error('The diagram did not render (invalid XML or empty diagram)');

    // Grow the window if the diagram is larger than the viewport, then capture.
    let box = bounds;
    const [winW, winH] = win.getContentSize();
    if (box.width > winW || box.height > winH) {
      win.setContentSize(Math.max(winW, box.width + 40), Math.max(winH, box.height + 40));
      await new Promise((r) => setTimeout(r, 300));
      box = (await win.webContents.executeJavaScript(MEASURE_SCRIPT)) ?? box;
    }
    const rect = { x: Math.floor(box.x), y: Math.floor(box.y), width: box.width, height: box.height };
    const image = await captureRendered(win, rect);
    const pngPath = pngPathFor(drawioPath);
    await writeFile(pngPath, image.toPNG());
    return { pngPath, width: box.width, height: box.height };
  } finally {
    win.destroy();
  }
}

// ---------------------------------------------------------------------------
// Mermaid (.mmd): same hidden-window approach, with the bundled mermaid.min.js
// ---------------------------------------------------------------------------

export { cleanMermaidSource };

/** Script that renders the source into #d; resolves to an error message, or '' when it rendered. */
export function buildMermaidRenderScript(source: string): string {
  return `(async () => {
    try {
      mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: 'neutral' });
      const { svg } = await mermaid.render('m', ${JSON.stringify(source)});
      document.getElementById('d').innerHTML = svg;
      return '';
    } catch (e) {
      return String((e && (e.message || e.str)) || e).slice(0, 1500);
    }
  })()`;
}

export function renderMermaidToPng(mmdPath: string, mermaidScriptPath: string): Promise<RenderedDiagram> {
  const job = queue.then(() => renderMermaidOne(mmdPath, mermaidScriptPath));
  queue = job.catch(() => undefined);
  return job;
}

let mermaidSource: { path: string; code: Promise<string> } | null = null;

async function renderMermaidOne(mmdPath: string, mermaidScriptPath: string): Promise<RenderedDiagram> {
  if (mermaidSource?.path !== mermaidScriptPath) {
    mermaidSource = { path: mermaidScriptPath, code: readFile(mermaidScriptPath, 'utf-8') };
  }
  const [raw, mermaidJs] = await Promise.all([readFile(mmdPath, 'utf-8'), mermaidSource.code]);
  const source = cleanMermaidSource(raw);
  if (!source) throw new Error('The Mermaid file is empty');

  const win = new BrowserWindow({
    show: false,
    width: 3000,
    height: 2200,
    webPreferences: { offscreen: true, sandbox: true, contextIsolation: true, nodeIntegration: false },
  });
  try {
    win.webContents.on('will-navigate', (event) => event.preventDefault());
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    await win.loadURL(BLANK_PAGE);
    // `;0`: the script's last value (the mermaid object) cannot be sent back over IPC
    await win.webContents.executeJavaScript(`${mermaidJs}\n;0`);
    const error: string = await win.webContents.executeJavaScript(buildMermaidRenderScript(source));
    if (error) throw new Error(`Mermaid syntax error: ${error}`);
    const bounds: { x: number; y: number; width: number; height: number } | null =
      await win.webContents.executeJavaScript(MEASURE_SCRIPT);
    if (!bounds) throw new Error('The Mermaid diagram rendered empty');
    const rect = {
      x: Math.max(0, Math.floor(bounds.x) - PADDING),
      y: Math.max(0, Math.floor(bounds.y) - PADDING),
      width: bounds.width + PADDING * 2,
      height: bounds.height + PADDING * 2,
    };
    const image = await captureRendered(win, rect);
    const pngPath = pngPathFor(mmdPath);
    await writeFile(pngPath, image.toPNG());
    return { pngPath, width: rect.width, height: rect.height };
  } finally {
    win.destroy();
  }
}
