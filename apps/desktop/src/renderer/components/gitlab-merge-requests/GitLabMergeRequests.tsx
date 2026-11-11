import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Plus, AlertCircle, RefreshCw, Search } from 'lucide-react';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { SegmentedControl } from '../ui/segmented-control';
import { IntegrationPageHeader, IntegrationToolbar } from '../shared/integration-page';
import { MergeRequestList } from './components/MergeRequestList';
import { MRDetail } from './components/MRDetail';
import { CreateMergeRequestDialog } from './components/CreateMergeRequestDialog';
import { useGitLabMRs } from './hooks/useGitLabMRs';
import { initializeMRReviewListeners } from '../../stores/gitlab';

type MRStateFilter = 'opened' | 'closed' | 'merged' | 'all';

interface GitLabMergeRequestsProps {
  projectId: string;
  onOpenSettings?: () => void;
}

export function GitLabMergeRequests({ projectId, onOpenSettings }: GitLabMergeRequestsProps) {
  const { t } = useTranslation(['gitlab', 'common']);
  const [stateFilter, setStateFilter] = useState<MRStateFilter>('opened');
  const [searchQuery, setSearchQuery] = useState('');
  const [showCreateDialog, setShowCreateDialog] = useState(false);

  // Initialize MR review listeners on mount
  useEffect(() => {
    initializeMRReviewListeners();
  }, []);

  // Use the new hook for MR state management
  const {
    mergeRequests,
    isLoading,
    error,
    selectedMR,
    selectedMRIid,
    reviewResult,
    reviewProgress,
    isReviewing,
    selectMR,
    refresh,
    runReview,
    runFollowupReview,
    checkNewCommits,
    cancelReview,
    postReview,
    postNote,
    mergeMR,
    assignMR,
    approveMR,
  } = useGitLabMRs(projectId, { stateFilter });

  const handleCreateSuccess = async (mrIid: number) => {
    // Refresh the list and select the newly created MR
    await refresh();
    selectMR(mrIid);
  };

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center h-full p-8">
        <AlertCircle className="h-12 w-12 text-destructive mb-4" />
        <p className="text-sm text-muted-foreground text-center">{error}</p>
        <Button variant="outline" onClick={refresh} className="mt-4">
          {t('mergeRequests.tryAgain')}
        </Button>
      </div>
    );
  }

  const filters: Array<{ value: MRStateFilter; label: string }> = (['opened', 'merged', 'closed', 'all'] as const).map(
    (state) => ({ value: state, label: t(`mergeRequests.filters.${state}`) })
  );

  return (
    <div className="flex h-full flex-col">
      <IntegrationPageHeader title={t('mergeRequests.title')}>
        <Button variant="outline" onClick={() => setShowCreateDialog(true)}>
          <Plus className="mr-2 h-4 w-4" aria-hidden="true" />
          {t('mergeRequests.newMR')}
        </Button>
        <Button
          variant="ghost"
          size="icon"
          onClick={refresh}
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
            placeholder={t('mergeRequests.searchPlaceholder')}
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="pl-9"
          />
        </div>
        <SegmentedControl label={t('mergeRequests.filterLabel')} value={stateFilter} options={filters} onChange={setStateFilter} />
      </IntegrationToolbar>

      <div className="flex min-h-0 flex-1">
        {/* List Panel */}
        <div className="flex w-[380px] shrink-0 flex-col border-r border-border">
          <MergeRequestList
            mergeRequests={mergeRequests}
            isLoading={isLoading}
            selectedMrIid={selectedMRIid}
            onSelectMr={(mr) => selectMR(mr.iid)}
            searchQuery={searchQuery}
          />
        </div>

        {/* Detail Panel */}
        <div className="flex min-w-0 flex-1 flex-col">
          {selectedMR ? (
            <MRDetail
              mr={selectedMR}
              reviewResult={reviewResult}
              reviewProgress={reviewProgress}
              isReviewing={isReviewing}
              onRunReview={() => runReview(selectedMR.iid)}
              onRunFollowupReview={() => runFollowupReview(selectedMR.iid)}
              onCheckNewCommits={() => checkNewCommits(selectedMR.iid)}
              onCancelReview={() => cancelReview(selectedMR.iid)}
              onPostReview={(selectedFindingIds) => postReview(selectedMR.iid, selectedFindingIds)}
              onPostNote={(body) => postNote(selectedMR.iid, body)}
              onMergeMR={(mergeMethod) => mergeMR(selectedMR.iid, mergeMethod)}
              onAssignMR={(userIds) => assignMR(selectedMR.iid, userIds)}
              onApproveMR={() => approveMR(selectedMR.iid)}
            />
          ) : (
            <div className="flex items-center justify-center h-full text-muted-foreground">
              {t('mergeRequests.selectMR')}
            </div>
          )}
        </div>
      </div>

      {/* Create Dialog */}
      <CreateMergeRequestDialog
        open={showCreateDialog}
        onOpenChange={setShowCreateDialog}
        projectId={projectId}
        onSuccess={handleCreateSuccess}
      />
    </div>
  );
}
