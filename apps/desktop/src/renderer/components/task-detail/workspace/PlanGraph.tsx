/**
 * Plan dependency graph (@xyflow/react). Lazy-loaded with the Plan tab.
 * Phases run left → right or top → bottom (whichever fits the panel; toggle in the corner); subtasks are nodes whose status is carried by fill + glyph + word.
 */

import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Background,
  BackgroundVariant,
  type Edge,
  Handle,
  MarkerType,
  type Node,
  type NodeProps,
  Panel,
  Position,
  ReactFlow,
  useReactFlow,
} from '@xyflow/react';
import '@xyflow/react/dist/base.css';
import { ArrowDown, ArrowRight, Maximize2, Minus, Plus } from 'lucide-react';
import type { WorkspacePlan, WorkspacePlanSubtask } from '../../../../shared/types';
import { cn } from '../../../lib/utils';
import { bestDirection, layoutPlan, NODE_WIDTH, PHASE_PADDING, type PlanDirection } from './plan-layout';
import { SubtaskStatusLabel } from './workspace-ui';

type PhaseNodeData = { index: number; name: string; done: number; total: number };
type SubtaskNodeData = { subtask: WorkspacePlanSubtask; dimmed: boolean; height: number };
type PhaseNodeType = Node<PhaseNodeData, 'phase'>;
type SubtaskNodeType = Node<SubtaskNodeData, 'subtask'>;

const hiddenHandle = '!h-px !w-px !min-h-0 !min-w-0 !border-0 !bg-transparent';

const PhaseNode = memo(function PhaseNode({ data, width, height }: NodeProps<PhaseNodeType>) {
  const { t } = useTranslation(['tasks']);
  return (
    <div style={{ width, height }} className="border border-border bg-background/60">
      <Handle id="t" type="target" position={Position.Top} className={hiddenHandle} isConnectable={false} />
      <Handle id="l" type="target" position={Position.Left} className={hiddenHandle} isConnectable={false} />
      <div className="flex h-11 items-center justify-between gap-3 border-b border-border" style={{ paddingLeft: PHASE_PADDING, paddingRight: PHASE_PADDING }}>
        <div className="flex min-w-0 items-baseline gap-2">
          <span className="font-mono text-[11px] uppercase tracking-[0.06em] text-muted-foreground">
            {t('tasks:workspace.plan.phaseLabel', { index: data.index + 1 })}
          </span>
          <span className="truncate text-[13px] font-semibold text-foreground">{data.name}</span>
        </div>
        <span className="font-mono text-[11px] text-muted-foreground">
          {data.done}/{data.total}
        </span>
      </div>
      <Handle id="b" type="source" position={Position.Bottom} className={hiddenHandle} isConnectable={false} />
      <Handle id="r" type="source" position={Position.Right} className={hiddenHandle} isConnectable={false} />
    </div>
  );
});

const SubtaskNode = memo(function SubtaskNode({ data, selected }: NodeProps<SubtaskNodeType>) {
  const { subtask, dimmed } = data;
  const s = subtask.status;
  const inverted = s === 'completed';
  return (
    <div
      style={{ width: NODE_WIDTH, height: data.height }}
      title={subtask.title}
      className={cn(
        'relative flex flex-col gap-1.5 px-3 py-2.5 transition-opacity',
        s === 'completed' && 'border border-primary bg-primary text-primary-foreground',
        s === 'in_progress' && 'border border-foreground bg-card text-foreground',
        s === 'pending' && 'border border-dashed border-muted-foreground/60 bg-background text-foreground',
        s === 'blocked' && 'border border-border bg-accent text-foreground',
        s === 'failed' && 'border border-destructive bg-card text-foreground',
        // Selection is not an attention signal: ink/paper outline, never vermilion
        selected && 'outline outline-2 outline-offset-2 outline-foreground',
        dimmed && 'opacity-40'
      )}
    >
      {s === 'in_progress' && <span aria-hidden="true" className="absolute inset-x-0 top-0 h-[3px] bg-foreground" />}
      {s === 'failed' && <span aria-hidden="true" className="absolute inset-y-0 left-0 w-[3px] bg-destructive" />}
      <Handle id="l" type="target" position={Position.Left} className={hiddenHandle} isConnectable={false} />
      <div className="flex items-center justify-between gap-2">
        <span className={cn('truncate font-mono text-[11px]', inverted ? 'text-primary-foreground/75' : 'text-muted-foreground')}>
          {subtask.id}
        </span>
        <SubtaskStatusLabel status={s} inverted={inverted} />
      </div>
      <p className="line-clamp-3 text-[13px] font-medium leading-[18px]">{subtask.title}</p>
      {subtask.acIds.length > 0 && (
        <div className="mt-auto flex flex-wrap gap-1">
          {subtask.acIds.map((ac) => (
            <span
              key={ac}
              className={cn(
                'inline-flex h-[18px] items-center border px-1 font-mono text-[10px]',
                inverted ? 'border-primary-foreground/40 text-primary-foreground' : 'border-border text-muted-foreground'
              )}
            >
              {ac}
            </span>
          ))}
        </div>
      )}
      <Handle id="r" type="source" position={Position.Right} className={hiddenHandle} isConnectable={false} />
      <Handle id="b" type="source" position={Position.Bottom} className={hiddenHandle} isConnectable={false} />
    </div>
  );
});

const nodeTypes = { phase: PhaseNode, subtask: SubtaskNode };

function ZoomControls({ direction, onDirection }: { direction: PlanDirection; onDirection: (d: PlanDirection) => void }) {
  const { zoomIn, zoomOut, fitView } = useReactFlow();
  const { t } = useTranslation(['tasks']);
  const btn =
    'flex h-11 w-11 items-center justify-center text-foreground hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring';
  return (
    <Panel position="bottom-right" className="!m-3 flex border border-foreground bg-card">
      <button type="button" className={btn} onClick={() => zoomOut()} aria-label={t('tasks:workspace.plan.zoomOut')}>
        <Minus className="h-4 w-4" />
      </button>
      <button type="button" className={cn(btn, 'border-x border-border')} onClick={() => zoomIn()} aria-label={t('tasks:workspace.plan.zoomIn')}>
        <Plus className="h-4 w-4" />
      </button>
      <button type="button" className={btn} onClick={() => fitView({ padding: 0.12 })} aria-label={t('tasks:workspace.plan.fitView')}>
        <Maximize2 className="h-4 w-4" />
      </button>
      <button
        type="button"
        className={cn(btn, 'border-l border-border')}
        onClick={() => onDirection(direction === 'LR' ? 'TB' : 'LR')}
        aria-label={direction === 'LR' ? t('tasks:workspace.plan.layoutTopDown') : t('tasks:workspace.plan.layoutLeftRight')}
        title={direction === 'LR' ? t('tasks:workspace.plan.layoutTopDown') : t('tasks:workspace.plan.layoutLeftRight')}
      >
        {direction === 'LR' ? <ArrowDown className="h-4 w-4" /> : <ArrowRight className="h-4 w-4" />}
      </button>
    </Panel>
  );
}

/** Re-fit when the direction changes: the whole graph moves. */
function FitOnChange({ direction }: { direction: PlanDirection }) {
  const { fitView } = useReactFlow();
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    const id = requestAnimationFrame(() => fitView({ padding: 0.08, maxZoom: 1 }));
    return () => cancelAnimationFrame(id);
  }, [direction, fitView]);
  return null;
}

interface PlanGraphProps {
  plan: WorkspacePlan;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
}

export function PlanGraph({ plan, selectedId, onSelect }: PlanGraphProps) {
  const { t } = useTranslation(['tasks']);
  const sectionRef = useRef<HTMLElement>(null);
  const [viewWidth, setViewWidth] = useState(1000);
  // null = automatic: whichever direction shows the plan larger in this panel
  const [chosen, setChosen] = useState<PlanDirection | null>(null);
  useLayoutEffect(() => {
    const el = sectionRef.current;
    if (!el) return;
    setViewWidth(el.clientWidth || 1000);
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => setViewWidth(el.clientWidth || 1000)) : null;
    ro?.observe(el);
    return () => ro?.disconnect();
  }, []);
  const direction = chosen ?? bestDirection(plan, viewWidth, 600);
  const layout = useMemo(() => layoutPlan(plan, direction), [plan, direction]);

  const related = useMemo(() => {
    if (!selectedId) return null;
    const set = new Set<string>([selectedId]);
    for (const phase of plan.phases)
      for (const s of phase.subtasks) {
        if (s.id === selectedId) for (const d of s.dependsOn) set.add(d);
        if (s.dependsOn.includes(selectedId)) set.add(s.id);
      }
    return set;
  }, [plan, selectedId]);

  const nodes = useMemo<Array<PhaseNodeType | SubtaskNodeType>>(() => {
    const out: Array<PhaseNodeType | SubtaskNodeType> = [];
    for (const phase of layout.phases) {
      out.push({
        id: `phase:${phase.id}`,
        type: 'phase',
        position: { x: phase.x, y: phase.y },
        width: phase.width,
        height: phase.height,
        data: {
          index: phase.index,
          name: phase.name,
          done: phase.subtasks.filter((s) => s.subtask.status === 'completed').length,
          total: phase.subtasks.length,
        },
        selectable: false,
        focusable: false,
        draggable: false,
        zIndex: 0,
      });
    }
    for (const phase of layout.phases) {
      for (const { subtask, x, y, height } of phase.subtasks) {
        out.push({
          id: subtask.id,
          type: 'subtask',
          parentId: `phase:${phase.id}`,
          extent: 'parent',
          position: { x, y },
          width: NODE_WIDTH,
          height,
          data: { subtask, dimmed: related !== null && !related.has(subtask.id), height },
          selected: subtask.id === selectedId,
          draggable: false,
          ariaLabel: `${subtask.id} ${subtask.title}, ${t(`tasks:workspace.subtaskStatus.${subtask.status}`)}`,
          zIndex: 1,
        });
      }
    }
    return out;
  }, [layout, related, selectedId, t]);

  const edges = useMemo<Edge[]>(() => {
    const out: Edge[] = [];
    const phaseOf = new Map<string, string>();
    for (const phase of plan.phases) for (const s of phase.subtasks) phaseOf.set(s.id, phase.id);
    const linkedPhases = new Set<string>();

    for (const phase of plan.phases) {
      for (const s of phase.subtasks) {
        for (const dep of s.dependsOn) {
          const crossPhase = phaseOf.get(dep) !== phase.id;
          if (crossPhase) linkedPhases.add(`${phaseOf.get(dep)}->${phase.id}`);
          const touchesSelection = dep === selectedId || s.id === selectedId;
          const active = related === null || touchesSelection;
          out.push({
            id: `e:${dep}->${s.id}`,
            source: dep,
            target: s.id,
            sourceHandle: crossPhase && direction === 'TB' ? 'b' : 'r',
            targetHandle: 'l',
            type: 'smoothstep',
            style: { stroke: 'var(--foreground)', strokeWidth: related && touchesSelection ? 2 : 1, opacity: active ? 1 : 0.2 },
            markerEnd: { type: MarkerType.ArrowClosed, color: 'var(--foreground)', width: 14, height: 14 },
            focusable: false,
            selectable: false,
            zIndex: 2,
          });
        }
      }
    }
    // Phase-level ordering, only where no subtask edge already shows it
    for (const phase of plan.phases) {
      for (const dep of phase.dependsOn) {
        if (linkedPhases.has(`${dep}->${phase.id}`)) continue;
        out.push({
          id: `pe:${dep}->${phase.id}`,
          source: `phase:${dep}`,
          target: `phase:${phase.id}`,
          sourceHandle: direction === 'LR' ? 'r' : 'b',
          targetHandle: direction === 'LR' ? 'l' : 't',
          type: 'smoothstep',
          style: { stroke: 'var(--muted-foreground)', strokeWidth: 1, strokeDasharray: '4 4' },
          markerEnd: { type: MarkerType.ArrowClosed, color: 'var(--muted-foreground)', width: 14, height: 14 },
          focusable: false,
          selectable: false,
          zIndex: 0,
        });
      }
    }
    return out;
  }, [plan, related, selectedId, direction]);

  const onNodeClick = useCallback(
    (_: unknown, node: Node) => {
      if (node.type === 'subtask') onSelect(node.id === selectedId ? null : node.id);
    },
    [onSelect, selectedId]
  );

  // Tall enough to show the whole plan at 100% when it fits; pan for larger plans
  const height = Math.min(640, Math.max(280, layout.height + 64));

  return (
    <section ref={sectionRef} style={{ height }} className="vt-plan-graph border border-foreground bg-background" aria-label={t('tasks:workspace.plan.graphLabel')}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodeClick={onNodeClick}
        onPaneClick={() => onSelect(null)}
        onNodesChange={(changes) => {
          // Keyboard selection (Enter on a focused node) arrives as a select change
          for (const change of changes) {
            if (change.type === 'select' && change.selected && change.id !== selectedId) onSelect(change.id);
          }
        }}
        nodesDraggable={false}
        nodesConnectable={false}
        edgesFocusable={false}
        fitView
        fitViewOptions={{ padding: 0.08, maxZoom: 1 }}
        minZoom={0.3}
        maxZoom={1.5}
        proOptions={{ hideAttribution: true }}
        // Wheel scrolls the surrounding page; drag pans, buttons zoom
        zoomOnScroll={false}
        preventScrolling={false}
      >
        <Background variant={BackgroundVariant.Dots} gap={16} size={1} color="var(--border)" />
        <FitOnChange direction={direction} />
        <ZoomControls direction={direction} onDirection={setChosen} />
      </ReactFlow>
    </section>
  );
}

export default PlanGraph;
