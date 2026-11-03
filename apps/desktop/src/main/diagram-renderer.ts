/**
 * Offline draw.io renderer (main process).
 *
 * Renders a .drawio file to PNG with the bundled draw.io viewer
 * (vendor/drawio-viewer, Apache-2.0) in a hidden window — no draw.io Desktop,
 * no cloud. The architect agent uses it to look at its own diagrams and fix
 * layout problems; the app shows the PNG in the task workspace.
 */

import { readFile, writeFile } from 'node:fs/promises';

import { BrowserWindow } from 'electron';

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

export function pngPathFor(drawioPath: string): string {
  return drawioPath.replace(/\.drawio(\.xml)?$/i, '') + '.png';
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
    const image = await win.webContents.capturePage({
      x: Math.floor(box.x),
      y: Math.floor(box.y),
      width: box.width,
      height: box.height,
    });
    const pngPath = pngPathFor(drawioPath);
    await writeFile(pngPath, image.toPNG());
    return { pngPath, width: box.width, height: box.height };
  } finally {
    win.destroy();
  }
}
