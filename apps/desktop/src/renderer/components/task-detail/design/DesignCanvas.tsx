/**
 * A design canvas: frames (sandboxed iframes) on a pan/zoom board, with comment picks and pins;
 * and the prototype dialog that plays one frame at preset widths. Used by a task's Design tab and
 * by the project's design library (Context → Design system → Screens).
 */

import { type PointerEvent as ReactPointerEvent, type WheelEvent as ReactWheelEvent, useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Maximize2 } from 'lucide-react';

import type { TaskDesignComment, TaskDesignFrame } from '../../../../shared/types';
import { cn } from '../../../lib/utils';
import { Button } from '../../ui/button';
import { Dialog, DialogContent, DialogTitle } from '../../ui/dialog';
import { fitView, type View, zoomAt } from './design-canvas';

const PROTOTYPE_WIDTHS = [390, 768, 1280] as const;

export interface Draft extends TaskDesignComment {
  id: number;
}

export function PrototypeDialog({
  prototype,
  onChange,
  urlFor,
}: {
  prototype: { frame: TaskDesignFrame; width: number } | null;
  onChange: (next: { frame: TaskDesignFrame; width: number } | null) => void;
  urlFor: (file: string) => string;
}) {
  const { t } = useTranslation('tasks');
  return (
    <Dialog open={!!prototype} onOpenChange={(open) => !open && onChange(null)}>
      <DialogContent className="flex h-[90vh] max-w-[95vw] flex-col gap-3 p-4">
        <DialogTitle>{t('design.prototypeTitle', { frame: prototype?.frame.title ?? '' })}</DialogTitle>
        {prototype && (
          <>
            <div role="radiogroup" aria-label={t('design.width')} className="flex gap-2">
              {[...PROTOTYPE_WIDTHS, prototype.frame.width]
                .filter((w, i, all) => all.indexOf(w) === i)
                .sort((a, b) => a - b)
                .map((w) => (
                  <Button key={w} size="sm" role="radio" aria-checked={prototype.width === w} variant={prototype.width === w ? 'default' : 'outline'} onClick={() => onChange({ ...prototype, width: w })}>
                    {w}
                  </Button>
                ))}
            </div>
            <div className="flex min-h-0 flex-1 justify-center overflow-auto bg-muted">
              <iframe
                key={`${prototype.frame.file}-${prototype.width}`}
                title={prototype.frame.title}
                src={urlFor(prototype.frame.file)}
                sandbox="allow-scripts"
                style={{ width: prototype.width, height: '100%', border: 0, background: '#fff' }}
              />
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

/** The frames on a pan/zoom canvas; in comment mode a click inside a frame becomes a draft comment. */
export function DesignCanvas({
  frames,
  urlFor,
  commenting = false,
  drafts = [],
  onPick,
  onPlay,
}: {
  frames: TaskDesignFrame[];
  /** Where a frame's page is served */
  urlFor: (file: string) => string;
  commenting?: boolean;
  drafts?: Draft[];
  onPick?: (comment: TaskDesignComment) => void;
  onPlay: (frame: TaskDesignFrame) => void;
}) {
  const { t } = useTranslation('tasks');
  const box = useRef<HTMLDivElement>(null);
  const iframes = useRef(new Map<string, HTMLIFrameElement>());
  const [view, setView] = useState<View>({ x: 0, y: 0, scale: 0.3 });
  const drag = useRef<{ x: number; y: number; view: View } | null>(null);
  const framesKey = frames.map((f) => f.file).join('|');
  /** A comment pin's size in canvas px: about 24 px on screen */
  const pin = Math.min(120, 24 / view.scale);

  const fit = useCallback(() => {
    const el = box.current;
    if (el) setView(fitView(frames, { width: el.clientWidth, height: el.clientHeight }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [framesKey]);
  useEffect(() => fit(), [fit]);

  // Comment mode reaches every frame (and a frame that loads later)
  const tellMode = useCallback((frame: HTMLIFrameElement | undefined) => frame?.contentWindow?.postMessage({ type: 'vt-design:mode', on: commenting }, '*'), [commenting]);
  useEffect(() => {
    for (const frame of iframes.current.values()) tellMode(frame);
  }, [tellMode]);

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const data = event.data as { type?: string; selector?: string; x?: number; y?: number } | null;
      if (!commenting || data?.type !== 'vt-design:pick') return;
      const entry = [...iframes.current.entries()].find(([, frame]) => frame.contentWindow === event.source);
      if (!entry) return;
      // The same file can be on the canvas at several widths: key = file@width
      const [file, width] = entry[0].split('@');
      onPick?.({ frame: file, width: Number(width), selector: typeof data.selector === 'string' ? data.selector : undefined, x: data.x, y: data.y, text: '' });
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [commenting, onPick]);

  const onWheel = (e: ReactWheelEvent) => {
    const rect = box.current?.getBoundingClientRect();
    if (!rect) return;
    if (e.ctrlKey || e.metaKey) setView((v) => zoomAt(v, { x: e.clientX - rect.left, y: e.clientY - rect.top }, Math.exp(-e.deltaY * 0.01)));
    else setView((v) => ({ ...v, x: v.x - e.deltaX, y: v.y - e.deltaY }));
  };
  const onPointerDown = (e: ReactPointerEvent) => {
    if (commenting || e.button !== 0) return;
    drag.current = { x: e.clientX, y: e.clientY, view };
    (e.target as Element).setPointerCapture?.(e.pointerId);
  };
  const onPointerMove = (e: ReactPointerEvent) => {
    const d = drag.current;
    if (d) setView({ ...d.view, x: d.view.x + e.clientX - d.x, y: d.view.y + e.clientY - d.y });
  };

  return (
    <div
      ref={box}
      onWheel={onWheel}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={() => (drag.current = null)}
      className={cn('relative min-h-0 flex-1 touch-none overflow-hidden bg-muted', !commenting && 'cursor-grab active:cursor-grabbing')}
      style={{ backgroundImage: 'radial-gradient(var(--border) 1px, transparent 1px)', backgroundSize: '16px 16px' }}
    >
      <div className="absolute left-0 top-0 origin-top-left" style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})` }}>
        {frames.map((frame) => (
          <div key={`${frame.file}@${frame.width}`} className="absolute" style={{ left: frame.x, top: frame.y, width: frame.width }}>
            {/* The title stays readable at any zoom: sized in screen px, above the frame */}
            <div className="absolute inset-x-0 bottom-full flex items-center justify-between gap-2" style={{ fontSize: Math.min(48, 13 / view.scale), paddingBottom: 4 / view.scale }}>
              <span className="truncate font-mono text-muted-foreground">{frame.title}</span>
              <button type="button" onClick={() => onPlay(frame)} className="font-mono text-muted-foreground underline-offset-4 hover:underline" aria-label={t('design.playFrame', { frame: frame.title })}>
                ▶
              </button>
            </div>
            <div className="relative border border-border bg-white" style={{ width: frame.width, height: frame.height }}>
              <iframe
                ref={(el) => {
                  if (el) iframes.current.set(`${frame.file}@${frame.width}`, el);
                  else iframes.current.delete(`${frame.file}@${frame.width}`);
                }}
                title={frame.title}
                src={urlFor(frame.file)}
                sandbox="allow-scripts"
                onLoad={(e) => tellMode(e.currentTarget)}
                style={{ width: frame.width, height: frame.height, border: 0, pointerEvents: commenting ? 'auto' : 'none' }}
              />
              {drafts.map((d, i) =>
                d.frame === frame.file && (d.width === undefined || d.width === frame.width) && d.x !== undefined && d.y !== undefined ? (
                  <span
                    key={d.id}
                    aria-hidden="true"
                    className="pointer-events-none absolute flex items-center justify-center bg-destructive font-bold text-destructive-foreground"
                    style={{ left: d.x - pin / 2, top: d.y - pin / 2, width: pin, height: pin, fontSize: pin / 2 }}
                  >
                    {i + 1}
                  </span>
                ) : null,
              )}
            </div>
          </div>
        ))}
      </div>
      <div className="absolute bottom-3 left-3 flex items-center gap-2 border border-foreground bg-card px-3 py-1.5 text-xs">
        <span className="font-mono">{t('design.frames', { count: frames.length })}</span>
        <span className="text-muted-foreground">·</span>
        <span>{commenting ? t('design.clickToComment') : t('design.dragToMove')}</span>
        <button type="button" onClick={fit} className="ml-1 flex items-center gap-1 underline-offset-4 hover:underline">
          <Maximize2 className="h-3 w-3" aria-hidden="true" />
          {t('design.fit')} · {Math.round(view.scale * 100)}%
        </button>
      </div>
    </div>
  );
}
