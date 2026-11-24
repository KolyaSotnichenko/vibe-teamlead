/**
 * In the task's window, while it waits for review: the frames of the design QA could not show in
 * the running app, with QA's reason each, and what to do. A merge waits for the owner on them, and
 * the bare "the merge waits for you" said nothing about what to look at.
 */

import { useEffect, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Task } from '../../../shared/types';

interface Unseen {
  file: string;
  width: number;
  title: string;
  reason: string;
}

const LINK = 'text-sm text-foreground underline underline-offset-2 hover:text-muted-foreground focus-visible:outline-2';

export function ScreensToCheckNotice({ task, onOpenDesign }: { task: Task; onOpenDesign?: () => void }) {
  const { t } = useTranslation('tasks');
  const headingId = useId();
  const [screens, setScreens] = useState<Unseen[]>([]);
  const waiting = task.status === 'human_review';

  useEffect(() => {
    if (!waiting) {
      setScreens([]);
      return;
    }
    let live = true;
    void window.electronAPI.design.taskDesign(task.id).then((result) => {
      if (!live || !result?.success || !result.data?.compare) return;
      const frames = result.data.frames ?? [];
      const titleOf = (file: string, width: number) => frames.find((f) => f.file === file && f.width === width)?.title ?? frames.find((f) => f.file === file)?.title ?? file;
      setScreens(
        result.data.compare.screens
          .filter((s) => s.notShown)
          .map((s) => ({ file: s.file, width: s.width, title: titleOf(s.file, s.width), reason: s.notShown as string })),
      );
    });
    return () => {
      live = false;
    };
  }, [task.id, waiting]);

  if (!waiting || !screens.length) return null;
  return (
    <section aria-labelledby={headingId} className="border-l-2 border-l-[var(--vt-signal)] py-1 pl-4">
      <h3 id={headingId} className="text-sm font-semibold text-foreground">{t('taskScreens.title', { count: screens.length })}</h3>
      <ul className="mt-1 space-y-1 text-sm">
        {screens.map((s) => (
          <li key={`${s.file}-${s.width}`}>
            <span className="text-foreground">{t('queue.screenToCheck', { title: s.title, width: s.width })}</span>
            <span className="block text-muted-foreground">{t('queue.screenToCheckWhy', { reason: s.reason })}</span>
          </li>
        ))}
      </ul>
      <p className="mt-1 text-sm text-muted-foreground">{t('taskScreens.how')}</p>
      {onOpenDesign && (
        <button type="button" onClick={onOpenDesign} className={LINK}>
          {t('taskScreens.openDesign')}
        </button>
      )}
    </section>
  );
}
