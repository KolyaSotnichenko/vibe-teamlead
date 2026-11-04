/**
 * The model resolved conflicts in a merge, so the commit waits here: the files
 * it wrote, and the user's decision. The state lives in git, so this comes back
 * after a restart and goes away if the merge ends in a terminal.
 */

import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '../../ui/button';
import type { Task } from '../../../../shared/types';

type DiffLine = { kind: 'hunk' | 'added' | 'removed' | 'context'; text: string };
type Against = 'project' | 'task';

const LINE_STYLE: Record<DiffLine['kind'], string> = {
  hunk: 'text-muted-foreground',
  added: 'text-success',
  removed: 'text-destructive',
  context: 'text-foreground',
};
const LINE_MARK: Record<DiffLine['kind'], string> = { hunk: '', added: '+', removed: '-', context: ' ' };

/** A unified diff of one file as lines, without the headers before its first hunk. Pure. */
export function diffLines(diff: string): DiffLine[] {
  const lines: DiffLine[] = [];
  let inHunk = false;
  for (const line of diff.split('\n')) {
    if (line.startsWith('@@')) {
      inHunk = true;
      lines.push({ kind: 'hunk', text: line });
    } else if (inHunk && line.startsWith('+')) lines.push({ kind: 'added', text: line.slice(1) });
    else if (inHunk && line.startsWith('-')) lines.push({ kind: 'removed', text: line.slice(1) });
    else if (inHunk && line.startsWith(' ')) lines.push({ kind: 'context', text: line.slice(1) });
  }
  return lines;
}

function FileDiff({ task, file }: { task: Task; file: string }) {
  const { t } = useTranslation('tasks');
  const [against, setAgainst] = useState<Against>('project');
  const [result, setResult] = useState<{ diff: string; truncated: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setResult(null);
    setError(null);
    window.electronAPI
      .getMergeReviewDiff(task.id, file, against, task.projectId)
      .then((r) => {
        if (cancelled) return;
        if (r.success && r.data) setResult(r.data);
        else setError(r.error || t('mergeReview.diffFailed'));
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : t('mergeReview.diffFailed'));
      });
    return () => {
      cancelled = true;
    };
  }, [task.id, task.projectId, file, against, t]);

  const lines = result ? diffLines(result.diff) : [];

  return (
    <div className="border-t border-border pb-2">
      <div className="flex flex-wrap gap-2 py-2">
        {(['project', 'task'] as const).map((side) => (
          <Button
            key={side}
            size="sm"
            variant={against === side ? 'default' : 'outline'}
            aria-pressed={against === side}
            onClick={() => setAgainst(side)}
          >
            {t(side === 'project' ? 'mergeReview.againstProject' : 'mergeReview.againstTask')}
          </Button>
        ))}
      </div>
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      {!error && !result && <p className="text-xs text-muted-foreground">{t('mergeReview.loading')}</p>}
      {result && !lines.length && (
        <p className="text-xs text-muted-foreground">{t(result.diff.trim() ? 'mergeReview.cannotShow' : 'mergeReview.noDifference')}</p>
      )}
      {lines.length > 0 && (
        <div className="max-h-96 overflow-auto border border-border font-mono text-xs">
          {lines.map((line, i) => (
            <div key={`${i}-${line.kind}`} className={`flex whitespace-pre px-2 ${LINE_STYLE[line.kind]}`}>
              <span aria-hidden="true" className="w-4 shrink-0 select-none">{LINE_MARK[line.kind]}</span>
              <span>{line.text}</span>
            </div>
          ))}
        </div>
      )}
      {result?.truncated && <p className="mt-1 text-xs text-muted-foreground">{t('mergeReview.truncated')}</p>}
    </div>
  );
}

export function MergeReviewPanel({ task, onMerged }: { task: Task; onMerged?: () => void }) {
  const { t } = useTranslation('tasks');
  const [files, setFiles] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [openFile, setOpenFile] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    window.electronAPI
      ?.getTaskWorkspace?.(task.id, task.projectId)
      .then((r) => {
        if (!cancelled && r?.success) setFiles(r.data?.mergeReview?.files ?? null);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [task.id, task.projectId, task.status]);

  const decide = async (reviewAction: 'commit' | 'cancel') => {
    setBusy(true);
    setError(null);
    try {
      const result = await window.electronAPI.mergeWorktree(task.id, { reviewAction });
      if (!result.success || !result.data?.success) {
        setError(result.data?.message || result.error || t('mergeReview.failed'));
        return;
      }
      setFiles(null);
      if (reviewAction === 'commit') onMerged?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('mergeReview.failed'));
    } finally {
      setBusy(false);
    }
  };

  if (!files) return null;

  return (
    <section aria-labelledby="merge-review" className="border border-foreground">
      <header className="border-b border-l-2 border-b-border border-l-[var(--vt-signal)] px-4 py-3">
        <h3 id="merge-review" className="text-sm font-semibold text-foreground">{t('mergeReview.title')}</h3>
        <p className="mt-0.5 text-sm text-muted-foreground">{t('mergeReview.description')}</p>
      </header>

      <ul className="px-4 py-2">
        {files.map((file) => (
          <li key={file} className="border-b border-border last:border-b-0">
            <button
              type="button"
              aria-expanded={openFile === file}
              onClick={() => setOpenFile(openFile === file ? null : file)}
              className="w-full py-1.5 text-left font-mono text-xs text-foreground hover:underline"
            >
              {file}
            </button>
            {openFile === file && <FileDiff task={task} file={file} />}
          </li>
        ))}
      </ul>

      {error && <p role="alert" className="px-4 pb-2 text-sm text-destructive">{error}</p>}

      <footer className="space-y-2 border-t border-border px-4 py-3">
        <p className="text-xs text-muted-foreground">{t('mergeReview.hint')}</p>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" disabled={busy} onClick={() => void decide('commit')}>{t('mergeReview.commit')}</Button>
          <Button size="sm" variant="outline" disabled={busy} onClick={() => void decide('cancel')}>{t('mergeReview.cancel')}</Button>
        </div>
      </footer>
    </section>
  );
}
