import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';

import { toast } from '../hooks/use-toast';

/** Tells the user the Mac slept while agents worked. Nobody is looking when it wakes, so it stays until closed. */
export function SleepWarning() {
  const { t } = useTranslation('common');

  useEffect(() => {
    let shown: ReturnType<typeof toast> | undefined;
    return window.electronAPI.onSleptWhileRunning?.(({ tasks }) => {
      shown?.dismiss();
      shown = toast({
        title: t('sleepWarning.title'),
        description: t('sleepWarning.description', { count: tasks }),
        duration: Number.POSITIVE_INFINITY,
      });
    });
  }, [t]);

  return null;
}
