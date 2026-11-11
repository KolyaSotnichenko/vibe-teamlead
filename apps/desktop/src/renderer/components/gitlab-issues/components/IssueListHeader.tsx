import { useTranslation } from 'react-i18next';
import { RefreshCw, Search } from 'lucide-react';
import { Button } from '../../ui/button';
import { Input } from '../../ui/input';
import { SegmentedControl } from '../../ui/segmented-control';
import { HeaderFigure, IntegrationPageHeader, IntegrationToolbar } from '../../shared/integration-page';
import type { FilterState, IssueListHeaderProps } from '../types';

export function IssueListHeader({
  projectPath,
  openIssuesCount,
  isLoading,
  searchQuery,
  filterState,
  onSearchChange,
  onFilterChange,
  onRefresh
}: IssueListHeaderProps) {
  const { t } = useTranslation(['gitlab', 'common']);
  const filters: Array<{ value: FilterState; label: string }> = [
    { value: 'opened', label: t('filters.opened') },
    { value: 'closed', label: t('filters.closed') },
    { value: 'all', label: t('filters.all') },
  ];

  return (
    <>
      <IntegrationPageHeader title={t('title')} subtitle={projectPath}>
        <HeaderFigure>
          {openIssuesCount} {t('header.open')}
        </HeaderFigure>
        <Button
          variant="ghost"
          size="icon"
          onClick={onRefresh}
          disabled={isLoading}
          aria-label={t('common:buttons.refresh')}
          className="text-muted-foreground"
        >
          <RefreshCw className={`h-4 w-4 ${isLoading ? 'animate-spin' : ''}`} aria-hidden="true" />
        </Button>
      </IntegrationPageHeader>

      <IntegrationToolbar>
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
          <Input
            placeholder={t('header.searchPlaceholder')}
            value={searchQuery}
            onChange={(e) => onSearchChange(e.target.value)}
            className="pl-9"
          />
        </div>
        <SegmentedControl label={t('header.filterLabel')} value={filterState} options={filters} onChange={onFilterChange} />
      </IntegrationToolbar>
    </>
  );
}
