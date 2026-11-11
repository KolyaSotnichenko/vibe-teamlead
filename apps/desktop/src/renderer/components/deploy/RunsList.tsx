/**
 * Deploy → Runs: the list of GitHub Actions runs (status, commit title, #number · branch · time).
 */
import { useTranslation } from 'react-i18next';
import type { DeployRun } from '../../../shared/types/deploy';
import { cn } from '../../lib/utils';
import { StatusMark, formatRelative, toNodeStatus } from './status';

interface RunsListProps {
  runs: DeployRun[];
  selectedId?: number;
  onSelect: (runId: number) => void;
}

export function RunsList({ runs, selectedId, onSelect }: RunsListProps) {
  const { t, i18n } = useTranslation(['deploy']);
  return (
    <ul aria-label={t('deploy:runs.listLabel')} className="border border-border">
      {runs.map((run) => {
        const selected = run.id === selectedId;
        return (
          <li key={run.id} className="border-b border-border last:border-b-0">
            <button
              type="button"
              aria-current={selected ? 'true' : undefined}
              onClick={() => onSelect(run.id)}
              className={cn(
                'flex min-h-11 w-full items-start gap-2.5 px-3 py-2.5 text-left text-sm transition-colors',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset',
                selected ? 'bg-accent text-foreground' : 'text-foreground hover:bg-muted'
              )}
            >
              <StatusMark status={toNodeStatus(run.status, run.conclusion)} className="mt-0.5" />
              <span className="min-w-0 flex-1">
                <span className="block truncate">{run.title}</span>
                <span className="block truncate font-mono text-xs text-muted-foreground">
                  {[run.number > 0 ? `#${run.number}` : null, run.branch, formatRelative(run.startedAt, i18n.language)].filter(Boolean).join(' · ')}
                </span>
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
