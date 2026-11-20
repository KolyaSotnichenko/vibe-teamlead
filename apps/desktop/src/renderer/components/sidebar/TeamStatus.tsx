/**
 * Team status — what the agent team is doing right now for the selected project,
 * as the pixel teamlead's mood and one sentence (and, if enabled, droid chirps),
 * and under it the one thing that needs the user: an agent's question, shown only
 * while one is waiting. That row is the only vermilion here.
 *
 * The counts of running, queued and ready-for-review tasks are in the status bar:
 * with them here too, every number stood on the screen two or three times.
 */

import { useEffect, useRef, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useTranslation } from 'react-i18next';

import { useAgentQuestionsStore } from '../../stores/agent-questions-store';
import { useSettingsStore } from '../../stores/settings-store';
import { useTaskStore } from '../../stores/task-store';
import { phraseFor, speak } from './teamlead/droid-voice';
import { countMood, DONE_FOR_MS, HELLO_FOR_MS, SLEEP_AFTER_MS, teamleadMood } from './teamlead/mood';
import type { TeamleadMood } from './teamlead/sprite';
import { Teamlead } from './teamlead/Teamlead';

export interface TeamCounts {
  working: number;
  queued: number;
  review: number;
}

/** Exported for tests. */
export function countTeam(statuses: string[]): TeamCounts {
  let working = 0;
  let queued = 0;
  let review = 0;
  for (const status of statuses) {
    if (status === 'in_progress' || status === 'ai_review') working += 1;
    else if (status === 'queue') queued += 1;
    else if (status === 'human_review') review += 1;
  }
  return { working, queued, review };
}

export function TeamStatus({ projectId, collapsed }: { projectId: string | null; collapsed: boolean }) {
  const { t } = useTranslation('navigation');
  const pending = useAgentQuestionsStore((s) => s.pending);
  const openQuestion = useAgentQuestionsStore((s) => s.open);

  const waiting = pending.filter((q) => !projectId || !q.projectId || q.projectId === projectId);
  const mood = useTeamleadMood(projectId, waiting.length);

  if (collapsed) {
    // Collapsed: a single mark that only appears when someone is waiting.
    return waiting.length > 0 ? (
      <button
        type="button"
        onClick={() => openQuestion(waiting[0].questionId)}
        aria-label={`${t('teamStatus.waiting')}: ${waiting.length}`}
        className="mx-auto flex h-11 w-11 items-center justify-center bg-[var(--vt-signal-text)] font-mono text-sm text-[var(--vt-paper)]"
      >
        {waiting.length}
      </button>
    ) : null;
  }

  const caption = t(`teamStatus.mood.${mood.mood}`, { count: mood.count });

  return (
    <section aria-label={t('teamStatus.title')} className="mx-3 border border-border">
      <div className="flex items-center gap-3 px-3 py-3">
        <Teamlead mood={mood.mood} label={t('teamStatus.teamleadLabel', { mood: caption })} onClick={mood.greet} />
        <p aria-live="polite" className="min-w-0 text-xs leading-relaxed text-foreground">
          {caption}
        </p>
      </div>
      {waiting.length > 0 && (
        <button
          type="button"
          onClick={() => openQuestion(waiting[0].questionId)}
          className="flex min-h-9 w-full items-center justify-between border-t border-border px-3 text-sm text-[var(--vt-signal-on-dark)] hover:bg-accent"
        >
          <span className="flex items-center gap-2">
            <span aria-hidden className="h-2 w-2 bg-[var(--vt-signal-on-dark)] vt-breathe" />
            {t('teamStatus.waiting')}
          </span>
          <span className="font-mono tabular-nums">{waiting.length}</span>
        </button>
      )}
    </section>
  );
}

function isShipped(status: string): boolean {
  return status === 'done' || status === 'pr_created';
}

const MOOD_COUNT: Partial<Record<TeamleadMood, keyof ReturnType<typeof countMood> | 'waiting'>> = {
  working: 'coding',
  qa: 'qa',
  queued: 'queued',
  waiting: 'waiting',
  review: 'review',
  error: 'errors',
};

/**
 * The teamlead's mood for a project, with the short-lived moods (a fresh
 * merge, a greeting on opening or a click) and falling asleep after a quiet hour. Speaks when the
 * mood changes, if the voice is on; switching projects is silent.
 */
function useTeamleadMood(projectId: string | null, waiting: number) {
  const counts = useTaskStore(
    useShallow((s) => countMood(projectId ? s.tasks.filter((task) => task.projectId === projectId) : [])),
  );
  const taskIds = (s: ReturnType<typeof useTaskStore.getState>, shippedOnes: boolean) =>
    projectId
      ? s.tasks
          .filter((task) => task.projectId === projectId && isShipped(task.status) === shippedOnes)
          .map((task) => task.id)
          .sort()
          .join(',')
      : '';
  const shipped = useTaskStore((s) => taskIds(s, true));
  const unshipped = useTaskStore((s) => taskIds(s, false));
  const voiceOn = useSettingsStore((s) => s.settings.teamleadVoice !== false);
  const [mergedUntil, setMergedUntil] = useState(0);
  // Opening the app: he waves, as he does when clicked
  const [helloUntil, setHelloUntil] = useState(() => Date.now() + HELLO_FOR_MS);
  const [quietSince, setQuietSince] = useState(() => Date.now());
  const [, setTick] = useState(0);

  // A task seen unfinished that is now done or a PR: a short celebration. Tasks loading
  // already finished (at startup, on switching projects) were never seen unfinished.
  const seenUnshipped = useRef<{ project: string | null; ids: Set<string> } | null>(null);
  useEffect(() => {
    const prev = seenUnshipped.current;
    seenUnshipped.current = { project: projectId, ids: new Set(unshipped ? unshipped.split(',') : []) };
    if (prev?.project !== projectId || !shipped) return;
    if (shipped.split(',').some((id) => prev.ids.has(id))) setMergedUntil(Date.now() + DONE_FOR_MS);
  }, [shipped, unshipped, projectId]);

  const signature = `${projectId}|${counts.coding}|${counts.qa}|${counts.queued}|${counts.review}|${counts.errors}|${waiting}`;
  useEffect(() => {
    setQuietSince(Date.now());
  }, [signature]);

  const now = Date.now();
  // One timer for the nearest moment the mood changes by itself
  const upcoming = [mergedUntil, helloUntil, quietSince + SLEEP_AFTER_MS].filter((at) => at > now);
  const nextChange = upcoming.length ? Math.min(...upcoming) : 0;
  useEffect(() => {
    if (!nextChange) return;
    const id = window.setTimeout(() => setTick((n) => n + 1), Math.max(nextChange - Date.now(), 0) + 20);
    return () => window.clearTimeout(id);
  }, [nextChange]);

  const mood = teamleadMood({
    ...counts,
    waiting,
    quietForMs: now - quietSince,
    justMerged: mergedUntil > now,
    hello: helloUntil > now,
  });

  const spoken = useRef<{ project: string | null; mood: TeamleadMood } | null>(null);
  useEffect(() => {
    const prev = spoken.current;
    spoken.current = { project: projectId, mood };
    const phrase = phraseFor(prev && prev.project === projectId ? prev.mood : null, mood);
    if (phrase && voiceOn) speak(phrase);
  }, [mood, projectId, voiceOn]);

  const key = MOOD_COUNT[mood];
  return {
    mood,
    count: key === 'waiting' ? waiting : key ? counts[key] : 0,
    greet: () => setHelloUntil(Date.now() + HELLO_FOR_MS),
  };
}
