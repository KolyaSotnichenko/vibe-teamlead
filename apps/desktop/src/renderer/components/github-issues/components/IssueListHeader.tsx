import { useTranslation } from 'react-i18next';
import { RefreshCw, Search, Loader2, Layers } from 'lucide-react';
import { Button } from '../../ui/button';
import { Input } from '../../ui/input';
import { Switch } from '../../ui/switch';
import { Label } from '../../ui/label';
import { SegmentedControl } from '../../ui/segmented-control';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '../../ui/tooltip';
import { HeaderFigure, IntegrationPageHeader, IntegrationToolbar } from '../../shared/integration-page';
import type { FilterState, IssueListHeaderProps } from '../types';

export function IssueListHeader({
  repoFullName,
  openIssuesCount,
  isLoading,
  searchQuery,
  filterState,
  onSearchChange,
  onFilterChange,
  onRefresh,
  autoFixEnabled,
  autoFixRunning,
  autoFixProcessing,
  onAutoFixToggle,
  onAnalyzeAndGroup,
  isAnalyzing,
}: IssueListHeaderProps) {
  const { t } = useTranslation('common');
  const filters: Array<{ value: FilterState; label: string }> = [
    { value: 'open', label: t('issues.header.filterOpen') },
    { value: 'closed', label: t('issues.header.filterClosed') },
    { value: 'all', label: t('issues.header.filterAll') },
  ];

  return (
    <TooltipProvider>
      <IntegrationPageHeader title={t('issues.header.title')} subtitle={repoFullName}>
        <HeaderFigure>{t('issues.header.openCount', { count: openIssuesCount })}</HeaderFigure>

        {/* Auto-Fix Toggle (Reactive) */}
        {onAutoFixToggle && (
          <Tooltip>
            <TooltipTrigger asChild>
              <div className="flex items-center gap-2">
                {autoFixRunning && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" aria-hidden="true" />}
                <Switch
                  id="auto-fix-toggle"
                  checked={autoFixEnabled ?? false}
                  onCheckedChange={onAutoFixToggle}
                  disabled={autoFixRunning}
                />
                <Label htmlFor="auto-fix-toggle" className="cursor-pointer whitespace-nowrap text-sm text-muted-foreground">
                  {t('issues.header.autoFixNew')}
                </Label>
              </div>
            </TooltipTrigger>
            <TooltipContent side="bottom" className="max-w-xs">
              <p>{t('issues.header.autoFixTooltip')}</p>
              {autoFixRunning && autoFixProcessing !== undefined && autoFixProcessing > 0 && (
                <p className="mt-1">{t('issues.header.processingIssues', { count: autoFixProcessing })}</p>
              )}
            </TooltipContent>
          </Tooltip>
        )}

        {/* Analyze & Group (Proactive) */}
        {onAnalyzeAndGroup && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="outline" onClick={onAnalyzeAndGroup} disabled={isAnalyzing || isLoading}>
                {isAnalyzing ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />
                ) : (
                  <Layers className="mr-2 h-4 w-4" aria-hidden="true" />
                )}
                {t('issues.batchReview.title')}
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom" className="max-w-xs">
              <p>{t('issues.header.analyzeTooltip')}</p>
            </TooltipContent>
          </Tooltip>
        )}

        <Button
          variant="ghost"
          size="icon"
          onClick={onRefresh}
          disabled={isLoading}
          aria-label={t('buttons.refresh')}
          className="text-muted-foreground"
        >
          <RefreshCw className={`h-4 w-4 ${isLoading ? 'animate-spin' : ''}`} aria-hidden="true" />
        </Button>
      </IntegrationPageHeader>

      <IntegrationToolbar>
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
          <Input
            placeholder={t('issues.header.searchPlaceholder')}
            value={searchQuery}
            onChange={(e) => onSearchChange(e.target.value)}
            className="pl-9"
          />
        </div>
        <SegmentedControl label={t('issues.header.filterLabel')} value={filterState} options={filters} onChange={onFilterChange} />
      </IntegrationToolbar>
    </TooltipProvider>
  );
}
