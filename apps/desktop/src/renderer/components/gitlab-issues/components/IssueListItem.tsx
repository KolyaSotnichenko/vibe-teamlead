import { Sparkles } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '../../ui/button';
import { cn } from '../../../lib/utils';
import { MetaLine, listRowClass } from '../../shared/integration-page';
import { formatDate } from '../utils';
import type { IssueListItemProps } from '../types';

export function IssueListItem({ issue, isSelected, onClick, onInvestigate }: IssueListItemProps) {
  const { t, i18n } = useTranslation('gitlab');
  return (
    <li className="group relative">
      <button
        type="button"
        aria-current={isSelected ? 'true' : undefined}
        className={cn(listRowClass(isSelected), 'pr-12')}
        onClick={onClick}
      >
        <span className="block truncate text-sm font-medium text-foreground">{issue.title}</span>
        <MetaLine
          className="mt-0.5"
          parts={[
            `#${issue.iid}`,
            issue.author.username,
            formatDate(issue.createdAt, i18n.language),
            issue.userNotesCount > 0 && `${issue.userNotesCount} ${t('detail.notes')}`,
          ]}
        />
      </button>
      <Button
        variant="ghost"
        size="icon"
        className="absolute right-3 top-1/2 h-8 w-8 -translate-y-1/2 opacity-0 transition-opacity focus:opacity-100 group-hover:opacity-100"
        onClick={onInvestigate}
        aria-label={t('investigation.investigateIssue')}
      >
        <Sparkles className="h-4 w-4" aria-hidden="true" />
      </Button>
    </li>
  );
}
