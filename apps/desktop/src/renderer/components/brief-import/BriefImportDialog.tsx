/**
 * Brief import: brief → proposal (epics, tasks) → review → tasks on the board.
 *
 *   Input ─ Analyse ─▶ Analysing ─▶ Review ─ Create N tasks ─▶ Done
 *     ▲                    │ Cancel          │ Back (discard)
 *     └────────────────────┴─────────────────┘
 *
 * One dialog, four steps. Nothing is created until "Create N tasks".
 * Design system: 1px ink frame over an ink/60 scrim, radius 0, no shadows,
 * vermilion only for "needs attention" (open questions, cycles, errors).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import type { BriefClarification, BriefCreatedTask, BriefProposal, BriefQuestionEvent, BriefTaskDraft } from '../../../shared/types';
import { cn } from '../../lib/utils';
import { loadTasks } from '../../stores/task-store';
import { BriefAnalysingStep } from './BriefAnalysingStep';
import { BriefDoneStep } from './BriefDoneStep';
import { type BriefFile, BriefInputStep } from './BriefInputStep';
import { BriefReviewStep } from './BriefReviewStep';
import { buildCreatePayload, lostDependencies } from './brief-review-model';
import { ghostButton, InlineError, primaryButton, secondaryButton, ToggleRow } from './brief-ui';

export type BriefStep = 'input' | 'analysing' | 'review' | 'done';
const STEPS: BriefStep[] = ['input', 'analysing', 'review', 'done'];
const MAX_LINES = 200;

export interface BriefImportDialogProps {
  projectId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** "Show on board" after the tasks are created; the dialog closes either way */
  onShowOnBoard?: () => void;
  /** Start in the review step with this proposal (tests, previews) */
  initialProposal?: BriefProposal;
}

export function BriefImportDialog({ projectId, open, onOpenChange, onShowOnBoard, initialProposal }: BriefImportDialogProps) {
  const { t } = useTranslation(['tasks', 'common']);
  const brief = window.electronAPI.brief;

  const [step, setStep] = useState<BriefStep>(initialProposal ? 'review' : 'input');
  const [file, setFile] = useState<BriefFile | null>(null);
  const [text, setText] = useState('');
  const [analyseError, setAnalyseError] = useState<string | null>(null);
  const [lines, setLines] = useState<string[]>([]);
  const [startedAt, setStartedAt] = useState(0);
  const [cancelling, setCancelling] = useState(false);
  const [proposal, setProposal] = useState<BriefProposal | null>(initialProposal ?? null);
  const [tasks, setTasks] = useState<BriefTaskDraft[]>(initialProposal?.tasks ?? []);
  const [excluded, setExcluded] = useState<Set<string>>(new Set());
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [queue, setQueue] = useState(true);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [created, setCreated] = useState<BriefCreatedTask[]>([]);
  const [createdTitles, setCreatedTitles] = useState<Map<string, string>>(new Map());
  const [confirm, setConfirm] = useState<null | 'close' | 'back'>(null);
  // Superpowers-style questions before the proposal (default on)
  const [clarify, setClarify] = useState(true);
  const [question, setQuestion] = useState<BriefQuestionEvent | null>(null);
  const [asked, setAsked] = useState<BriefClarification[]>([]);

  /** Bumped on every analyse / cancel / close: a late result of an older run is ignored. */
  const runRef = useRef(0);
  const stepRef = useRef(step);
  stepRef.current = step;

  const reset = useCallback(() => {
    runRef.current += 1;
    setStep(initialProposal ? 'review' : 'input');
    setFile(null);
    setText('');
    setAnalyseError(null);
    setLines([]);
    setCancelling(false);
    setProposal(initialProposal ?? null);
    setTasks(initialProposal?.tasks ?? []);
    setExcluded(new Set());
    setExpanded(new Set());
    setQueue(true);
    setCreating(false);
    setCreateError(null);
    setCreated([]);
    setConfirm(null);
    setQuestion(null);
    setAsked([]);
  }, [initialProposal]);

  // Fresh dialog every time it opens
  const wasOpen = useRef(open);
  useEffect(() => {
    if (open && !wasOpen.current) reset();
    wasOpen.current = open;
  }, [open, reset]);

  // Progress lines of this project's analysis
  useEffect(() => {
    if (!open) return;
    return brief.onProgress((event) => {
      if (event.projectId !== projectId || stepRef.current !== 'analysing') return;
      setLines((prev) => [...prev, event.message].slice(-MAX_LINES));
    });
  }, [open, projectId, brief]);

  // The analyst's questions for this project's analysis
  useEffect(() => {
    if (!open || !brief.onQuestion) return;
    return brief.onQuestion((event) => {
      if (event.projectId !== projectId || stepRef.current !== 'analysing') return;
      setQuestion(event);
    });
  }, [open, projectId, brief]);

  const answerQuestion = async (answers: Record<string, string> | null, stopAsking = false) => {
    if (!question) return;
    const current = question;
    setQuestion(null);
    setAsked((prev) => [
      ...prev,
      ...current.questions.map((q) => ({ question: q.question, answer: answers?.[q.question] })),
    ]);
    try {
      await brief.answer(projectId, current.questionId, answers, stopAsking);
    } catch {
      // The analyst stopped waiting; it continues on an assumption.
    }
  };

  const analyse = async () => {
    const token = ++runRef.current;
    const input = { ...(file ? { filePath: file.path } : { text: text.trim() }), clarify };
    setAnalyseError(null);
    setQuestion(null);
    setAsked([]);
    setLines([]);
    setCancelling(false);
    setStartedAt(Date.now());
    setStep('analysing');
    try {
      const result = await brief.analyze(projectId, input);
      if (token !== runRef.current) return;
      if (result.success && result.data) {
        setProposal(result.data);
        setTasks(result.data.tasks);
        setExcluded(new Set());
        setExpanded(new Set());
        setCreateError(null);
        setStep('review');
      } else {
        setAnalyseError(result.error || t('tasks:briefImport.errors.analyseUnknown'));
        setStep('input');
      }
    } catch (e) {
      if (token !== runRef.current) return;
      setAnalyseError(e instanceof Error ? e.message : t('tasks:briefImport.errors.analyseUnknown'));
      setStep('input');
    }
  };

  const cancelAnalysis = async () => {
    runRef.current += 1;
    setCancelling(true);
    try {
      await brief.cancel(projectId);
    } catch {
      // The run is already ignored; nothing else to undo.
    } finally {
      setCancelling(false);
      setStep('input');
    }
  };

  const payload = useMemo(() => buildCreatePayload(tasks, excluded), [tasks, excluded]);
  const missingTitle = payload.some((task) => task.title.length === 0);
  const droppedCount = useMemo(() => [...lostDependencies(tasks, excluded).values()].reduce((n, l) => n + l.length, 0), [tasks, excluded]);

  const createTasks = async () => {
    if (!proposal || payload.length === 0 || missingTitle) return;
    setCreating(true);
    setCreateError(null);
    try {
      const result = await brief.createTasks(projectId, proposal.briefId, payload, { queue });
      if (result.success && result.data) {
        setCreated(result.data);
        setCreatedTitles(new Map(payload.map((task) => [task.key, task.title])));
        setStep('done');
        await loadTasks(projectId);
      } else {
        setCreateError(result.error || t('tasks:briefImport.errors.createUnknown'));
      }
    } catch (e) {
      setCreateError(e instanceof Error ? e.message : t('tasks:briefImport.errors.createUnknown'));
    } finally {
      setCreating(false);
    }
  };

  const reviewDirty = step === 'review' && !!proposal;

  const requestClose = () => {
    if (creating) return;
    if (reviewDirty) {
      setConfirm('close');
      return;
    }
    if (step === 'analysing') void cancelAnalysis();
    runRef.current += 1;
    onOpenChange(false);
  };

  const confirmDiscard = () => {
    const action = confirm;
    setConfirm(null);
    setProposal(null);
    setTasks([]);
    if (action === 'close') {
      runRef.current += 1;
      onOpenChange(false);
    } else {
      setStep('input');
    }
  };

  const updateTask = (key: string, patch: Partial<BriefTaskDraft>) =>
    setTasks((prev) => prev.map((task) => (task.key === key ? { ...task, ...patch } : task)));

  const setIncluded = (keys: string[], include: boolean) =>
    setExcluded((prev) => {
      const next = new Set(prev);
      for (const key of keys) {
        if (include) next.delete(key);
        else next.add(key);
      }
      return next;
    });

  const toggleExpanded = (key: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const stepIndex = STEPS.indexOf(step);
  const canAnalyse = !!file || text.trim().length > 0;
  const wide = step === 'review';

  return (
    <DialogPrimitive.Root open={open} onOpenChange={(next) => (next ? onOpenChange(true) : requestClose())}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay
          className={cn(
            'fixed inset-0 z-50 bg-[rgb(28_29_25/0.6)]',
            'data-[state=open]:animate-in data-[state=open]:fade-in-0 motion-reduce:animate-none'
          )}
        />
        <DialogPrimitive.Content
          aria-describedby="brief-import-description"
          onInteractOutside={(e) => {
            // Clicks outside never throw away a running analysis or a proposal under review
            if (step === 'analysing' || reviewDirty || creating) e.preventDefault();
          }}
          className={cn(
            'fixed top-4 left-[50%] z-50 flex translate-x-[-50%] flex-col overflow-hidden border border-foreground bg-card text-card-foreground',
            'w-[95vw]',
            wide ? 'h-[calc(100vh-32px)] max-w-6xl' : 'max-h-[calc(100vh-32px)] max-w-3xl',
            'data-[state=open]:animate-in data-[state=open]:fade-in-0 duration-150 motion-reduce:animate-none'
          )}
        >
          {/* Header */}
          <header className="flex shrink-0 items-start gap-4 border-b border-border py-4 pr-2 pl-6">
            <div className="min-w-0 flex-1">
              <DialogPrimitive.Title className="text-[19px] font-semibold leading-tight tracking-[-0.02em] text-foreground">
                {t('tasks:briefImport.title')}
              </DialogPrimitive.Title>
              <DialogPrimitive.Description id="brief-import-description" className="sr-only">
                {t('tasks:briefImport.input.explain')}
              </DialogPrimitive.Description>
              <ol className="mt-3 flex flex-wrap items-center gap-x-1 gap-y-1" aria-label={t('tasks:briefImport.steps.label')}>
                {STEPS.map((s, i) => {
                  const current = i === stepIndex;
                  const past = i < stepIndex;
                  return (
                    <li key={s} aria-current={current ? 'step' : undefined} className="flex items-center gap-1">
                      {i > 0 && <span aria-hidden className={cn('h-px w-5', past || current ? 'bg-foreground' : 'bg-border')} />}
                      <span
                        className={cn(
                          'inline-flex h-6 items-center gap-1.5 px-1.5 font-mono text-[11px] uppercase tracking-[0.04em]',
                          current ? 'bg-primary text-primary-foreground' : past ? 'text-foreground' : 'text-muted-foreground'
                        )}
                      >
                        <span aria-hidden>{past ? '■' : current ? '▣' : '□'}</span>
                        {t(`tasks:briefImport.steps.${s}`)}
                      </span>
                    </li>
                  );
                })}
              </ol>
            </div>
            <button type="button" onClick={requestClose} disabled={creating} aria-label={t('common:buttons.close')} className={cn(ghostButton, 'w-11 px-0')}>
              <X aria-hidden className="h-5 w-5" />
            </button>
          </header>

          {/* Body */}
          <div className="min-h-0 flex-1 overflow-y-auto px-6 py-6">
            {step === 'input' && (
              <BriefInputStep
                file={file}
                text={text}
                onFileChange={(f) => {
                  setFile(f);
                  setAnalyseError(null);
                }}
                onTextChange={setText}
                error={analyseError}
                onRetry={canAnalyse ? () => void analyse() : undefined}
              />
            )}
            {step === 'analysing' && (
              <BriefAnalysingStep
                sourceLabel={file ? file.name : t('tasks:briefImport.analysing.yourDescription')}
                startedAt={startedAt}
                lines={lines}
                cancelling={cancelling}
                onCancel={() => void cancelAnalysis()}
                question={question?.questions ?? null}
                asked={asked}
                onAnswer={(answers, stop) => void answerQuestion(answers, stop)}
              />
            )}
            {step === 'review' && proposal && (
              <fieldset disabled={creating} className="min-w-0">
                <BriefReviewStep
                  proposal={proposal}
                  tasks={tasks}
                  excluded={excluded}
                  expanded={expanded}
                  onInclude={(key, include) => setIncluded([key], include)}
                  onIncludeMany={setIncluded}
                  onToggleExpanded={toggleExpanded}
                  onChangeTask={updateTask}
                />
              </fieldset>
            )}
            {step === 'done' && <BriefDoneStep created={created} titles={createdTitles} queued={queue} />}
          </div>

          {/* Footer */}
          {confirm ? (
            <footer role="alertdialog" aria-labelledby="brief-discard-title" className="flex shrink-0 flex-wrap items-center gap-3 border-t border-foreground px-6 py-3">
              <p id="brief-discard-title" className="min-w-0 flex-1 text-sm text-foreground">
                <span className="font-semibold">{t('tasks:briefImport.discard.title')}</span>{' '}
                <span className="text-muted-foreground">{t('tasks:briefImport.discard.body')}</span>
              </p>
              {/* biome-ignore lint/a11y/noAutofocus: design system — focus goes to the safe choice first */}
              <button type="button" autoFocus onClick={() => setConfirm(null)} className={secondaryButton}>
                {t('tasks:briefImport.discard.keep')}
              </button>
              <button type="button" onClick={confirmDiscard} className={primaryButton}>
                {t('tasks:briefImport.discard.confirm')}
              </button>
            </footer>
          ) : (
            <>
              {step === 'input' && (
                <footer className="flex shrink-0 items-center justify-end gap-3 border-t border-border px-6 py-3">
                  <ToggleRow
                    checked={clarify}
                    onChange={setClarify}
                    label={t('tasks:briefImport.input.clarify')}
                    hint={clarify ? t('tasks:briefImport.input.clarifyHint') : t('tasks:briefImport.input.clarifyOffHint')}
                    stateLabels={[t('tasks:briefImport.input.clarifyOn'), t('tasks:briefImport.input.clarifyOff')]}
                  />
                  <span className="flex-1" />
                  <button type="button" onClick={requestClose} className={ghostButton}>
                    {t('common:buttons.cancel')}
                  </button>
                  <button type="button" onClick={() => void analyse()} disabled={!canAnalyse} className={primaryButton}>
                    {t('tasks:briefImport.input.analyse')}
                  </button>
                </footer>
              )}
              {step === 'review' && (
                <footer className="shrink-0 border-t border-foreground px-6 py-3">
                  {createError && (
                    <div className="mb-3">
                      <InlineError
                        title={t('tasks:briefImport.errors.createTitle')}
                        message={createError}
                        onRetry={() => void createTasks()}
                        retryLabel={t('tasks:briefImport.errors.retry')}
                      />
                    </div>
                  )}
                  <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
                    <button type="button" onClick={() => setConfirm('back')} disabled={creating} className={secondaryButton}>
                      {t('tasks:briefImport.review.back')}
                    </button>
                    <ToggleRow
                      checked={queue}
                      onChange={setQueue}
                      disabled={creating}
                      label={t('tasks:briefImport.review.queue')}
                      hint={queue ? t('tasks:briefImport.review.queueOn') : t('tasks:briefImport.review.queueOff')}
                      stateLabels={[t('tasks:briefImport.review.on'), t('tasks:briefImport.review.off')]}
                    />
                    <span className="flex-1" />
                    {droppedCount > 0 && (
                      <span className="font-mono text-xs text-muted-foreground">
                        {t('tasks:briefImport.review.droppedCount', { count: droppedCount })}
                      </span>
                    )}
                    {missingTitle && <span className="text-xs text-destructive">{t('tasks:briefImport.review.fixTitles')}</span>}
                    <button
                      type="button"
                      onClick={() => void createTasks()}
                      disabled={creating || payload.length === 0 || missingTitle}
                      className={cn(primaryButton, 'min-w-[176px]')}
                    >
                      {creating ? (
                        <>
                          <span aria-hidden className="vt-breathe h-2 w-2 bg-primary-foreground" />
                          {t('tasks:briefImport.review.creating', { count: payload.length })}
                        </>
                      ) : (
                        t('tasks:briefImport.review.create', { count: payload.length })
                      )}
                    </button>
                  </div>
                </footer>
              )}
              {step === 'done' && (
                <footer className="flex shrink-0 items-center justify-end gap-3 border-t border-border px-6 py-3">
                  <button type="button" onClick={() => onOpenChange(false)} className={secondaryButton}>
                    {t('common:buttons.close')}
                  </button>
                  {onShowOnBoard && (
                    <button
                      type="button"
                      onClick={() => {
                        onOpenChange(false);
                        onShowOnBoard();
                      }}
                      className={primaryButton}
                    >
                      {t('tasks:briefImport.done.showOnBoard')}
                    </button>
                  )}
                </footer>
              )}
            </>
          )}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
