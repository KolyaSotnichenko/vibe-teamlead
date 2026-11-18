/**
 * At the app's level: the offer to merge the tasks QA approved that already wait, raised when
 * auto-merge is turned on (Settings → Project → Queue, `lib/queue-settings.ts`).
 */
import type { Task } from '../../../shared/types';
import { getAutoMerge } from '../../hooks/useAutoMerge';
import { useMergeWaitingStore } from '../../lib/queue-settings';
import { MergeWaitingDialog } from './MergeWaitingDialog';

export function MergeWaitingOffer() {
  const tasks = useMergeWaitingStore((state) => state.tasks);
  const dismiss = useMergeWaitingStore((state) => state.dismiss);
  return (
    <MergeWaitingDialog
      tasks={tasks}
      onMerge={(waiting) => void getAutoMerge()?.mergeNow(waiting as Task[])}
      onClose={dismiss}
    />
  );
}
