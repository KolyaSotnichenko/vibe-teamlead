import { GitMerge, GitPullRequest, Lock, ExternalLink } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { cn } from '../../../lib/utils';
import { formatDate } from '../../../lib/format-date';
import { MetaLine, listRowClass } from '../../shared/integration-page';
import type { GitLabMergeRequest } from '../../../../shared/types';

interface MergeRequestItemProps {
  mr: GitLabMergeRequest;
  isSelected: boolean;
  onClick: () => void;
}

const stateColors = {
  opened: 'text-success',
  closed: 'text-destructive',
  merged: 'text-info',
  locked: 'text-warning'
};

const stateIcons = {
  opened: GitPullRequest,
  closed: GitPullRequest,
  merged: GitMerge,
  locked: Lock
};

export function MergeRequestItem({ mr, isSelected, onClick }: MergeRequestItemProps) {
  const { t, i18n } = useTranslation(['gitlab', 'common']);
  const StateIcon = stateIcons[mr.state] || GitPullRequest;

  return (
    <li className="group relative">
      <button
        type="button"
        aria-current={isSelected ? 'true' : undefined}
        onClick={onClick}
        className={listRowClass(isSelected)}
      >
        <span className="flex items-start gap-2 pr-8">
          <StateIcon className={cn('mt-0.5 h-4 w-4 shrink-0', stateColors[mr.state])} aria-hidden="true" />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-medium text-foreground">{mr.title}</span>
            <MetaLine className="mt-0.5" parts={[`!${mr.iid}`, mr.author.username, formatDate(mr.createdAt, i18n.language)]} />
            <span className="mt-0.5 block truncate font-mono text-xs text-muted-foreground">{`${mr.sourceBranch} → ${mr.targetBranch}`}</span>
            {mr.labels.length > 0 && (
              <span className="mt-1 flex items-center gap-2">
                {mr.labels.slice(0, 3).map((label) => (
                  <span key={label} className="bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
                    {label}
                  </span>
                ))}
                {mr.labels.length > 3 && <span className="text-xs text-muted-foreground">+{mr.labels.length - 3}</span>}
              </span>
            )}
          </span>
        </span>
      </button>
      <a
        href={mr.webUrl}
        target="_blank"
        rel="noopener noreferrer"
        aria-label={t('common:accessibility.openOnGitLabAriaLabel')}
        className="absolute right-4 top-3 text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <ExternalLink className="h-4 w-4" aria-hidden="true" />
      </a>
    </li>
  );
}
