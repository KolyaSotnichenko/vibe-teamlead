/**
 * Key facts as a datasheet: one ink frame, hairline rows, label left, value right
 * (mono for data). Rows without data are left out.
 */

import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { ExternalLink } from 'lucide-react';
import { TASK_STATUS_LABELS } from '../../../../shared/constants';
import type { Task } from '../../../../shared/types';
import { cn } from '../../../lib/utils';
import { formatSince } from '../../board/task-stage';
import { SectionHeader } from '../workspace/workspace-ui';

function formatDateTime(value: Date | string | undefined, locale: string): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleString(locale, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

export function TaskFacts({ task }: { task: Task }) {
  const { t, i18n } = useTranslation('tasks');
  const locale = i18n.language;
  const m = task.metadata;

  const rows: Array<{ key: string; label: string; value: ReactNode; mono?: boolean; title?: string }> = [];
  const push = (key: string, value: ReactNode | null | undefined, mono = false, title?: string) => {
    if (value === null || value === undefined || value === '') return;
    rows.push({ key, label: t(`overview.facts.${key}`), value, mono, title });
  };

  push('spec', task.specId, true);
  push('column', t(TASK_STATUS_LABELS[task.status]));
  if (task.location === 'worktree') push('code', t('overview.facts.codeWorktree'));
  else if (m?.useWorktree === false) push('code', t('overview.facts.codeDirect'));
  push('baseBranch', m?.baseBranch, true);
  if (task.stagedInMainProject) push('staged', formatDateTime(task.stagedAt, locale) ?? t('overview.facts.yes'), true);
  push('started', formatDateTime(task.executionProgress?.startedAt, locale), true);
  push('updated', formatSince(task.updatedAt, locale), true, formatDateTime(task.updatedAt, locale) ?? undefined);
  push('created', formatDateTime(task.createdAt, locale), true);
  if (m?.category) push('category', t(`overview.values.category.${m.category}`));
  if (m?.priority) push('priority', t(`overview.values.priority.${m.priority}`));
  if (m?.complexity) push('complexity', t(`overview.values.complexity.${m.complexity}`));
  if (m?.impact) push('impact', t(`overview.values.impact.${m.impact}`));
  if (m?.securitySeverity) push('securitySeverity', t(`overview.values.impact.${m.securitySeverity}`));
  if (m?.sourceType) {
    const ref = m.linearIdentifier ?? (m.githubIssueNumber ? `#${m.githubIssueNumber}` : m.gitlabIssueIid ? `#${m.gitlabIssueIid}` : null);
    push('source', ref ? `${t(`overview.values.source.${m.sourceType}`)} ${ref}` : t(`overview.values.source.${m.sourceType}`));
  }
  if (m?.requireReviewBeforeCoding) push('planApproval', t('overview.facts.required'));
  if (m?.fastMode) push('fastMode', t('overview.facts.on'));
  push('released', task.releasedInVersion ?? m?.archivedInVersion, true);
  if (m?.archivedAt) push('archived', formatDateTime(m.archivedAt, locale), true);

  return (
    <section aria-labelledby="overview-facts">
      <SectionHeader id="overview-facts" title={t('overview.facts.title')} />
      <dl>
        {rows.map((row) => (
          <div key={row.key} className="flex min-h-9 items-baseline justify-between gap-4 border-b border-border py-2">
            <dt className="shrink-0 text-xs text-muted-foreground">{row.label}</dt>
            <dd title={row.title} className={cn('min-w-0 text-right text-[13px] text-foreground [overflow-wrap:anywhere]', row.mono && 'font-mono text-xs')}>
              {row.value}
            </dd>
          </div>
        ))}
        {m?.prUrl && (
          <div className="border-b border-border py-1">
            <button
              type="button"
              onClick={() => m.prUrl && window.electronAPI?.openExternal(m.prUrl)}
              className="flex min-h-11 w-full items-center justify-between gap-3 text-left text-sm font-medium text-foreground underline-offset-2 hover:underline"
            >
              {t('overview.facts.openPr')}
              <ExternalLink aria-hidden className="h-3.5 w-3.5 shrink-0" />
            </button>
          </div>
        )}
      </dl>
    </section>
  );
}
