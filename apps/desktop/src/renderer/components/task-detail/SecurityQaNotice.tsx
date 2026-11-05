/**
 * The pentest did not finish. QA's approval stands and the task can be merged, but
 * nothing has tested it for attacks, and the chip alone doesn't say why.
 */

import { useTranslation } from 'react-i18next';
import type { Task } from '../../../shared/types';
import { useSecurityQaError } from './useSecurityQaError';

export function SecurityQaNotice({ task }: { task: Task }) {
  const { t } = useTranslation('tasks');
  const error = useSecurityQaError(task);

  if (!error) return null;

  return (
    <section aria-labelledby="security-qa-error" className="border-l-2 border-l-[var(--vt-signal)] py-1 pl-4">
      <h3 id="security-qa-error" className="text-sm font-semibold text-foreground">{t('securityQa.title')}</h3>
      <p className="mt-0.5 text-sm text-muted-foreground">{t('securityQa.body')}</p>
      {error.reason && <p className="mt-1 break-words font-mono text-xs text-muted-foreground">{error.reason}</p>}
    </section>
  );
}
