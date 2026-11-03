import type * as pty from '@lydell/node-pty';
import type { BrowserWindow } from 'electron';
import type { TerminalWorktreeConfig, WindowsShellType } from '../../shared/types';

// Re-export WindowsShellType for backwards compatibility
export type { WindowsShellType } from '../../shared/types';

/**
 * Terminal process tracking
 */
export interface TerminalProcess {
  id: string;
  pty: pty.IPty;
  isCLIMode: boolean;
  projectPath?: string;
  cwd: string;
  claudeSessionId?: string;
  outputBuffer: string;
  title: string;
  /** Associated worktree configuration (persisted across restarts) */
  worktreeConfig?: TerminalWorktreeConfig;
  /** Whether this terminal has a pending Claude resume that should be triggered on activation */
  pendingCLIResume?: boolean;
  /** Whether Claude was invoked with --dangerously-skip-permissions (YOLO mode) */
  dangerouslySkipPermissions?: boolean;
  /** Shell type for Windows (affects command chaining syntax) */
  shellType?: WindowsShellType;
  /** Whether PTY has emitted exit; used to avoid writes/resizes on dead PTYs */
  hasExited?: boolean;
}

/**
 * Session capture result
 */
export interface SessionCaptureResult {
  sessionId: string | null;
  captured: boolean;
}

/**
 * Terminal creation result
 */
export interface TerminalOperationResult {
  success: boolean;
  error?: string;
  outputBuffer?: string;
}

/**
 * Window getter function type
 */
export type WindowGetter = () => BrowserWindow | null;
