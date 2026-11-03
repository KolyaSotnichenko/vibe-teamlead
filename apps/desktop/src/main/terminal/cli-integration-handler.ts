/**
 * Claude Integration Handler
 * Runs the user's preferred CLI (Claude Code by default) inside app terminals:
 * invoke, resume, session ID capture and exit detection.
 *
 * Terminals use the user's own environment and Claude Code login; agent
 * sessions use the app's Claude credential instead (see ai/claude-code/).
 */

import * as path from 'path';
import { IPC_CHANNELS } from '../../shared/constants';
import * as SessionHandler from './session-handler';
import * as PtyManager from './pty-manager';
import { safeSendToRenderer } from '../ipc-handlers/utils';
import { debugLog, debugError } from '../../shared/utils/debug-logger';
import { escapeShellArg, escapeForWindowsDoubleQuote, buildCdCommand } from '../../shared/utils/shell-escape';
import { getClaudeCliInvocation, getClaudeCliInvocationAsync } from '../cli-utils';
import { isWindows } from '../platform';
import { readSettingsFileAsync } from '../settings-utils';
import type { SupportedCLI } from '../../shared/types/settings';
import type {
  TerminalProcess,
  WindowGetter
} from './types';

// ============================================================================
// CLI DISPATCH UTILITIES
// ============================================================================

/**
 * Returns the shell command string for a non-Claude CLI tool.
 *
 * @param cli - The CLI identifier (from SupportedCLI, excluding 'claude-code')
 * @param customPath - Optional absolute path for 'custom' CLI
 * @returns The command string to write to the PTY
 */
function getCLICommand(cli: SupportedCLI, customPath?: string): string {
  if (cli === 'custom' && customPath) return customPath;
  const commands: Record<string, string> = {
    'gemini': 'gemini',
    'opencode': 'opencode',
    'kilocode': 'kilocode',
    'codex': 'codex',
  };
  return commands[cli] ?? cli;
}

function normalizePathForBash(envPath: string): string {
  return isWindows() ? envPath.replace(/;/g, ':') : envPath;
}

/**
 * Determine whether a command already resolves via an absolute executable path.
 *
 * When true, we should avoid prefixing PATH=... into the typed shell command because:
 * 1) PATH is not needed to locate the executable
 * 2) very long PATH prefixes create huge echoed command lines that can stress terminal rendering
 */
function isAbsoluteExecutableCommand(command: string): boolean {
  const trimmed = command.trim();
  if (!trimmed) return false;
  return path.isAbsolute(trimmed);
}

/**
 * Build PATH environment variable prefix for Claude CLI invocation.
 *
 * On Windows, uses semicolon separators and cmd.exe escaping.
 * On Unix/macOS, uses colon separators and bash escaping.
 *
 * @param pathEnv - PATH environment variable value
 * @returns Empty string if no PATH, otherwise platform-specific PATH prefix
 */
function buildPathPrefix(pathEnv: string): string {
  if (!pathEnv) {
    return '';
  }

  if (isWindows()) {
    // Windows: Use semicolon-separated PATH with double-quote escaping
    // Format: set "PATH=value" where value uses semicolons
    // For values inside double quotes, use escapeForWindowsDoubleQuote() because
    // caret is literal inside double quotes in cmd.exe (only " needs escaping).
    const escapedPath = escapeForWindowsDoubleQuote(pathEnv);
    return `set "PATH=${escapedPath}" && `;
  }

  // Unix/macOS: Use colon-separated PATH with bash escaping
  // Format: PATH='value' where value uses colons
  const normalizedPath = normalizePathForBash(pathEnv);
  return `PATH=${escapeShellArg(normalizedPath)} `;
}

/**
 * Escape a command for safe use in shell commands.
 *
 * On Windows, wraps in double quotes for cmd.exe. Since the value is inside
 * double quotes, we use escapeForWindowsDoubleQuote() (only escapes embedded
 * double quotes as ""). Caret escaping is NOT used inside double quotes.
 * On Unix/macOS, wraps in single quotes for bash.
 *
 * @param cmd - The command to escape
 * @returns The escaped command safe for use in shell commands
 */
function escapeShellCommand(cmd: string): string {
  if (isWindows()) {
    // Windows: Wrap in double quotes and escape only embedded double quotes
    // Inside double quotes, caret is literal, so use escapeForWindowsDoubleQuote()
    const escapedCmd = escapeForWindowsDoubleQuote(cmd);
    return `"${escapedCmd}"`;
  }
  // Unix/macOS: Wrap in single quotes for bash
  return escapeShellArg(cmd);
}

/**
 * Flag for YOLO mode (skip all permission prompts)
 * Extracted as constant to ensure consistency across invokeClaude and invokeCLIAsync
 */
const YOLO_MODE_FLAG = ' --dangerously-skip-permissions';

// ============================================================================
// SHARED HELPERS - Used by both sync and async invokeClaude
// ============================================================================

/**
 * Build the shell command for invoking Claude CLI.
 *
 * @param cwdCommand - Command to change directory (empty string if no change needed)
 * @param pathPrefix - PATH prefix for Claude CLI (empty string if not needed)
 * @param escapedClaudeCmd - Shell-escaped Claude CLI command
 * @param extraFlags - Optional extra flags to append to the command (e.g., '--dangerously-skip-permissions')
 * @returns Complete shell command string ready for terminal.pty.write()
 *
 * @example
 * buildClaudeShellCommand('cd /path && ', 'PATH=/bin ', 'claude');
 * // Returns: 'cd /path && PATH=/bin claude\r'
 */
export function buildClaudeShellCommand(
  cwdCommand: string,
  pathPrefix: string,
  escapedClaudeCmd: string,
  extraFlags?: string
): string {
  const fullCmd = extraFlags ? `${escapedClaudeCmd}${extraFlags}` : escapedClaudeCmd;
  return `${cwdCommand}${pathPrefix}${fullCmd}\r`;
}

/**
 * Check if a terminal should be auto-renamed when Claude is invoked.
 * Returns false if:
 * - Terminal already has a Claude-related title (already renamed)
 * - Terminal has a user-customized name (not "Terminal X" pattern)
 *
 * This prevents aggressive renaming on every Claude invocation and
 * preserves user-customized terminal names.
 */
export function shouldAutoRenameTerminal(currentTitle: string): boolean {
  // Already has Claude title - don't rename again
  if (currentTitle === 'Claude' || currentTitle.startsWith('Claude (')) {
    return false;
  }

  // Check if it's a default terminal name (Terminal 1, Terminal 2, etc.)
  // Only these can be auto-renamed on first Claude invocation
  const defaultNamePattern = /^Terminal \d+$/;
  return defaultNamePattern.test(currentTitle);
}

/**
 * Callback type for session capture
 */
type SessionCaptureCallback = (terminalId: string, projectPath: string, startTime: number) => void;

/**
 * Finalize terminal state after invoking Claude.
 *
 * Updates terminal title, sends IPC notification to renderer, persists session,
 * and calls the session capture callback. Shared by the sync and async invoke methods.
 */
export function finalizeClaudeInvoke(
  terminal: TerminalProcess,
  projectPath: string | undefined,
  startTime: number,
  getWindow: WindowGetter,
  onSessionCapture: SessionCaptureCallback
): void {
  // Only auto-rename if terminal has default name (first Claude invocation)
  // This preserves user-customized names and prevents renaming on every invocation
  if (shouldAutoRenameTerminal(terminal.title)) {
    terminal.title = 'Claude';

    // Notify renderer of title change (use safeSendToRenderer to prevent SIGABRT on disposed frame)
    safeSendToRenderer(getWindow, IPC_CHANNELS.TERMINAL_TITLE_CHANGE, terminal.id, 'Claude');
  }

  // Persist session if project path is available
  if (terminal.projectPath) {
    SessionHandler.persistSession(terminal);
  }

  // Call session capture callback if project path provided
  if (projectPath) {
    onSessionCapture(terminal.id, projectPath, startTime);
  }
}

/**
 * Handle Claude session ID capture
 */
export function handleClaudeSessionId(
  terminal: TerminalProcess,
  sessionId: string,
  getWindow: WindowGetter
): void {
  terminal.claudeSessionId = sessionId;
  console.warn('[ClaudeIntegration] Captured Claude session ID:', sessionId);

  if (terminal.projectPath) {
    SessionHandler.updateClaudeSessionId(terminal.projectPath, terminal.id, sessionId);
  }

  safeSendToRenderer(getWindow, IPC_CHANNELS.TERMINAL_CLAUDE_SESSION, terminal.id, sessionId);
}

/**
 * Handle Claude exit detection (user closed Claude, returned to shell)
 *
 * This is called when we detect that Claude has exited and the terminal
 * has returned to a shell prompt. This resets the Claude mode state
 * and notifies the renderer to update the UI.
 */
export function handleClaudeExit(
  terminal: TerminalProcess,
  getWindow: WindowGetter
): void {
  // Only handle if we're actually in Claude mode
  if (!terminal.isCLIMode) {
    return;
  }

  console.warn('[ClaudeIntegration] Claude exit detected, resetting mode for terminal:', terminal.id);

  // Reset Claude mode state
  terminal.isCLIMode = false;
  terminal.claudeSessionId = undefined;

  // Persist the session state change
  if (terminal.projectPath) {
    SessionHandler.persistSession(terminal);
  }

  // Notify renderer to update UI
  safeSendToRenderer(getWindow, IPC_CHANNELS.TERMINAL_CLAUDE_EXIT, terminal.id);
}

/**
 * Invoke Claude in a terminal
 */
export function invokeClaude(
  terminal: TerminalProcess,
  cwd: string | undefined,
  getWindow: WindowGetter,
  onSessionCapture: SessionCaptureCallback,
  dangerouslySkipPermissions?: boolean
): void {
  debugLog('[ClaudeIntegration:invokeClaude] Terminal ID:', terminal.id, 'CWD:', cwd, 'Skip permissions:', dangerouslySkipPermissions);

  // Compute extra flags for YOLO mode
  const extraFlags = dangerouslySkipPermissions ? YOLO_MODE_FLAG : undefined;

  // Track terminal state for cleanup on error
  const wasClaudeMode = terminal.isCLIMode;

  try {
    terminal.isCLIMode = true;
    terminal.dangerouslySkipPermissions = dangerouslySkipPermissions;
    SessionHandler.releaseSessionId(terminal.id);
    terminal.claudeSessionId = undefined;

    const startTime = Date.now();
    const projectPath = cwd || terminal.projectPath || terminal.cwd;

    const cwdCommand = buildCdCommand(cwd, terminal.shellType);
    const { command: claudeCmd, env: claudeEnv } = getClaudeCliInvocation();
    const escapedClaudeCmd = escapeShellCommand(claudeCmd);
    const pathPrefix = isAbsoluteExecutableCommand(claudeCmd)
      ? ''
      : buildPathPrefix(claudeEnv.PATH || '');

    const command = buildClaudeShellCommand(cwdCommand, pathPrefix, escapedClaudeCmd, extraFlags);
    debugLog('[ClaudeIntegration:invokeClaude] Executing command:', command);
    PtyManager.writeToPty(terminal, command);

    finalizeClaudeInvoke(terminal, projectPath, startTime, getWindow, onSessionCapture);
  } catch (error) {
    // Reset terminal state on error to prevent inconsistent state
    terminal.isCLIMode = wasClaudeMode;
    terminal.claudeSessionId = undefined;
    debugError('[ClaudeIntegration:invokeClaude] Invocation failed:', error);
    throw error; // Re-throw to allow caller to handle
  }
}

/**
 * Resume Claude session in the current directory
 *
 * Uses `claude --continue` which resumes the most recent conversation in the
 * current directory. This is simpler and more reliable than tracking session IDs,
 * since Auto Claude already restores terminals to their correct cwd/projectPath.
 *
 * Note: The sessionId parameter is kept for backwards compatibility but is ignored.
 * Claude Code's --resume flag expects user-named sessions (set via /rename), not
 * internal session file IDs.
 */
export function resumeClaude(
  terminal: TerminalProcess,
  _sessionId: string | undefined,
  getWindow: WindowGetter
): void {
  // Track terminal state for cleanup on error
  const wasClaudeMode = terminal.isCLIMode;

  try {
    terminal.isCLIMode = true;
    SessionHandler.releaseSessionId(terminal.id);

    const { command: claudeCmd, env: claudeEnv } = getClaudeCliInvocation();
    const escapedClaudeCmd = escapeShellCommand(claudeCmd);
    const pathPrefix = isAbsoluteExecutableCommand(claudeCmd)
      ? ''
      : buildPathPrefix(claudeEnv.PATH || '');

    // Always use --continue which resumes the most recent session in the current directory.
    // This is more reliable than --resume with session IDs since Auto Claude already restores
    // terminals to their correct cwd/projectPath.
    //
    // Note: We clear claudeSessionId because --continue doesn't track specific sessions,
    // and we don't want stale IDs persisting through SessionHandler.persistSession().
    terminal.claudeSessionId = undefined;

    // Deprecation warning for callers still passing sessionId
    if (_sessionId) {
      console.warn('[ClaudeIntegration:resumeClaude] sessionId parameter is deprecated and ignored; using claude --continue instead');
    }

    // Preserve YOLO mode flag from terminal's stored state
    const extraFlags = terminal.dangerouslySkipPermissions ? YOLO_MODE_FLAG : '';

    const command = `${pathPrefix}${escapedClaudeCmd} --continue${extraFlags}`;

    // Use PtyManager.writeToPty for safer write with error handling
    PtyManager.writeToPty(terminal, `${command}\r`);

    // Only auto-rename if terminal has default name
    // This preserves user-customized names and prevents renaming on every resume
    if (shouldAutoRenameTerminal(terminal.title)) {
      terminal.title = 'Claude';
      safeSendToRenderer(getWindow, IPC_CHANNELS.TERMINAL_TITLE_CHANGE, terminal.id, 'Claude');
    }

    // Persist session
    if (terminal.projectPath) {
      SessionHandler.persistSession(terminal);
    }
  } catch (error) {
    // Reset terminal state on error to prevent inconsistent state
    terminal.isCLIMode = wasClaudeMode;
    // Note: Don't restore claudeSessionId since --continue doesn't use session IDs
    debugError('[ClaudeIntegration:resumeClaude] Resume failed:', error);
    throw error; // Re-throw to allow caller to handle
  }
}

// ============================================================================
// ASYNC VERSIONS - Non-blocking alternatives for Electron main process
// ============================================================================

/**
 * Invoke the preferred CLI asynchronously (non-blocking)
 *
 * Safe to call from Electron main process without blocking the event loop.
 * Uses async CLI detection which doesn't block on subprocess calls.
 * Includes error handling and timeout protection to prevent hangs.
 */
export async function invokeCLIAsync(
  terminal: TerminalProcess,
  cwd: string | undefined,
  getWindow: WindowGetter,
  onSessionCapture: SessionCaptureCallback,
  dangerouslySkipPermissions?: boolean
): Promise<void> {
  // Track terminal state for cleanup on error
  const wasClaudeMode = terminal.isCLIMode;

  const startTime = Date.now();

  try {
    debugLog('[ClaudeIntegration:invokeCLIAsync] Terminal ID:', terminal.id, 'CWD:', cwd, 'Skip permissions:', dangerouslySkipPermissions);

    // Compute extra flags for YOLO mode
    const extraFlags = dangerouslySkipPermissions ? YOLO_MODE_FLAG : undefined;

    terminal.isCLIMode = true;
    terminal.dangerouslySkipPermissions = dangerouslySkipPermissions;
    SessionHandler.releaseSessionId(terminal.id);
    terminal.claudeSessionId = undefined;

    const projectPath = cwd || terminal.projectPath || terminal.cwd;

    // Dispatch to the appropriate CLI based on preferredCLI setting
    const settings = await readSettingsFileAsync();
    const preferredCLI = (settings?.preferredCLI as SupportedCLI | undefined) || 'claude-code';

    if (preferredCLI !== 'claude-code') {
      // Non-Claude CLI: change directory if needed, then run the CLI command directly
      const cwdCommand = buildCdCommand(cwd, terminal.shellType);
      const command = getCLICommand(preferredCLI, settings?.customCLIPath as string | undefined);
      debugLog('[ClaudeIntegration:invokeCLIAsync] Non-Claude CLI dispatch:', { preferredCLI, command });
      if (cwdCommand) {
        PtyManager.writeToPty(terminal, `${cwdCommand} && ${command}\r`);
      } else {
        PtyManager.writeToPty(terminal, `${command}\r`);
      }
      return;
    }

    const cwdCommand = buildCdCommand(cwd, terminal.shellType);

    // Add timeout protection for CLI detection (10s timeout)
    const cliInvocationPromise = getClaudeCliInvocationAsync();
    let timeoutId: NodeJS.Timeout | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(() => reject(new Error('CLI invocation timeout after 10s')), 10000);
    });
    const { command: claudeCmd, env: claudeEnv } = await Promise.race([cliInvocationPromise, timeoutPromise])
      .finally(() => {
        if (timeoutId) clearTimeout(timeoutId);
      });

    const escapedClaudeCmd = escapeShellCommand(claudeCmd);
    const pathPrefix = isAbsoluteExecutableCommand(claudeCmd)
      ? ''
      : buildPathPrefix(claudeEnv.PATH || '');

    const command = buildClaudeShellCommand(cwdCommand, pathPrefix, escapedClaudeCmd, extraFlags);
    debugLog('[ClaudeIntegration:invokeCLIAsync] Executing command:', command);
    PtyManager.writeToPty(terminal, command);

    finalizeClaudeInvoke(terminal, projectPath, startTime, getWindow, onSessionCapture);
  } catch (error) {
    // Reset terminal state on error to prevent inconsistent state
    terminal.isCLIMode = wasClaudeMode;
    terminal.claudeSessionId = undefined;
    debugError('[ClaudeIntegration:invokeCLIAsync] Invocation failed after', Date.now() - startTime, 'ms:', error);
    throw error; // Re-throw to allow caller to handle
  }
}

/**
 * Resume Claude asynchronously (non-blocking)
 *
 * Safe to call from Electron main process without blocking the event loop.
 * Uses async CLI detection which doesn't block on subprocess calls.
 */
export async function resumeClaudeAsync(
  terminal: TerminalProcess,
  sessionId: string | undefined,
  getWindow: WindowGetter
): Promise<void> {
  // Track terminal state for cleanup on error
  const wasClaudeMode = terminal.isCLIMode;

  try {
    terminal.isCLIMode = true;
    SessionHandler.releaseSessionId(terminal.id);

    // Async CLI invocation - non-blocking
    // Add timeout protection for CLI detection (10s timeout)
    const cliInvocationPromise = getClaudeCliInvocationAsync();
    let timeoutId: NodeJS.Timeout | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(() => reject(new Error('CLI invocation timeout after 10s')), 10000);
    });

    const { command: claudeCmd, env: claudeEnv } = await Promise.race([cliInvocationPromise, timeoutPromise])
      .finally(() => {
        if (timeoutId) clearTimeout(timeoutId);
      });

    const escapedClaudeCmd = escapeShellCommand(claudeCmd);
    const pathPrefix = isAbsoluteExecutableCommand(claudeCmd)
      ? ''
      : buildPathPrefix(claudeEnv.PATH || '');

    // Always use --continue which resumes the most recent session in the current directory.
    // This is more reliable than --resume with session IDs since Auto Claude already restores
    // terminals to their correct cwd/projectPath.
    //
    // Note: We clear claudeSessionId because --continue doesn't track specific sessions,
    // and we don't want stale IDs persisting through SessionHandler.persistSessionAsync().
    terminal.claudeSessionId = undefined;

    // Deprecation warning for callers still passing sessionId
    if (sessionId) {
      console.warn('[ClaudeIntegration:resumeClaudeAsync] sessionId parameter is deprecated and ignored; using claude --continue instead');
    }

    // Preserve YOLO mode flag from terminal's stored state
    const extraFlags = terminal.dangerouslySkipPermissions ? YOLO_MODE_FLAG : '';

    const command = `${pathPrefix}${escapedClaudeCmd} --continue${extraFlags}`;

    // Use PtyManager.writeToPty for safer write with error handling
    PtyManager.writeToPty(terminal, `${command}\r`);

    // Only auto-rename if terminal has default name
    // This preserves user-customized names and prevents renaming on every resume
    if (shouldAutoRenameTerminal(terminal.title)) {
      terminal.title = 'Claude';
      safeSendToRenderer(getWindow, IPC_CHANNELS.TERMINAL_TITLE_CHANGE, terminal.id, 'Claude');
    }

    // Persist session (async, fire-and-forget to prevent main process blocking)
    if (terminal.projectPath) {
      SessionHandler.persistSessionAsync(terminal);
    }
  } catch (error) {
    // Reset terminal state on error to prevent inconsistent state
    terminal.isCLIMode = wasClaudeMode;
    // Note: Don't restore claudeSessionId since --continue doesn't use session IDs
    debugError('[ClaudeIntegration:resumeClaudeAsync] Resume failed:', error);
    throw error; // Re-throw to allow caller to handle
  }
}
