/**
 * Placeholders left in the product ("coming soon", "lorem ipsum", a page that says it is
 * one). One task ships them and no later task owns replacing them, so the board names them
 * after every merge, with a task to replace each, or the owner's word that it stays.
 */

import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronDown, ChevronRight } from 'lucide-react';
import type { LooseEnd } from '../../shared/types';
import { looseEndKey } from '../../shared/utils/loose-end-key';
import { createTask } from '../stores/task-store';
import { updateProjectSettings, useProjectStore } from '../stores/project-store';

interface LooseEndsNoticeProps {
  projectId: string;
  /** Changes when the board's tasks change (a merge), so the list is read again */
  refreshKey: number | string;
}

function taskText(end: LooseEnd): { title: string; description: string } {
  return {
    title: `Replace the placeholder in ${end.file}`,
    description: [
      `\`${end.file}:${end.line}\` still shows a placeholder that no task replaced:`,
      '',
      `> ${end.text}`,
      '',
      'Replace it with what the product needs here. If the page should not exist, remove it and send its route somewhere useful. Acceptance: the placeholder text is gone, and a test shows what the page renders or where it redirects.',
    ].join('\n'),
  };
}

export function LooseEndsNotice({ projectId, refreshKey }: LooseEndsNoticeProps) {
  const { t } = useTranslation('tasks');
  const ignored = useProjectStore((state: { projects: Array<{ id: string; settings?: { ignoredLooseEnds?: string[] } }> }) =>
    state.projects.find((p) => p.id === projectId)?.settings?.ignoredLooseEnds,
  );
  const [found, setFound] = useState<LooseEnd[]>([]);
  const [open, setOpen] = useState(false);
  const [created, setCreated] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    window.electronAPI
      ?.getLooseEnds?.(projectId)
      .then((result) => {
        if (!cancelled && result?.success) setFound(result.data ?? []);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [projectId, refreshKey]);

  if (!found.length) return null;

  const create = async (end: LooseEnd) => {
    const key = looseEndKey(end);
    setBusy(key);
    try {
      const { title, description } = taskText(end);
      if (await createTask(projectId, title, description)) setCreated((prev) => new Set(prev).add(key));
    } finally {
      setBusy(null);
    }
  };

  const leave = async (end: LooseEnd) => {
    const key = looseEndKey(end);
    setBusy(key);
    try {
      if (await updateProjectSettings(projectId, { ignoredLooseEnds: [...(ignored ?? []), key] })) {
        setFound((prev) => prev.filter((other) => looseEndKey(other) !== key));
      }
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="mx-4 mt-2 border-l-[3px] border-[var(--vt-signal)] bg-muted">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className="flex min-h-11 w-full items-center gap-2 px-3 text-left text-sm font-medium text-foreground"
      >
        {open ? <ChevronDown aria-hidden className="h-4 w-4" /> : <ChevronRight aria-hidden className="h-4 w-4" />}
        {t('looseEnds.title', { count: found.length })}
      </button>
      {open && (
        <div className="px-3 pb-3">
          <p className="mb-2 text-sm text-muted-foreground">{t('looseEnds.body')}</p>
          <ul className="space-y-2">
            {found.map((end) => {
              const key = looseEndKey(end);
              return (
                <li key={key} className="border border-border bg-background p-2">
                  <p className="font-mono text-xs text-muted-foreground">{`${end.file}:${end.line}`}</p>
                  <p className="mt-0.5 break-words text-sm text-foreground">{end.text}</p>
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    {created.has(key) ? (
                      <span className="text-sm text-muted-foreground">{t('looseEnds.taskCreated')}</span>
                    ) : (
                      <button
                        type="button"
                        disabled={busy === key}
                        onClick={() => void create(end)}
                        className="inline-flex h-11 items-center bg-primary px-4 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-60"
                      >
                        {t('looseEnds.createTask')}
                      </button>
                    )}
                    <button
                      type="button"
                      disabled={busy === key}
                      onClick={() => void leave(end)}
                      className="inline-flex h-11 items-center border border-foreground px-4 text-sm font-medium text-foreground hover:bg-background disabled:opacity-60"
                    >
                      {t('looseEnds.leave')}
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </section>
  );
}
