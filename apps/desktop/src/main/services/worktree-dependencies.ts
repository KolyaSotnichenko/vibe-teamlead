/**
 * Dependencies in a new worktree: for each dependency folder the project has (node_modules, a
 * Python venv, vendor folders), link it, recreate it or copy it from the main checkout, as the
 * project index says. Moved here whole from the terminal worktree IPC handlers.
 */
import { execFile } from 'child_process';
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, readlinkSync, rmSync, statSync, writeFileSync } from 'fs';
import path from 'path';
import { promisify } from 'util';

import { debugError, debugLog } from '../../shared/utils/debug-logger';
import { isWindows } from '../platform';
import { linkIntoWorktree } from '../platform/link';

const execFileAsync = promisify(execFile);

/**
 * Check if an error was caused by a timeout (execFileAsync with timeout sets killed=true).
 * This helper centralizes the timeout detection logic to avoid duplication.
 */
export function isTimeoutError(error: unknown): boolean {
  return (
    error instanceof Error &&
    'killed' in error &&
    (error as NodeJS.ErrnoException & { killed?: boolean }).killed === true
  );
}

/**
 * Check if a path is a symlink or Windows junction (including broken ones).
 * Uses readlinkSync which works for both symlinks and junctions on all platforms.
 */
export function isSymlinkOrJunction(targetPath: string): boolean {
  try {
    // readlinkSync throws if the path is not a symlink/junction
    // It works for both symlinks and junctions on Windows and Unix
    readlinkSync(targetPath);
    return true;
  } catch {
    return false; // Path doesn't exist or is not a symlink/junction
  }
}

/**
 * Configuration for a single dependency to be shared in a worktree.
 */
export interface DependencyConfig {
  /** Dependency type identifier (e.g., 'node_modules', 'venv') */
  depType: string;
  /** Strategy for sharing this dependency in worktrees */
  strategy: 'symlink' | 'recreate' | 'copy' | 'skip';
  /** Relative path from project root to the dependency directory */
  sourceRelPath: string;
  /** Path to requirements file for recreate strategy (e.g., 'requirements.txt') */
  requirementsFile?: string;
  /** Package manager used (e.g., 'npm', 'pip', 'uv') */
  packageManager?: string;
}

/**
 * Default mapping from dependency type to sharing strategy.
 *
 * Data-driven — add new entries here rather than writing if/else branches.
 * See apps/desktop/src/main/ipc-handlers/terminal/worktree-handlers.ts for the TypeScript implementation.
 */
export const DEFAULT_STRATEGY_MAP: Record<string, 'symlink' | 'recreate' | 'copy' | 'skip'> = {
  // JavaScript / Node.js — symlink is safe and fast
  node_modules: 'symlink',
  // Python — symlink for fast worktree creation.
  // CPython bug #106045 (pyvenv.cfg symlink resolution) does not affect
  // typical usage (running scripts, imports, pip). If the health check
  // after symlinking fails, we fall back to recreate automatically.
  venv: 'symlink',
  '.venv': 'symlink',
  // PHP — Composer vendor dir is safe to symlink
  vendor_php: 'symlink',
  // Ruby — Bundler vendor/bundle is safe to symlink
  vendor_bundle: 'symlink',
  // Rust — build output dir, skip (rebuilt per-worktree)
  cargo_target: 'skip',
  // Go — global module cache, nothing in-tree to share
  go_modules: 'skip',
};

/**
 * Load dependency configs from the project index, or fall back to hardcoded
 * node_modules-only behavior for backward compatibility.
 */
export function loadDependencyConfigs(projectPath: string): DependencyConfig[] {
  const indexPath = path.join(projectPath, '.vibe-teamlead', 'project_index.json');

  if (existsSync(indexPath)) {
    try {
      const index = JSON.parse(readFileSync(indexPath, 'utf-8'));
      // Use the aggregated top-level dependency_locations which already
      // contain project-relative paths (e.g. "apps/backend/.venv" instead
      // of just ".venv"), avoiding a monorepo path resolution bug.
      const depLocations = index?.dependency_locations;
      if (Array.isArray(depLocations)) {
        const configs: DependencyConfig[] = [];
        const seen = new Set<string>();

        for (const dep of depLocations) {
          if (!dep || typeof dep !== 'object') continue;
          const depObj = dep as Record<string, unknown>;
          const depType = String(depObj.type || '');
          const relPath = String(depObj.path || '');
          if (!depType || !relPath || seen.has(relPath)) continue;

          // Path containment: reject absolute paths and traversals
          if (path.isAbsolute(relPath)) continue;
          if (relPath.split('/').includes('..') || relPath.split('\\').includes('..')) continue;

          // Defense-in-depth: verify resolved path stays within project
          const resolved = path.resolve(projectPath, relPath);
          if (!resolved.startsWith(path.resolve(projectPath) + path.sep)) continue;

          seen.add(relPath);

          const strategy = DEFAULT_STRATEGY_MAP[depType] ?? 'skip';

          // Validate requirementsFile path containment
          let reqFile: string | undefined;
          if (depObj.requirements_file) {
            const rf = String(depObj.requirements_file);
            const rfParts = rf.split('/');
            const rfPartsWin = rf.split('\\');
            if (!path.isAbsolute(rf) && !rfParts.includes('..') && !rfPartsWin.includes('..')) {
              // Defense-in-depth: resolved-path containment (matches relPath check)
              const resolvedReq = path.resolve(projectPath, rf);
              if (resolvedReq.startsWith(path.resolve(projectPath) + path.sep)) {
                reqFile = rf;
              }
            }
          }

          configs.push({
            depType,
            strategy,
            sourceRelPath: relPath,
            requirementsFile: reqFile,
            packageManager: depObj.package_manager ? String(depObj.package_manager) : undefined,
          });
        }

        if (configs.length > 0) {
          return configs;
        }
      }
    } catch (error) {
      debugError('[TerminalWorktree] Failed to read project index:', error);
    }
  }

  // Fallback: hardcoded node_modules-only behavior (same as legacy)
  return [
    { depType: 'node_modules', strategy: 'symlink', sourceRelPath: 'node_modules' },
    { depType: 'node_modules', strategy: 'symlink', sourceRelPath: 'apps/desktop/node_modules' },
  ];
}

/**
 * Set up dependencies in a worktree using strategy-based dispatch.
 *
 * Reads dependency configs from the project index and applies the correct
 * strategy for each: symlink, recreate, copy, or skip.
 *
 * All operations are non-blocking on failure — errors are logged but never thrown.
 *
 * @param projectPath - The main project directory
 * @param worktreePath - Path to the worktree
 * @returns Array of successfully processed dependency relative paths
 */
export async function setupWorktreeDependencies(projectPath: string, worktreePath: string): Promise<string[]> {
  const configs = loadDependencyConfigs(projectPath);
  const processed: string[] = [];

  for (const config of configs) {
    try {
      let performed = false;
      switch (config.strategy) {
        case 'symlink':
          performed = applySymlinkStrategy(projectPath, worktreePath, config);
          // For venvs, verify the symlink is usable — fall back to recreate if not
          // Run health check whenever a venv exists (not just on fresh creation)
          if (config.depType === 'venv' || config.depType === '.venv') {
            const venvPath = path.join(worktreePath, config.sourceRelPath);
            // Check if venv path exists (as symlink or otherwise)
            if (existsSync(venvPath) || isSymlinkOrJunction(venvPath)) {
              const pythonBin = isWindows()
                ? path.join(venvPath, 'Scripts', 'python.exe')
                : path.join(venvPath, 'bin', 'python');
              try {
                await execFileAsync(pythonBin, ['-c', 'import sys; print(sys.prefix)'], {
                  timeout: 10000,
                });
                debugLog('[TerminalWorktree] Symlinked venv health check passed:', config.sourceRelPath);
              } catch {
                debugLog('[TerminalWorktree] Symlinked venv health check failed, falling back to recreate:', config.sourceRelPath);
                debugLog('[TerminalWorktree] Venv fallback: removing broken symlink and recreating for', config.sourceRelPath);
                // Remove the broken symlink and recreate
                try { rmSync(venvPath, { recursive: true, force: true }); } catch { /* best-effort */ }
                performed = await applyRecreateStrategy(projectPath, worktreePath, config);
                if (performed) {
                  debugLog('[TerminalWorktree] Venv fallback to recreate succeeded:', config.sourceRelPath);
                }
              }
            }
          }
          break;
        case 'recreate':
          performed = await applyRecreateStrategy(projectPath, worktreePath, config);
          break;
        case 'copy':
          performed = applyCopyStrategy(projectPath, worktreePath, config);
          break;
        case 'skip':
          debugLog('[TerminalWorktree] Skipping', config.depType, `(${config.sourceRelPath}) - skip strategy`);
          continue; // Don't record skipped entries in processed list
      }
      if (performed) processed.push(config.sourceRelPath);
    } catch (error) {
      debugError('[TerminalWorktree] Failed to apply', config.strategy, 'strategy for', config.sourceRelPath, ':', error);
      console.warn(`[TerminalWorktree] Warning: Failed to set up ${config.sourceRelPath}`);
    }
  }

  return processed;
}

/**
 * Apply symlink strategy: create a symlink (or Windows junction) from worktree to project source.
 * Reuses the existing platform-specific symlink creation pattern.
 */
export function applySymlinkStrategy(projectPath: string, worktreePath: string, config: DependencyConfig): boolean {
  const sourcePath = path.join(projectPath, config.sourceRelPath);
  const targetPath = path.join(worktreePath, config.sourceRelPath);

  if (!existsSync(sourcePath)) {
    debugLog('[TerminalWorktree] Skipping symlink', config.sourceRelPath, '- source missing');
    return false;
  }

  if (existsSync(targetPath)) {
    debugLog('[TerminalWorktree] Skipping symlink', config.sourceRelPath, '- target exists');
    return false;
  }

  // Check for broken symlinks and remove them so a fresh symlink can be created
  if (isSymlinkOrJunction(targetPath)) {
    if (!existsSync(targetPath)) {
      debugLog('[TerminalWorktree] Removing broken symlink for', config.sourceRelPath);
      try { rmSync(targetPath, { force: true }); } catch { /* best-effort */ }
    } else {
      debugLog('[TerminalWorktree] Skipping symlink', config.sourceRelPath, '- target exists (symlink)');
      return false;
    }
  }

  const targetDir = path.dirname(targetPath);
  if (!existsSync(targetDir)) {
    mkdirSync(targetDir, { recursive: true });
  }

  try {
    // A junction for a folder on Windows; a file is copied when Windows refuses its symlink (EPERM)
    const how = linkIntoWorktree(sourcePath, targetPath);
    debugLog('[TerminalWorktree] Linked', config.sourceRelPath, `(${how}) ->`, sourcePath);
    return true;
  } catch (error) {
    debugError('[TerminalWorktree] Could not create symlink for', config.sourceRelPath, ':', error);
    console.warn(`[TerminalWorktree] Warning: Failed to link ${config.sourceRelPath}`);
    return false;
  }
}

/** Marker file written inside a recreated venv to indicate setup completed successfully. */
export const VENV_SETUP_COMPLETE_MARKER = '.setup_complete';

/**
 * Apply recreate strategy: create a fresh virtual environment in the worktree.
 *
 * Used as a fallback when venv symlinking fails (CPython bug #106045).
 * Writes a completion marker so incomplete venvs can be detected and rebuilt.
 */
export async function applyRecreateStrategy(projectPath: string, worktreePath: string, config: DependencyConfig): Promise<boolean> {
  const venvPath = path.join(worktreePath, config.sourceRelPath);
  const markerPath = path.join(venvPath, VENV_SETUP_COMPLETE_MARKER);

  // Check for broken symlinks that existsSync would miss
  if (isSymlinkOrJunction(venvPath) && !existsSync(venvPath)) {
    debugLog('[TerminalWorktree] Removing broken symlink at', config.sourceRelPath);
    try { rmSync(venvPath, { recursive: true, force: true }); } catch { /* best-effort */ }
  } else if (existsSync(venvPath)) {
    if (existsSync(markerPath)) {
      debugLog('[TerminalWorktree] Skipping recreate', config.sourceRelPath, '- already complete (marker present)');
      return false;
    }
    // Venv exists but marker is missing — incomplete, remove and rebuild
    debugLog('[TerminalWorktree] Removing incomplete venv', config.sourceRelPath, '(no marker)');
    try { rmSync(venvPath, { recursive: true, force: true }); } catch { /* best-effort */ }
  }

  // Detect Python executable from the source venv or fall back to system Python
  const sourceVenv = path.join(projectPath, config.sourceRelPath);
  let pythonExec = isWindows() ? 'python' : 'python3';

  if (existsSync(sourceVenv)) {
    const unixCandidate = path.join(sourceVenv, 'bin', 'python');
    const winCandidate = path.join(sourceVenv, 'Scripts', 'python.exe');
    if (existsSync(unixCandidate)) {
      pythonExec = unixCandidate;
    } else if (existsSync(winCandidate)) {
      pythonExec = winCandidate;
    }
  }

  // Create the venv
  try {
    debugLog('[TerminalWorktree] Creating venv at', config.sourceRelPath);
    await execFileAsync(pythonExec, ['-m', 'venv', venvPath], {
      encoding: 'utf-8',
      timeout: 120000,
    });
  } catch (error) {
    if (isTimeoutError(error)) {
      debugError('[TerminalWorktree] venv creation timed out for', config.sourceRelPath);
      console.warn(`[TerminalWorktree] Warning: venv creation timed out for ${config.sourceRelPath}`);
    } else {
      debugError('[TerminalWorktree] venv creation failed for', config.sourceRelPath, ':', error);
      console.warn(`[TerminalWorktree] Warning: Could not create venv at ${config.sourceRelPath}`);
    }
    // Clean up partial venv so retries aren't blocked
    if (existsSync(venvPath)) {
      try { rmSync(venvPath, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
    return false;
  }

  // Install from requirements file if specified
  if (config.requirementsFile) {
    const reqPath = path.join(projectPath, config.requirementsFile);
    if (existsSync(reqPath)) {
      const pipExec = isWindows()
        ? path.join(venvPath, 'Scripts', 'pip.exe')
        : path.join(venvPath, 'bin', 'pip');

      // Build install command based on file type
      const reqBasename = path.basename(config.requirementsFile);
      let installArgs: string[] | null;
      if (reqBasename === 'pyproject.toml') {
        // Snapshot-install from worktree copy (non-editable to avoid
        // symlinking back to the main project source tree).
        const worktreeReq = path.join(worktreePath, config.requirementsFile!);
        const installDir = existsSync(worktreeReq) ? path.dirname(worktreeReq) : path.dirname(reqPath);
        installArgs = ['install', installDir];
      } else if (reqBasename === 'Pipfile') {
        debugLog('[TerminalWorktree] Skipping Pipfile-based install (use pipenv in worktree)');
        installArgs = null;
      } else {
        installArgs = ['install', '-r', reqPath];
      }

      if (installArgs) {
        try {
          debugLog('[TerminalWorktree] Installing deps from', config.requirementsFile);
          await execFileAsync(pipExec, installArgs, {
            encoding: 'utf-8',
            timeout: 300000,
          });
        } catch (error) {
          if (isTimeoutError(error)) {
            debugError('[TerminalWorktree] pip install timed out for', config.requirementsFile);
            console.warn(`[TerminalWorktree] Warning: Dependency install timed out for ${config.requirementsFile}`);
          } else {
            debugError('[TerminalWorktree] pip install failed:', error);
          }
          // Clean up broken venv so retries aren't blocked
          if (existsSync(venvPath)) {
            try { rmSync(venvPath, { recursive: true, force: true }); } catch { /* best-effort */ }
          }
          return false;
        }
      }
    }
  }

  // Write completion marker so future runs know this venv is complete
  try {
    writeFileSync(markerPath, '');
  } catch (error) {
    debugLog('[TerminalWorktree] Failed to write completion marker at', markerPath, ':', error);
  }

  debugLog('[TerminalWorktree] Recreated venv at', config.sourceRelPath);
  return true;
}

/**
 * Apply copy strategy: copy a file or directory from project to worktree.
 */
export function applyCopyStrategy(projectPath: string, worktreePath: string, config: DependencyConfig): boolean {
  const sourcePath = path.join(projectPath, config.sourceRelPath);
  const targetPath = path.join(worktreePath, config.sourceRelPath);

  if (!existsSync(sourcePath)) {
    debugLog('[TerminalWorktree] Skipping copy', config.sourceRelPath, '- source missing');
    return false;
  }

  if (existsSync(targetPath)) {
    debugLog('[TerminalWorktree] Skipping copy', config.sourceRelPath, '- target exists');
    return false;
  }

  const targetDir = path.dirname(targetPath);
  if (!existsSync(targetDir)) {
    mkdirSync(targetDir, { recursive: true });
  }

  try {
    if (statSync(sourcePath).isDirectory()) {
      cpSync(sourcePath, targetPath, { recursive: true });
    } else {
      copyFileSync(sourcePath, targetPath);
    }
    debugLog('[TerminalWorktree] Copied', config.sourceRelPath, 'to worktree');
    return true;
  } catch (error) {
    debugError('[TerminalWorktree] Could not copy', config.sourceRelPath, ':', error);
    console.warn(`[TerminalWorktree] Warning: Could not copy ${config.sourceRelPath}`);
    return false;
  }
}
