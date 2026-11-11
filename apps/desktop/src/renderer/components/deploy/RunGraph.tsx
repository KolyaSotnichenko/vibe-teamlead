/**
 * Deploy → Runs: the selected run as columns of jobs per stage, connected left to right.
 * Queued = outline, running = turning mark + progress bar, success = ink ✓, failure = vermilion ✕.
 * The line into a running column animates; reduced motion stills every animation.
 */
import { Fragment } from 'react';
import { useTranslation } from 'react-i18next';
import type { DeployJob, GraphNode, RunGraph as RunGraphData } from '../../../shared/types/deploy';
import { cn } from '../../lib/utils';
import { StatusMark, formatDuration, formatRelative } from './status';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '../ui/tooltip';

interface RunGraphProps {
  graph: RunGraphData;
  /** The run's jobs, to name the jobs behind a node that folds several (matrix, reusable workflow) */
  jobs: DeployJob[];
  selectedKey?: string;
  onSelect: (node: GraphNode) => void;
}

function useStageLabel() {
  const { t } = useTranslation(['deploy']);
  return (stage: string): string => {
    const level = /^level-(\d+)$/.exec(stage);
    if (level) return t('deploy:graph.stage', { n: Number(level[1]) });
    if (stage === 'deploy') return t('deploy:graph.deploy');
    return t('deploy:graph.other');
  };
}

type ConnectorState = 'idle' | 'done' | 'live';

function connectorState(prev: GraphNode[], next: GraphNode[]): ConnectorState {
  if (next.some((n) => n.status === 'running')) return 'live';
  if (prev.length > 0 && prev.every((n) => n.status === 'success' || n.status === 'skipped')) return 'done';
  return 'idle';
}

/** The top of the line sits at the middle of a column's first node (label 16px + gap 8px + half a 40px node). */
function Connector({ state }: { state: ConnectorState }) {
  return (
    <div data-connector={state} aria-hidden="true" className="relative w-8 shrink-0 self-stretch">
      <span className={cn('absolute left-0 right-0 top-[44px] h-0.5', state === 'done' ? 'bg-foreground' : 'bg-border')} />
      {state === 'live' && <span className="vt-deploy-line absolute left-0 top-[44px] h-0.5 bg-foreground" />}
    </div>
  );
}

/** What a node stands for beyond its label: the jobs behind it, and when a deployment went live. */
function useNodeDetails() {
  const { t, i18n } = useTranslation(['deploy']);
  return (node: GraphNode, jobs: DeployJob[]): string[] => {
    const details: string[] = [];
    const names = node.jobIds.map((id) => jobs.find((j) => j.id === id)?.name).filter((n): n is string => !!n);
    // Several jobs folded into one node, or a single job whose name differs from the label (e.g. "Image …")
    if (names.length > 1 || (names.length === 1 && names[0] !== node.label)) details.push(...names);
    // Only a deployment that is live: not while it is still queued or running
    if (node.deployedAt && node.status !== 'running' && node.status !== 'queued') {
      const ago = formatRelative(node.deployedAt, i18n.language);
      if (ago) details.push(t('deploy:graph.deployed', { ago }));
    }
    return details;
  };
}

function NodeButton({ node, details, selected, onSelect }: { node: GraphNode; details: string[]; selected: boolean; onSelect: () => void }) {
  const { t } = useTranslation(['deploy']);
  const duration = formatDuration(node.startedAt, node.completedAt);
  const label = [node.label, t(`deploy:status.${node.status}`), duration, ...details].filter(Boolean).join(', ');
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          data-status={node.status}
          aria-pressed={selected}
          aria-label={label}
          onClick={onSelect}
          className={cn(
            'relative flex min-h-10 w-full items-center gap-2 overflow-hidden border bg-card px-2.5 py-2 text-left text-sm transition-colors',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
            node.status === 'running' && 'border-foreground',
            node.status === 'failure' && 'border-destructive',
            node.status !== 'running' && node.status !== 'failure' && 'border-border',
            (node.status === 'queued' || node.status === 'skipped' || node.status === 'cancelled') && 'text-muted-foreground',
            selected ? 'bg-accent' : 'hover:bg-muted'
          )}
        >
          <StatusMark status={node.status} />
          <span className="line-clamp-2 min-w-0 flex-1 break-words">{node.label}</span>
          {duration && <span className="shrink-0 font-mono text-[11px] text-muted-foreground">{duration}</span>}
          {node.status === 'running' && (
            <span data-progress aria-hidden="true" className="vt-deploy-progress absolute bottom-0 left-0 h-0.5 bg-foreground" />
          )}
        </button>
      </TooltipTrigger>
      {/* Design system: tooltips are an ink plate, mono 12px, paper text */}
      <TooltipContent
        side="bottom"
        className="max-w-xs rounded-none border-0 bg-[var(--vt-ink)] font-mono text-xs text-[var(--vt-paper)] shadow-none"
      >
        <span className="block break-words">{node.label}</span>
        {details.map((d) => (
          <span key={d} className="block break-words opacity-80">
            {d}
          </span>
        ))}
      </TooltipContent>
    </Tooltip>
  );
}

export function RunGraph({ graph, jobs, selectedKey, onSelect }: RunGraphProps) {
  const stageLabel = useStageLabel();
  const nodeDetails = useNodeDetails();
  return (
    <TooltipProvider delayDuration={300}>
    <div className="flex items-start overflow-x-auto pb-1">
      {graph.columns.map((column, i) => (
        <Fragment key={column.stage}>
          {i > 0 && <Connector state={connectorState(graph.columns[i - 1].nodes, column.nodes)} />}
          <div className="flex min-w-[180px] flex-col gap-2">
            <div className="h-4 font-mono text-[11px] font-medium uppercase tracking-[0.06em] text-muted-foreground">
              {stageLabel(column.stage)}
            </div>
            {column.nodes.map((node) => (
              <NodeButton key={node.key} node={node} details={nodeDetails(node, jobs)} selected={node.key === selectedKey} onSelect={() => onSelect(node)} />
            ))}
          </div>
        </Fragment>
      ))}
    </div>
    </TooltipProvider>
  );
}
