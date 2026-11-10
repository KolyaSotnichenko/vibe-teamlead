/**
 * Design tab of a task (design before code): the designer's wireframes and screens on a pan/zoom
 * canvas, each frame a sandboxed iframe served by vt-design://. The owner clicks a spot to comment
 * (the frame posts the element and point), sends the comments for a redraw or approves the stage
 * the task waits at; a frame plays as a prototype at preset widths. QA's comparison of the built
 * pages with the design shows under the comments once QA ran.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2, MessageSquarePlus, Play, X } from 'lucide-react';

import type { Task, TaskDesign, TaskDesignComment, TaskDesignFrame } from '../../../../shared/types';
import { cn } from '../../../lib/utils';
import { Button } from '../../ui/button';
import { Textarea } from '../../ui/textarea';
import { EmptyState } from '../workspace/workspace-ui';
import { type FrameFilter, frameUrl, visibleFrames } from './design-canvas';
import { DesignCanvas, type Draft, PrototypeDialog } from './DesignCanvas';

const POLL_MS = 5000;

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

  const urlFor = (file: string) => frameUrl(task.id, file, design.frameSrc);
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
          frames={frames}
          urlFor={urlFor}
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
                {commentCount ? t('design.send', { count: commentCount }) : t('design.sendNone')}
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

      <PrototypeDialog prototype={prototype} onChange={setPrototype} urlFor={urlFor} />
    </div>
  );
}

