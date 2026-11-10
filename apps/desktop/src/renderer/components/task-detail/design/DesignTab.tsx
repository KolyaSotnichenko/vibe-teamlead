/**
 * Design tab of a task (design before code): the designer's wireframes and screens on a pan/zoom
 * canvas, each frame a sandboxed iframe served by vt-design://. The owner clicks a spot to comment
 * (the frame posts the element and point), sends the comments for a redraw or approves the stage
 * the task waits at; a frame plays as a prototype at preset widths. QA's comparison of the built
 * pages with the design shows under the comments once QA ran.
 */

import { type PointerEvent as ReactPointerEvent, type WheelEvent as ReactWheelEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2, Maximize2, MessageSquarePlus, Play, X } from 'lucide-react';

import type { Task, TaskDesign, TaskDesignComment, TaskDesignFrame } from '../../../../shared/types';
import { cn } from '../../../lib/utils';
import { Button } from '../../ui/button';
import { Dialog, DialogContent, DialogTitle } from '../../ui/dialog';
import { Textarea } from '../../ui/textarea';
import { EmptyState } from '../workspace/workspace-ui';
import { type FrameFilter, fitView, frameUrl, type View, visibleFrames, zoomAt } from './design-canvas';

const POLL_MS = 5000;
const PROTOTYPE_WIDTHS = [390, 768, 1280] as const;

interface Draft extends TaskDesignComment {
  id: number;
}

export function DesignTab({ task }: { task: Task }) {
  const { t, i18n } = useTranslation('tasks');
  const [design, setDesign] = useState<TaskDesign | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<'approve' | 'send' | null>(null);
  const [filter, setFilter] = useState<FrameFilter | null>(null);
  const [commenting, setCommenting] = useState(false);
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [general, setGeneral] = useState('');
  const [prototype, setPrototype] = useState<{ frame: TaskDesignFrame; width: number } | null>(null);
  const nextId = useRef(1);

  const load = useCallback(async () => {
    const result = await window.electronAPI.design.taskDesign(task.id);
    if (result.success && result.data) {
      setDesign(result.data);
      setError(null);
    } else setError(result.error ?? null);
  }, [task.id]);

  // Again when the task moves on, and every few seconds while an agent works on it
  useEffect(() => {
    void load();
  }, [load, task.status, task.reviewReason, task.executionProgress?.message]);
  useEffect(() => {
    if (task.status !== 'in_progress') return;
    const timer = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(timer);
  }, [load, task.status]);

  const waiting = design?.waiting ?? null;
  const hasScreens = !!design?.frames.some((f) => f.kind === 'screen');
  const hasWireframes = !!design?.frames.some((f) => f.kind === 'wireframe');
  const shown: FrameFilter = filter ?? (waiting === 'wireframes' || !hasScreens ? 'wireframes' : hasWireframes && waiting === 'design' ? 'all' : 'screens');
  const frames = useMemo(() => (design ? visibleFrames(design.frames, shown) : []), [design, shown]);

  const addDraft = (comment: TaskDesignComment) => {
    setDrafts((d) => [...d, { ...comment, id: nextId.current++ }]);
  };

  const send = async () => {
    const comments: TaskDesignComment[] = [...drafts.filter((d) => d.text.trim()).map(({ id: _id, ...c }) => c), ...(general.trim() ? [{ frame: '', text: general.trim() }] : [])];
    if (!comments.length) return;
    setBusy('send');
    const result = await window.electronAPI.design.commentTaskDesign(task.id, comments);
    setBusy(null);
    if (!result.success) return setError(result.error ?? null);
    setDrafts([]);
    setGeneral('');
    setCommenting(false);
    void load();
  };

  const approve = async () => {
    if (!waiting) return;
    setBusy('approve');
    const result = await window.electronAPI.design.approveTaskDesign(task.id, waiting);
    setBusy(null);
    if (!result.success) return setError(result.error ?? null);
    setFilter(null);
    void load();
  };

  if (!design) {
    return error ? (
      <div className="p-6">
        <EmptyState title={t('design.empty.errorTitle')} body={error} />
      </div>
    ) : (
      <div className="flex h-full items-center justify-center">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!design.frames.length) {
    const key = design.stage === 'skipped' ? 'noUi' : design.settings.mode === 'off' ? 'off' : task.status === 'in_progress' ? 'drawing' : 'notYet';
    return (
      <div className="p-6">
        <EmptyState title={t(`design.empty.${key}Title`)} body={t(`design.empty.${key}Body`)} />
      </div>
    );
  }

  const sendable = drafts.some((d) => d.text.trim()) || !!general.trim();
  const commentCount = drafts.filter((d) => d.text.trim()).length + (general.trim() ? 1 : 0);
  const date = (iso?: string) => (iso ? new Date(iso).toLocaleString(i18n.language, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '');

  return (
    <div className="grid h-full min-h-0 grid-cols-1 lg:grid-cols-[minmax(0,1fr)_340px]">
      <div className="relative flex min-h-[420px] flex-col">
        <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-2">
          {hasWireframes && hasScreens && (
            <div role="radiogroup" aria-label={t('design.show')} className="flex border border-foreground text-xs">
              {(['wireframes', 'screens', 'all'] as const).map((f) => (
                <button
                  key={f}
                  type="button"
                  role="radio"
                  aria-checked={shown === f}
                  onClick={() => setFilter(f)}
                  className={cn('min-h-8 px-2.5', shown === f ? 'bg-primary text-primary-foreground' : 'text-foreground hover:bg-muted')}
                >
                  {t(`design.filter.${f}`)}
                </button>
              ))}
            </div>
          )}
          <span className="flex-1" />
          {waiting && (
            <Button variant={commenting ? 'default' : 'outline'} size="sm" aria-pressed={commenting} onClick={() => setCommenting(!commenting)}>
              <MessageSquarePlus className="mr-1.5 h-3.5 w-3.5" />
              {commenting ? t('design.commentingOn') : t('design.comment')}
            </Button>
          )}
          <Button variant="outline" size="sm" onClick={() => setPrototype({ frame: frames.find((f) => f.kind === 'screen') ?? frames[0], width: (frames.find((f) => f.kind === 'screen') ?? frames[0]).width })}>
            <Play className="mr-1.5 h-3.5 w-3.5" />
            {t('design.runPrototype')}
          </Button>
        </div>
        <DesignCanvas
          taskId={task.id}
          frames={frames}
          frameSrc={design.frameSrc}
          commenting={commenting}
          drafts={drafts}
          onPick={(comment) => addDraft(comment)}
          onPlay={(frame) => setPrototype({ frame, width: frame.width })}
        />
      </div>

      <aside className="flex min-h-0 flex-col gap-4 overflow-y-auto border-l border-foreground bg-card p-5" aria-label={t('design.panel')}>
        <div className="space-y-1.5">
          <p className={cn('font-mono text-xs uppercase', waiting ? 'text-destructive' : 'text-muted-foreground')}>
            {waiting ? t(`design.kicker.${waiting}`) : t(`design.kicker.${design.stage === 'design' ? 'designDone' : 'wireframesDone'}`)}
          </p>
          <p className="text-sm text-muted-foreground">
            {waiting ? t(`design.intro.${waiting}`) : design.approved.design ? t('design.approvedOn', { date: date(design.approved.design) }) : design.approved.wireframes ? t('design.approvedOn', { date: date(design.approved.wireframes) }) : t('design.goesOn')}
          </p>
          {design.checkFindings ? <p className="text-xs text-destructive">{t('design.checkFindings', { count: design.checkFindings })}</p> : null}
        </div>

        {waiting && (
          <>
            {drafts.length > 0 ? (
              <ol className="border-t border-border">
                {drafts.map((d, i) => (
                  <li key={d.id} className="flex gap-2.5 border-b border-border py-3">
                    <span className="flex h-5 w-5 shrink-0 items-center justify-center bg-destructive font-mono text-[11px] font-bold text-destructive-foreground">{i + 1}</span>
                    <div className="min-w-0 flex-1 space-y-1">
                      <Textarea
                        rows={2}
                        autoFocus={i === drafts.length - 1 && !d.text}
                        aria-label={t('design.commentOn', { frame: design.frames.find((f) => f.file === d.frame)?.title ?? d.frame })}
                        value={d.text}
                        placeholder={t('design.commentPlaceholder')}
                        onChange={(e) => setDrafts((all) => all.map((x) => (x.id === d.id ? { ...x, text: e.target.value } : x)))}
                        className="text-sm"
                      />
                      <p className="truncate text-xs text-muted-foreground">{design.frames.find((f) => f.file === d.frame)?.title ?? d.frame}</p>
                    </div>
                    <button type="button" aria-label={t('design.removeComment')} onClick={() => setDrafts((all) => all.filter((x) => x.id !== d.id))} className="flex h-7 w-7 shrink-0 items-center justify-center text-muted-foreground hover:text-foreground">
                      <X className="h-4 w-4" />
                    </button>
                  </li>
                ))}
              </ol>
            ) : (
              <p className="border-t border-border pt-3 text-xs text-muted-foreground">{t('design.howToComment')}</p>
            )}
            <label className="flex flex-col gap-1.5 text-xs text-muted-foreground">
              {t('design.general')}
              <Textarea rows={3} value={general} onChange={(e) => setGeneral(e.target.value)} className="text-sm" />
            </label>
            {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
            <div className="mt-auto flex flex-col gap-2">
              <Button variant="outline" disabled={!sendable || busy !== null} onClick={() => void send()}>
                {busy === 'send' && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
                {t('design.send', { count: commentCount })}
              </Button>
              <Button disabled={busy !== null || sendable} onClick={() => void approve()} title={sendable ? t('design.sendFirst') : undefined}>
                {busy === 'approve' && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
                {waiting === 'wireframes' && design.settings.mode === 'full' ? t('design.approveWireframes') : t('design.approveDesign')}
              </Button>
              <p className="text-xs text-muted-foreground">{t('design.sendHint')}</p>
            </div>
          </>
        )}

        {design.compare && design.compare.screens.length > 0 && (
          <section aria-labelledby="design-compare" className="space-y-3 border-t border-foreground pt-4">
            <h3 id="design-compare" className="font-mono text-xs uppercase text-muted-foreground">{t('design.compare.title')}</h3>
            {design.compare.screens.map((s) => (
              <div key={`${s.file}-${s.width}`} className="space-y-1.5">
                <p className="text-sm font-medium text-foreground">
                  {design.frames.find((f) => f.file === s.file)?.title ?? s.file} · {s.width}px
                </p>
                {s.built && (
                  <img
                    src={`vt-design://task/${encodeURIComponent(task.id)}/spec/${s.built.split('/').map(encodeURIComponent).join('/')}`}
                    alt={t('design.compare.built', { width: s.width })}
                    className="max-h-48 w-full border border-border object-contain object-top"
                  />
                )}
                {s.differences.length ? (
                  <ul className="space-y-1 text-sm">
                    {s.differences.map((d) => (
                      <li key={d.text} className="flex gap-2">
                        <span className={cn('shrink-0 font-mono text-[11px] uppercase', d.severity === 'blocking' ? 'text-destructive' : 'text-muted-foreground')}>{t(`design.compare.${d.severity}`)}</span>
                        <span className="text-foreground">{d.text}</span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-xs text-muted-foreground">{t('design.compare.matches')}</p>
                )}
              </div>
            ))}
          </section>
        )}
      </aside>

      <Dialog open={!!prototype} onOpenChange={(open) => !open && setPrototype(null)}>
        <DialogContent className="flex h-[90vh] max-w-[95vw] flex-col gap-3 p-4">
          <DialogTitle>{t('design.prototypeTitle', { frame: prototype?.frame.title ?? '' })}</DialogTitle>
          {prototype && (
            <>
              <div role="radiogroup" aria-label={t('design.width')} className="flex gap-2">
                {[...PROTOTYPE_WIDTHS, prototype.frame.width].filter((w, i, all) => all.indexOf(w) === i).sort((a, b) => a - b).map((w) => (
                  <Button key={w} size="sm" role="radio" aria-checked={prototype.width === w} variant={prototype.width === w ? 'default' : 'outline'} onClick={() => setPrototype({ ...prototype, width: w })}>
                    {w}
                  </Button>
                ))}
              </div>
              <div className="flex min-h-0 flex-1 justify-center overflow-auto bg-muted">
                <iframe
                  key={`${prototype.frame.file}-${prototype.width}`}
                  title={prototype.frame.title}
                  src={frameUrl(task.id, prototype.frame.file, design.frameSrc)}
                  sandbox="allow-scripts"
                  style={{ width: prototype.width, height: '100%', border: 0, background: '#fff' }}
                />
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

/** The frames on a pan/zoom canvas; in comment mode a click inside a frame becomes a draft comment. */
function DesignCanvas({
  taskId,
  frames,
  frameSrc,
  commenting,
  drafts,
  onPick,
  onPlay,
}: {
  taskId: string;
  frames: TaskDesignFrame[];
  frameSrc?: Record<string, string>;
  commenting: boolean;
  drafts: Draft[];
  onPick: (comment: TaskDesignComment) => void;
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
      onPick({ frame: entry[0], selector: typeof data.selector === 'string' ? data.selector : undefined, x: data.x, y: data.y, text: '' });
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
          <div key={frame.file} className="absolute" style={{ left: frame.x, top: frame.y, width: frame.width }}>
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
                  if (el) iframes.current.set(frame.file, el);
                  else iframes.current.delete(frame.file);
                }}
                title={frame.title}
                src={frameUrl(taskId, frame.file, frameSrc)}
                sandbox="allow-scripts"
                onLoad={(e) => tellMode(e.currentTarget)}
                style={{ width: frame.width, height: frame.height, border: 0, pointerEvents: commenting ? 'auto' : 'none' }}
              />
              {drafts.map((d, i) =>
                d.frame === frame.file && d.x !== undefined && d.y !== undefined ? (
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
