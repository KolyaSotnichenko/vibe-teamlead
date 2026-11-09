/**
 * Preview → UX review: one agent session goes through the running app as a person would
 * and lists what stops people, blocking problems first. Each finding can become a task,
 * or every blocking one a single task.
 */

import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2 } from 'lucide-react';

import type { UxFinding, UxReviewResult } from '../../../shared/types';
import { createTask } from '../../stores/task-store';
import { Button } from '../ui/button';

const short = (text: string, max = 70) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

function findingLines(finding: UxFinding, n: number): string[] {
  return [
    `### ${n}. \`${finding.page}\` at ${finding.width} px`,
    '',
    `- **What happens:** ${finding.problem}`,
    `- **What it should do:** ${finding.expected}`,
    ...(finding.file ? [`- **File:** \`${finding.file}\``] : []),
  ];
}

const criterion = (finding: UxFinding, n: number) => `- AC-${n}: On \`${finding.page}\` at ${finding.width} px, ${finding.expected}`;

/** One finding as a task. Pure. */
export function findingTask(finding: UxFinding): { title: string; description: string } {
  return {
    title: `UX: ${short(finding.problem)} (${finding.page})`,
    description: ['The UX review of the running app found this.', '', ...findingLines(finding, 1), '', '## Acceptance criteria', '', criterion(finding, 1)].join('\n'),
  };
}

/** Several findings as one task, each its own acceptance criterion. Pure. */
export function findingsTask(findings: UxFinding[]): { title: string; description: string } {
  return {
    title: `UX: fix ${findings.length} problem${findings.length === 1 ? '' : 's'} the UX review found`,
    description: [
      'The UX review of the running app found these.',
      '',
      ...findings.flatMap((finding, i) => [...findingLines(finding, i + 1), '']),
      '## Acceptance criteria',
      '',
      ...findings.map((finding, i) => criterion(finding, i + 1)),
    ].join('\n'),
  };
}

export function UxReviewPanel({ projectId, ready }: { projectId: string; ready: boolean }) {
  const { t } = useTranslation(['tasks']);
  const [review, setReview] = useState<UxReviewResult | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<Set<number>>(new Set());
  const [allCreated, setAllCreated] = useState(false);

  useEffect(() => {
    let live = true;
    void window.electronAPI.preview.lastUxReview(projectId).then((result) => {
      if (live && result.success && result.data) setReview(result.data);
    });
    return () => {
      live = false;
    };
  }, [projectId]);

  const run = async () => {
    setRunning(true);
    setError(null);
    try {
      const result = await window.electronAPI.preview.uxReview(projectId);
      if (result.success && result.data) {
        setReview(result.data);
        setCreated(new Set());
        setAllCreated(false);
      } else setError(result.error ?? t('preview.ux.failed'));
    } finally {
      setRunning(false);
    }
  };

  const findings = review ? [...review.findings].sort((a, b) => Number(a.severity === 'note') - Number(b.severity === 'note')) : [];
  const blocking = findings.filter((f) => f.severity === 'blocks');

  const make = async (index: number) => {
    const { title, description } = findingTask(findings[index]);
    if (await createTask(projectId, title, description)) setCreated((prev) => new Set(prev).add(index));
  };
  const makeAll = async () => {
    const { title, description } = findingsTask(blocking);
    if (await createTask(projectId, title, description)) setAllCreated(true);
  };

  return (
    <div className="flex h-full flex-col">
      <div className="space-y-2 border-b border-border p-3">
        <p className="text-sm text-muted-foreground">{t('preview.ux.intro')}</p>
        {running ? (
          <div className="flex items-center gap-2">
            <Loader2 aria-hidden className="h-4 w-4 animate-spin" />
            <span className="flex-1 text-sm">{t('preview.ux.running')}</span>
            <Button size="sm" variant="outline" onClick={() => void window.electronAPI.preview.cancelUxReview()}>
              {t('preview.ux.stop')}
            </Button>
          </div>
        ) : (
          <Button size="sm" disabled={!ready} onClick={() => void run()}>
            {t('preview.ux.run')}
          </Button>
        )}
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      </div>
      {review && (
        <div className="min-h-0 flex-1 overflow-auto p-3">
          <p className="text-sm text-foreground">{review.summary}</p>
          <p className="mt-1 text-xs text-muted-foreground">{t('preview.ux.pages', { count: review.pages.length, at: new Date(review.at).toLocaleString() })}</p>
          {blocking.length > 0 && (
            <div className="mt-3">
              {allCreated ? (
                <p className="text-sm text-muted-foreground">{t('preview.ux.taskCreated')}</p>
              ) : (
                <Button size="sm" onClick={() => void makeAll()}>
                  {t('preview.ux.createAll', { count: blocking.length })}
                </Button>
              )}
            </div>
          )}
          {findings.length === 0 && <p className="mt-3 text-sm text-muted-foreground">{t('preview.ux.none')}</p>}
          <ul className="mt-3 space-y-2">
            {findings.map((finding, index) => (
              <li key={`${finding.page}-${finding.width}-${finding.problem}`} className={`border bg-background p-2 ${finding.severity === 'blocks' ? 'border-l-[3px] border-[var(--vt-signal)]' : 'border-border'}`}>
                <p className="font-mono text-xs text-muted-foreground">
                  {`${finding.page} · ${finding.width}px · ${t(`preview.ux.severity.${finding.severity}`)}`}
                </p>
                <p className="mt-1 text-sm text-foreground">{finding.problem}</p>
                <p className="mt-0.5 text-sm text-muted-foreground">{finding.expected}</p>
                {finding.file && <p className="mt-0.5 break-all font-mono text-xs text-muted-foreground">{finding.file}</p>}
                <div className="mt-2">
                  {created.has(index) ? (
                    <span className="text-sm text-muted-foreground">{t('preview.ux.taskCreated')}</span>
                  ) : (
                    <Button size="sm" variant="outline" onClick={() => void make(index)}>
                      {t('preview.ux.createTask')}
                    </Button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
