import { useTranslation } from 'react-i18next';
import { Loader2 } from 'lucide-react';
import { ScrollArea } from '../../ui/scroll-area';
import { MergeRequestItem } from './MergeRequestItem';
import type { GitLabMergeRequest } from '../../../../shared/types';

interface MergeRequestListProps {
  mergeRequests: GitLabMergeRequest[];
  isLoading: boolean;
  selectedMrIid: number | null;
  onSelectMr: (mr: GitLabMergeRequest) => void;
  /** The page's search box (title, branches or number) */
  searchQuery: string;
}

export function MergeRequestList({
  mergeRequests,
  isLoading,
  selectedMrIid,
  onSelectMr,
  searchQuery
}: MergeRequestListProps) {
  const { t } = useTranslation('gitlab');
  const query = searchQuery.toLowerCase();

  const filteredMrs = mergeRequests.filter(
    (mr) =>
      mr.title.toLowerCase().includes(query) ||
      mr.sourceBranch.toLowerCase().includes(query) ||
      mr.targetBranch.toLowerCase().includes(query) ||
      String(mr.iid).includes(searchQuery)
  );

  return (
    <ScrollArea className="flex-1" viewportClassName="[&>div]:!block">
      {isLoading && mergeRequests.length === 0 ? (
        <div className="flex items-center justify-center py-8">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      ) : filteredMrs.length === 0 ? (
        <div className="py-8 text-center text-sm text-muted-foreground">
          {searchQuery ? t('mergeRequests.noMatching') : t('mergeRequests.noneFound')}
        </div>
      ) : (
        <ul>
          {filteredMrs.map((mr) => (
            <MergeRequestItem
              key={mr.id}
              mr={mr}
              isSelected={mr.iid === selectedMrIid}
              onClick={() => onSelectMr(mr)}
            />
          ))}
        </ul>
      )}
    </ScrollArea>
  );
}
