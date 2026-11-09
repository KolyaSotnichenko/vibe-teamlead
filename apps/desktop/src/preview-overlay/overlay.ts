/**
 * The Preview's notes overlay, in the previewed page's own world (injected by the view's
 * preload before the page's scripts, so react-grab sees React load). While notes mode is
 * on, it outlines the element under the pointer and takes a click (an element) or a drag
 * (a region) as a pick, without the click reaching the app. It shows the notes' numbered
 * pins on their elements. It draws in a shadow root the app's CSS can't reach, and talks
 * to the host only by window messages; what it sends is checked again in the host.
 */

import { FROM_HOST, FROM_OVERLAY, type HostCommand, type Pick, type PickRect, type SourceFrame } from './protocol';

/** What the overlay needs from react-grab and @medv/finder; tests pass fakes */
export interface OverlayDeps {
  getElementAtPoint: (x: number, y: number) => Element | null;
  getElementContext: (element: Element) => Promise<{
    selector?: string | null;
    htmlPreview?: string;
    componentName?: string | null;
    filePath?: string | null;
    lineNumber?: number | null;
    columnNumber?: number | null;
    stack?: Array<{ fileName?: string; lineNumber?: number; columnNumber?: number; functionName?: string; isIgnoreListed?: boolean }>;
  } | null>;
  finder: (element: Element) => string;
}

const SIGNAL = '#D6401A';
const DRAG_MIN = 6;

const collapse = (text: string | null | undefined) => (text ?? '').replace(/\s+/g, ' ').trim();

function rectOf(element: Element): PickRect {
  const r = element.getBoundingClientRect();
  return { x: r.left, y: r.top, width: Math.max(1, r.width), height: Math.max(1, r.height) };
}

/** Vue and Svelte dev builds name the component file on the element or its component */
function frameworkFrame(element: Element): SourceFrame | null {
  for (let node: Element | null = element; node; node = node.parentElement) {
    const any = node as unknown as Record<string, unknown>;
    const svelte = any.__svelte_meta as { loc?: { file?: string; line?: number; column?: number } } | undefined;
    if (svelte?.loc?.file) return { file: svelte.loc.file, line: svelte.loc.line, column: svelte.loc.column };
    const vue = any.__vueParentComponent as { type?: { __file?: string; __name?: string; name?: string } } | undefined;
    if (vue?.type?.__file) return { file: vue.type.__file, name: vue.type.__name ?? vue.type.name };
  }
  return null;
}

async function describe(element: Element, deps: OverlayDeps): Promise<Omit<Pick, 'kind' | 'rect' | 'elements'>> {
  let context: Awaited<ReturnType<OverlayDeps['getElementContext']>> = null;
  try {
    context = await deps.getElementContext(element);
  } catch {
    context = null;
  }
  let selector = context?.selector ?? '';
  if (!selector) {
    try {
      selector = deps.finder(element);
    } catch {
      selector = element.tagName.toLowerCase();
    }
  }
  const frames: SourceFrame[] = [];
  if (context?.filePath) frames.push({ file: context.filePath, line: context.lineNumber ?? undefined, column: context.columnNumber ?? undefined, name: context.componentName ?? undefined });
  for (const frame of context?.stack ?? []) {
    if (frames.length >= 3) break;
    if (!frame.fileName || frame.isIgnoreListed || frames.some((f) => f.file === frame.fileName && f.line === frame.lineNumber)) continue;
    frames.push({ file: frame.fileName, line: frame.lineNumber, column: frame.columnNumber, name: frame.functionName });
  }
  if (!frames.length) {
    const fallback = frameworkFrame(element);
    if (fallback) frames.push(fallback);
  }
  return {
    selector,
    text: collapse(element.textContent).slice(0, 200),
    html: (context?.htmlPreview || element.outerHTML).slice(0, 1500),
    ...(context?.componentName ? { component: context.componentName } : {}),
    frames,
  };
}

/** The outermost elements a dragged region mostly covers, at most five */
function coveredElements(region: PickRect, host: Element, doc: Document): Element[] {
  const inside: Element[] = [];
  for (const element of Array.from(doc.body?.querySelectorAll('*') ?? [])) {
    if (element === host || host.contains(element)) continue;
    const r = element.getBoundingClientRect();
    if (r.width < 4 || r.height < 4) continue;
    const overlapW = Math.max(0, Math.min(r.right, region.x + region.width) - Math.max(r.left, region.x));
    const overlapH = Math.max(0, Math.min(r.bottom, region.y + region.height) - Math.max(r.top, region.y));
    if ((overlapW * overlapH) / (r.width * r.height) < 0.6) continue;
    if (inside.some((outer) => outer.contains(element))) continue;
    inside.push(element);
    if (inside.length >= 5) break;
  }
  return inside;
}

export function startOverlay(win: Window, deps: OverlayDeps): () => void {
  const doc = win.document;
  const host = doc.createElement('vt-preview-overlay');
  host.setAttribute('style', 'all: initial; position: fixed; inset: 0; pointer-events: none; z-index: 2147483647;');
  const root = host.attachShadow({ mode: 'closed' });
  const outline = doc.createElement('div');
  const label = doc.createElement('div');
  const drag = doc.createElement('div');
  const pinLayer = doc.createElement('div');
  outline.setAttribute('style', `position: fixed; display: none; border: 2px solid ${SIGNAL}; pointer-events: none;`);
  label.setAttribute('style', `position: fixed; display: none; background: ${SIGNAL}; color: #fff; font: 11px/16px ui-monospace, monospace; padding: 0 4px; pointer-events: none;`);
  drag.setAttribute('style', `position: fixed; display: none; border: 2px dashed ${SIGNAL}; background: rgba(214, 64, 26, 0.08); pointer-events: none;`);
  root.append(outline, label, drag, pinLayer);
  const attach = () => {
    if (!host.isConnected) doc.documentElement.appendChild(host);
  };
  if (doc.documentElement) attach();
  else doc.addEventListener('DOMContentLoaded', attach, { once: true });

  let on = false;
  let start: { x: number; y: number } | null = null;
  let dragging = false;
  let pins: Array<{ n: number; selector: string }> = [];
  let lastDetached = '';

  const post = (message: Record<string, unknown>) => win.postMessage({ source: FROM_OVERLAY, ...message }, '*');
  const place = (box: HTMLElement, r: PickRect) => {
    box.style.left = `${r.x}px`;
    box.style.top = `${r.y}px`;
    box.style.width = `${r.width}px`;
    box.style.height = `${r.height}px`;
    box.style.display = 'block';
  };
  const hideHover = () => {
    outline.style.display = 'none';
    label.style.display = 'none';
  };
  const target = (x: number, y: number) => {
    const element = deps.getElementAtPoint(x, y);
    return element && element !== host && !host.contains(element) ? element : null;
  };

  const drawPins = () => {
    pinLayer.replaceChildren();
    const detached: number[] = [];
    for (const pin of pins) {
      let element: Element | null = null;
      try {
        element = doc.querySelector(pin.selector);
      } catch {
        element = null;
      }
      if (!element) {
        detached.push(pin.n);
        continue;
      }
      const r = element.getBoundingClientRect();
      const marker = doc.createElement('div');
      marker.textContent = String(pin.n);
      marker.setAttribute('style', `position: fixed; left: ${r.left}px; top: ${Math.max(0, r.top - 10)}px; min-width: 20px; height: 20px; background: ${SIGNAL}; color: #fff; font: 600 12px/20px ui-sans-serif, sans-serif; text-align: center; pointer-events: none;`);
      pinLayer.appendChild(marker);
    }
    const key = detached.join(',');
    if (key !== lastDetached) {
      lastDetached = key;
      post({ type: 'detached', ns: detached });
    }
  };
  let frame = 0;
  const schedulePins = () => {
    if (frame) return;
    frame = win.requestAnimationFrame(() => {
      frame = 0;
      drawPins();
    });
  };

  const block = (event: Event) => {
    if (!on) return;
    event.preventDefault();
    event.stopPropagation();
    (event as Event & { stopImmediatePropagation?: () => void }).stopImmediatePropagation?.();
  };

  const onMove = (event: MouseEvent) => {
    if (!on) return;
    if (start && (Math.abs(event.clientX - start.x) > DRAG_MIN || Math.abs(event.clientY - start.y) > DRAG_MIN)) dragging = true;
    if (dragging && start) {
      hideHover();
      place(drag, { x: Math.min(start.x, event.clientX), y: Math.min(start.y, event.clientY), width: Math.abs(event.clientX - start.x), height: Math.abs(event.clientY - start.y) });
      return;
    }
    const element = target(event.clientX, event.clientY);
    if (!element) return hideHover();
    const r = rectOf(element);
    place(outline, r);
    label.textContent = element.tagName.toLowerCase();
    label.style.left = `${r.x}px`;
    label.style.top = `${Math.max(0, r.y - 16)}px`;
    label.style.display = 'block';
  };

  const onDown = (event: MouseEvent) => {
    if (!on || event.button !== 0) return;
    block(event);
    start = { x: event.clientX, y: event.clientY };
    dragging = false;
  };

  const onUp = async (event: MouseEvent) => {
    if (!on || !start) return;
    block(event);
    const from = start;
    const wasDrag = dragging;
    start = null;
    dragging = false;
    drag.style.display = 'none';
    if (wasDrag) {
      const region = { x: Math.min(from.x, event.clientX), y: Math.min(from.y, event.clientY), width: Math.abs(event.clientX - from.x), height: Math.abs(event.clientY - from.y) };
      const covered = coveredElements(region, host, doc);
      const first = covered[0] ? await describe(covered[0], deps) : { selector: '', text: '', html: '', frames: [] };
      post({ type: 'picked', pick: { kind: 'region', rect: region, ...first, elements: await Promise.all(covered.map(async (e) => ({ selector: (await describe(e, deps)).selector, text: collapse(e.textContent).slice(0, 200) }))) } });
      return;
    }
    const element = target(event.clientX, event.clientY);
    if (!element) return;
    post({ type: 'picked', pick: { kind: 'element', rect: rectOf(element), ...(await describe(element, deps)) } });
  };

  const onKey = (event: KeyboardEvent) => {
    if (on && event.key === 'Escape') {
      block(event);
      post({ type: 'escape' });
    }
  };

  const onMessage = (event: MessageEvent) => {
    const data = event.data as (HostCommand & { source?: string }) | null;
    if (event.source !== win || !data || data.source !== FROM_HOST) return;
    if (data.type === 'mode') {
      on = !!data.on;
      if (!on) {
        hideHover();
        drag.style.display = 'none';
        start = null;
      }
      doc.documentElement.style.cursor = on ? 'crosshair' : '';
    } else if (data.type === 'pins' && Array.isArray(data.pins)) {
      pins = data.pins.filter((p) => typeof p?.n === 'number' && typeof p?.selector === 'string').slice(0, 200);
      lastDetached = '';
      drawPins();
    } else if (data.type === 'focus') {
      const pin = pins.find((p) => p.n === data.n);
      try {
        doc.querySelector(pin?.selector ?? '')?.scrollIntoView({ block: 'center', behavior: 'smooth' });
      } catch {
        // a selector the page no longer matches
      }
    }
  };

  const capture = { capture: true } as const;
  win.addEventListener('message', onMessage);
  win.addEventListener('mousemove', onMove, capture);
  win.addEventListener('mousedown', onDown, capture);
  win.addEventListener('mouseup', onUp, capture);
  win.addEventListener('click', block, capture);
  win.addEventListener('dblclick', block, capture);
  win.addEventListener('contextmenu', block, capture);
  win.addEventListener('keydown', onKey, capture);
  win.addEventListener('scroll', schedulePins, capture);
  win.addEventListener('resize', schedulePins);
  return () => {
    win.removeEventListener('message', onMessage);
    win.removeEventListener('mousemove', onMove, capture);
    win.removeEventListener('mousedown', onDown, capture);
    win.removeEventListener('mouseup', onUp, capture);
    win.removeEventListener('click', block, capture);
    win.removeEventListener('dblclick', block, capture);
    win.removeEventListener('contextmenu', block, capture);
    win.removeEventListener('keydown', onKey, capture);
    win.removeEventListener('scroll', schedulePins, capture);
    win.removeEventListener('resize', schedulePins);
    host.remove();
  };
}
