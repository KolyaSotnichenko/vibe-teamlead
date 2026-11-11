import { Sparkles } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '../../ui/button';
import { MetaLine, listRowClass } from '../../shared/integration-page';
import { formatDate } from '../utils';
import type { IssueListItemProps } from '../types';

export function IssueListItem({ issue, isSelected, onClick, onInvestigate }: IssueListItemProps) {
  const { t } = useTranslation('common');
  return (
    <li className="group relative">
      <button
        type="button"
        aria-current={isSelected ? 'true' : undefined}
        className={listRowClass(isSelected)}
        onClick={onClick}
      >
        <span className="block truncate pr-8 text-sm font-medium text-foreground">{issue.title}</span>
        <MetaLine
          className="mt-0.5"
          parts={[
            `#${issue.number}`,
            issue.author.login,
            formatDate(issue.createdAt),
            issue.commentsCount > 0 && t('issues.detail.comments', { count: issue.commentsCount }),
          ]}
        />
      </button>
      <Button
        variant="ghost"
        size="icon"
        className="absolute right-3 top-1/2 h-8 w-8 -translate-y-1/2 opacity-0 transition-opacity focus:opacity-100 group-hover:opacity-100"
        onClick={onInvestigate}
        aria-label={t('issues.investigation.title')}
      >
        <Sparkles className="h-4 w-4" aria-hidden="true" />
      </Button>
    </li>
  );
}
