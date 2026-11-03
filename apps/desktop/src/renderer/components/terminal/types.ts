import type { SyntheticListenerMap } from '@dnd-kit/core/dist/hooks/utilities';
import type { Task, ExecutionPhase } from '../../../shared/types';
import type { TerminalStatus } from '../../stores/terminal-store';
import { Circle, Search, Code2, Wrench, CheckCircle2, AlertCircle, PauseCircle, KeyRound } from 'lucide-react';

export interface TerminalProps {
  id: string;
  cwd?: string;
  projectPath?: string;
  isActive: boolean;
  onClose: () => void;
  onActivate: () => void;
  tasks?: Task[];
  onNewTaskClick?: () => void;
  terminalCount?: number;
  /** Drag handle listeners from useSortable for terminal reordering */
  dragHandleListeners?: SyntheticListenerMap;
  /** Whether this terminal is currently being dragged */
  isDragging?: boolean;
  /** Whether the terminal is expanded to full view */
  isExpanded?: boolean;
  /** Callback to toggle expanded state */
  onToggleExpand?: () => void;
}

/**
 * Get the responsive max-width class for terminal title based on terminal count.
 * More terminals = narrower title to fit all elements.
 */
export function getTitleMaxWidthClass(terminalCount: number): string {
  if (terminalCount <= 2) return 'max-w-72'; // 288px - large
  if (terminalCount <= 4) return 'max-w-56'; // 224px - medium
  if (terminalCount <= 6) return 'max-w-48'; // 192px - default
  if (terminalCount <= 9) return 'max-w-40'; // 160px - compact
  return 'max-w-36'; // 144px - compact for 10-12 terminals
}

export const STATUS_COLORS: Record<TerminalStatus, string> = {
  idle: 'bg-warning',
  running: 'bg-success',
  'claude-active': 'bg-primary',
  exited: 'bg-destructive',
};

// labelKey is an i18n key (terminal namespace), translated at render time
export const PHASE_CONFIG: Record<ExecutionPhase, { labelKey: string; color: string; icon: React.ElementType }> = {
  idle: { labelKey: 'terminal:taskPhase.idle', color: 'bg-muted text-muted-foreground', icon: Circle },
  planning: { labelKey: 'terminal:taskPhase.planning', color: 'bg-info/20 text-info', icon: Search },
  coding: { labelKey: 'terminal:taskPhase.coding', color: 'bg-primary/20 text-primary', icon: Code2 },
  rate_limit_paused: { labelKey: 'terminal:taskPhase.rateLimitPaused', color: 'bg-orange-500/20 text-orange-400', icon: PauseCircle },
  auth_failure_paused: { labelKey: 'terminal:taskPhase.authFailurePaused', color: 'bg-red-500/20 text-red-400', icon: KeyRound },
  qa_review: { labelKey: 'terminal:taskPhase.qaReview', color: 'bg-warning/20 text-warning', icon: Search },
  qa_fixing: { labelKey: 'terminal:taskPhase.qaFixing', color: 'bg-warning/20 text-warning', icon: Wrench },
  complete: { labelKey: 'terminal:taskPhase.complete', color: 'bg-success/20 text-success', icon: CheckCircle2 },
  failed: { labelKey: 'terminal:taskPhase.failed', color: 'bg-destructive/20 text-destructive', icon: AlertCircle },
};
