/**
 * Claude Code CLI Handlers
 *
 * IPC handlers for Claude Code CLI version checking and installation.
 * Provides functionality to:
 * - Check installed vs latest version
 * - Open terminal with installation command
 */

import { ipcMain } from 'electron';
import { execFile } from 'child_process';
import { existsSync, promises as fsPromises } from 'fs';
import path from 'path';
import os from 'os';
import { promisify } from 'util';
import { IPC_CHANNELS, DEFAULT_APP_SETTINGS } from '../../shared/constants';
import type { IPCResult } from '../../shared/types';
import type { ClaudeCodeVersionInfo, ClaudeInstallationList, ClaudeInstallationInfo } from '../../shared/types/cli';
import { getToolInfo, configureTools, sortNvmVersionDirs, getClaudeDetectionPaths, type ExecFileAsyncOptionsWithVerbatim } from '../cli-tool-manager';
import { readSettingsFile, writeSettingsFile } from '../settings-utils';
import { isSecurePath, getWhereExePath, getTaskkillExePath } from '../utils/windows-paths';
import { isWindows, isMacOS } from '../platform';
import semver from 'semver';
import { debugLog } from '../../shared/utils/debug-logger';
import { openTerminalWithCommand } from '../services/open-terminal';

const execFileAsync = promisify(execFile);

// Cache for latest version (avoid hammering npm registry)
let cachedLatestVersion: { version: string; timestamp: number } | null = null;
let cachedVersionList: { versions: string[]; timestamp: number } | null = null;
const CACHE_DURATION_MS = 24 * 60 * 60 * 1000; // 24 hours
const VERSION_LIST_CACHE_DURATION_MS = 60 * 60 * 1000; // 1 hour for version list

/**
 * Validate a Claude CLI path and get its version
 * @param cliPath - Path to the Claude CLI executable
 * @returns Tuple of [isValid, version or null]
 */
async function validateClaudeCliAsync(cliPath: string): Promise<[boolean, string | null]> {
  try {
    // Security validation: reject paths with shell metacharacters or directory traversal
    if (isWindows() && !isSecurePath(cliPath)) {
      throw new Error(`Claude CLI path failed security validation: ${cliPath}`);
    }

    // Augment PATH with the CLI directory for proper resolution
    const cliDir = path.dirname(cliPath);
    const env = {
      ...process.env,
      PATH: cliDir ? `${cliDir}${path.delimiter}${process.env.PATH || ''}` : process.env.PATH,
    };

    let stdout: string;
    // For Windows .cmd/.bat files, use cmd.exe with proper quoting
    // /d = disable AutoRun registry commands
    // /s = strip first and last quotes, preserving inner quotes
    // /c = run command then terminate
    if (isWindows() && /\.(cmd|bat)$/i.test(cliPath)) {
      // Get cmd.exe path from environment or use default
      const cmdExe = process.env.ComSpec
        || path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'cmd.exe');
      // Use double-quoted command line for paths with spaces
      const cmdLine = `""${cliPath}" --version"`;
      const execOptions: ExecFileAsyncOptionsWithVerbatim = {
        encoding: 'utf-8',
        timeout: 5000,
        windowsHide: true,
        windowsVerbatimArguments: true,
        env,
      };
      const result = await execFileAsync(cmdExe, ['/d', '/s', '/c', cmdLine], execOptions);
      stdout = result.stdout;
    } else {
      const result = await execFileAsync(cliPath, ['--version'], {
        encoding: 'utf-8',
        timeout: 5000,
        windowsHide: true,
        env,
      });
      stdout = result.stdout;
    }

    const version = String(stdout).trim();
    const match = version.match(/(\d+\.\d+\.\d+)/);
    return [true, match ? match[1] : version.split('\n')[0]];
  } catch (error) {
    // Log validation errors to help debug CLI detection issues
    console.warn('[Claude Code] CLI validation failed for', cliPath, ':', error);
    return [false, null];
  }
}

/**
 * Scan all known locations for Claude CLI installations.
 * Returns all found installations with their paths, versions, and sources.
 *
 * Uses getClaudeDetectionPaths() from cli-tool-manager.ts as the single source
 * of truth for detection paths to avoid duplication and ensure consistency.
 *
 * @see cli-tool-manager.ts getClaudeDetectionPaths() for path configuration
 */
async function scanClaudeInstallations(activePath: string | null): Promise<ClaudeInstallationInfo[]> {
  const installations: ClaudeInstallationInfo[] = [];
  const seenPaths = new Set<string>();
  const homeDir = os.homedir();

  // Get detection paths from cli-tool-manager (single source of truth)
  const detectionPaths = getClaudeDetectionPaths(homeDir);

  const addInstallation = async (
    cliPath: string,
    source: ClaudeInstallationInfo['source']
  ) => {
    // Normalize path for comparison
    const normalizedPath = path.resolve(cliPath);
    if (seenPaths.has(normalizedPath)) return;

    if (!existsSync(cliPath)) return;

    // Security validation: reject paths with shell metacharacters or directory traversal
    if (!isSecurePath(cliPath)) {
      console.warn('[Claude Code] Rejecting insecure path:', cliPath);
      return;
    }

    const [isValid, version] = await validateClaudeCliAsync(cliPath);
    if (!isValid) return;

    seenPaths.add(normalizedPath);
    installations.push({
      path: normalizedPath,
      version,
      source,
      isActive: activePath ? path.resolve(activePath) === normalizedPath : false,
    });
  };

  // 1. Check user-configured path first (if set)
  if (activePath && existsSync(activePath)) {
    await addInstallation(activePath, 'user-config');
  }

  // 2. Check system PATH via which/where
  try {
    if (isWindows()) {
      const result = await execFileAsync(getWhereExePath(), ['claude'], { timeout: 5000 });
      const paths = result.stdout.trim().split('\n').filter(p => p.trim());
      for (const p of paths) {
        await addInstallation(p.trim(), 'system-path');
      }
    } else {
      const result = await execFileAsync('which', ['-a', 'claude'], { timeout: 5000 });
      const paths = result.stdout.trim().split('\n').filter(p => p.trim());
      for (const p of paths) {
        await addInstallation(p.trim(), 'system-path');
      }
    }
  } catch {
    // which/where failed, continue with other methods
  }

  // 3. Homebrew paths (macOS) - from getClaudeDetectionPaths
  if (isMacOS()) {
    for (const p of detectionPaths.homebrewPaths) {
      await addInstallation(p, 'homebrew');
    }
  }

  // 4. NVM paths (Unix) - check Node.js version manager
  if (!isWindows() && existsSync(detectionPaths.nvmVersionsDir)) {
    try {
      const entries = await fsPromises.readdir(detectionPaths.nvmVersionsDir, { withFileTypes: true });
      const versionDirs = sortNvmVersionDirs(entries);
      for (const versionName of versionDirs) {
        const nvmClaudePath = path.join(detectionPaths.nvmVersionsDir, versionName, 'bin', 'claude');
        await addInstallation(nvmClaudePath, 'nvm');
      }
    } catch {
      // Failed to read NVM directory
    }
  }

  // 5. Platform-specific standard locations - from getClaudeDetectionPaths
  for (const p of detectionPaths.platformPaths) {
    await addInstallation(p, 'system-path');
  }

  // 6. Additional common paths not in getClaudeDetectionPaths (for broader scanning)
  const additionalPaths = isWindows()
    ? [] // Windows paths are well covered by detectionPaths.platformPaths
    : [
        path.join(homeDir, '.npm-global', 'bin', 'claude'),
        path.join(homeDir, '.yarn', 'bin', 'claude'),
        path.join(homeDir, '.claude', 'local', 'claude'),
        path.join(homeDir, 'node_modules', '.bin', 'claude'),
      ];

  for (const p of additionalPaths) {
    await addInstallation(p, 'system-path');
  }

  // Mark the first installation as active if none is explicitly active
  if (installations.length > 0 && !installations.some(i => i.isActive)) {
    installations[0].isActive = true;
  }

  return installations;
}

/**
 * Fetch the latest version of Claude Code from npm registry
 * @param currentInstalled - Optional currently installed version. If provided and newer than
 *                           cached latest, cache will be invalidated and fresh data fetched.
 *                           This handles the case where CLI was updated while app was running.
 */
async function fetchLatestVersion(currentInstalled?: string | null): Promise<string> {
  // Check cache first
  if (cachedLatestVersion && Date.now() - cachedLatestVersion.timestamp < CACHE_DURATION_MS) {
    const cachedVersion = cachedLatestVersion.version;

    // Invalidate cache if installed version is newer than cached latest
    // This handles the case where CLI was updated while app was running
    if (currentInstalled && cachedVersion) {
      try {
        const cleanInstalled = currentInstalled.replace(/^v/, '');
        const cleanCached = cachedVersion.replace(/^v/, '');
        if (semver.valid(cleanInstalled) && semver.valid(cleanCached) &&
            semver.gt(cleanInstalled, cleanCached)) {
          console.warn('[Claude Code] Installed version newer than cached latest, invalidating cache');
          cachedLatestVersion = null;
          // Fall through to fetch fresh from npm
        } else {
          return cachedVersion;
        }
      } catch {
        // If semver comparison fails, return cached version
        return cachedVersion;
      }
    } else {
      return cachedVersion;
    }
  }

  try {
    const response = await fetch('https://registry.npmjs.org/@anthropic-ai/claude-code/latest', {
      headers: {
        'Accept': 'application/json',
      },
      signal: AbortSignal.timeout(10000), // 10 second timeout
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const data = await response.json();
    const version = data.version;

    if (!version || typeof version !== 'string') {
      throw new Error('Invalid version format from npm registry');
    }

    // Cache the result
    cachedLatestVersion = { version, timestamp: Date.now() };
    return version;
  } catch (error) {
    console.error('[Claude Code] Failed to fetch latest version:', error);
    // Return cached version if available, even if expired
    if (cachedLatestVersion) {
      return cachedLatestVersion.version;
    }
    throw error;
  }
}

/**
 * Fetch available versions of Claude Code from npm registry
 * Returns versions sorted by semver descending (newest first)
 * Limited to last 20 versions for performance
 */
async function fetchAvailableVersions(): Promise<string[]> {
  // Check cache first
  if (cachedVersionList && Date.now() - cachedVersionList.timestamp < VERSION_LIST_CACHE_DURATION_MS) {
    return cachedVersionList.versions;
  }

  try {
    const response = await fetch('https://registry.npmjs.org/@anthropic-ai/claude-code', {
      headers: {
        'Accept': 'application/json',
      },
      signal: AbortSignal.timeout(15000), // 15 second timeout
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const data = await response.json();
    const versions = Object.keys(data.versions || {});

    if (!versions.length) {
      throw new Error('No versions found in npm registry');
    }

    // Sort by semver descending (newest first) and take last 20
    const sortedVersions = versions
      .filter(v => semver.valid(v)) // Only valid semver versions
      .sort((a, b) => semver.rcompare(a, b)) // Sort descending
      .slice(0, 20); // Limit to 20 versions

    // Validate we have versions after filtering
    if (sortedVersions.length === 0) {
      throw new Error('No valid semver versions found in npm registry');
    }

    // Cache the result
    cachedVersionList = { versions: sortedVersions, timestamp: Date.now() };
    return sortedVersions;
  } catch (error) {
    console.error('[Claude Code] Failed to fetch available versions:', error);
    // Return cached versions if available, even if expired
    if (cachedVersionList) {
      return cachedVersionList.versions;
    }
    throw error;
  }
}

/**
 * Get the platform-specific install command for a specific version of Claude Code
 * @param version - The version to install (e.g., "1.0.5")
 */
function getInstallVersionCommand(version: string): string {
  if (isWindows()) {
    // Windows: kill running Claude processes first, then install specific version
    return `"${getTaskkillExePath()}" /IM claude.exe /F 2>nul; claude install --force ${version}`;
  } else {
    // macOS/Linux: kill running Claude processes first, then install specific version
    return `pkill -x claude 2>/dev/null; sleep 1; claude install --force ${version}`;
  }
}

/**
 * Get the platform-specific install command for Claude Code
 * @param isUpdate - If true, Claude is already installed and we just need to update
 */
function getInstallCommand(isUpdate: boolean): string {
  if (isWindows()) {
    if (isUpdate) {
      // Update: kill running Claude processes first, then update with --force
      return `"${getTaskkillExePath()}" /IM claude.exe /F 2>nul; claude install --force latest`;
    }
    return 'irm https://claude.ai/install.ps1 | iex';
  } else {
    if (isUpdate) {
      // Update: kill running Claude processes first, then update with --force
      // pkill sends SIGTERM to gracefully stop Claude processes
      return 'pkill -x claude 2>/dev/null; sleep 1; claude install --force latest';
    }
    // Fresh install: use the full install script
    return 'curl -fsSL https://claude.ai/install.sh | bash -s -- latest';
  }
}

/**
 * Register Claude Code IPC handlers
 */
export function registerClaudeCodeHandlers(): void {
  // Check Claude Code version
  ipcMain.handle(
    IPC_CHANNELS.CLAUDE_CODE_CHECK_VERSION,
    async (): Promise<IPCResult<ClaudeCodeVersionInfo>> => {
      try {
        console.warn('[Claude Code] Checking version...');

        // Get installed version via cli-tool-manager
        let detectionResult;
        try {
          detectionResult = getToolInfo('claude');
          console.warn('[Claude Code] Detection result:', JSON.stringify(detectionResult, null, 2));
        } catch (detectionError) {
          console.error('[Claude Code] Detection error:', detectionError);
          throw new Error(`Detection failed: ${detectionError instanceof Error ? detectionError.message : 'Unknown error'}`);
        }

        const installed = detectionResult.found ? detectionResult.version || null : null;
        console.warn('[Claude Code] Installed version:', installed);

        // Fetch latest version from npm
        // Pass installed version to invalidate cache if installed > cached (handles CLI update while app running)
        let latest: string;
        try {
          console.warn('[Claude Code] Fetching latest version from npm...');
          latest = await fetchLatestVersion(installed);
          console.warn('[Claude Code] Latest version:', latest);
        } catch (error) {
          console.warn('[Claude Code] Failed to fetch latest version, continuing with unknown:', error);
          // If we can't fetch latest, still return installed info
          return {
            success: true,
            data: {
              installed,
              latest: 'unknown',
              isOutdated: false,
              path: detectionResult.path,
              detectionResult,
            },
          };
        }

        // Compare versions
        let isOutdated = false;
        if (installed && latest !== 'unknown') {
          try {
            // Clean version strings (remove 'v' prefix if present)
            const cleanInstalled = installed.replace(/^v/, '');
            const cleanLatest = latest.replace(/^v/, '');
            isOutdated = semver.lt(cleanInstalled, cleanLatest);
          } catch {
            // If semver comparison fails, assume not outdated
            isOutdated = false;
          }
        }

        console.warn('[Claude Code] Check complete:', { installed, latest, isOutdated });
        return {
          success: true,
          data: {
            installed,
            latest,
            isOutdated,
            path: detectionResult.path,
            detectionResult,
          },
        };
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : 'Unknown error';
        console.error('[Claude Code] Check failed:', errorMsg, error);
        return {
          success: false,
          error: `Failed to check Claude Code version: ${errorMsg}`,
        };
      }
    }
  );

  // Install Claude Code (open terminal with install command)
  ipcMain.handle(
    IPC_CHANNELS.CLAUDE_CODE_INSTALL,
    async (): Promise<IPCResult<{ command: string }>> => {
      try {
        // Check if Claude is already installed to determine if this is an update
        let isUpdate = false;
        try {
          const detectionResult = getToolInfo('claude');
          isUpdate = detectionResult.found && !!detectionResult.version;
          console.warn('[Claude Code] Is update:', isUpdate, 'detected version:', detectionResult.version);
        } catch {
          // Detection failed, assume fresh install
          isUpdate = false;
        }

        const command = getInstallCommand(isUpdate);
        console.warn('[Claude Code] Install command:', command);
        console.warn('[Claude Code] Opening terminal...');
        await openTerminalWithCommand(command);
        console.warn('[Claude Code] Terminal opened successfully');

        return {
          success: true,
          data: { command },
        };
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : 'Unknown error';
        console.error('[Claude Code] Install failed:', errorMsg, error);
        return {
          success: false,
          error: `Failed to open terminal for installation: ${errorMsg}`,
        };
      }
    }
  );

  // Get available Claude Code versions
  ipcMain.handle(
    IPC_CHANNELS.CLAUDE_CODE_GET_VERSIONS,
    async (): Promise<IPCResult<{ versions: string[] }>> => {
      try {
        debugLog('[Claude Code] Fetching available versions...');
        const versions = await fetchAvailableVersions();
        debugLog('[Claude Code] Found', versions.length, 'versions');
        return {
          success: true,
          data: { versions },
        };
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : 'Unknown error';
        console.error('[Claude Code] Failed to fetch versions:', errorMsg, error);
        return {
          success: false,
          error: `Failed to fetch available versions: ${errorMsg}`,
        };
      }
    }
  );

  // Install a specific version of Claude Code
  ipcMain.handle(
    IPC_CHANNELS.CLAUDE_CODE_INSTALL_VERSION,
    async (_event, version: string): Promise<IPCResult<{ command: string; version: string }>> => {
      try {
        // Validate version format
        if (!version || typeof version !== 'string') {
          throw new Error('Invalid version specified');
        }

        // Basic semver validation
        if (!semver.valid(version)) {
          throw new Error(`Invalid version format: ${version}`);
        }

        debugLog('[Claude Code] Installing version:', version);
        const command = getInstallVersionCommand(version);
        debugLog('[Claude Code] Install command:', command);
        debugLog('[Claude Code] Opening terminal...');
        await openTerminalWithCommand(command);
        debugLog('[Claude Code] Terminal opened successfully');

        return {
          success: true,
          data: { command, version },
        };
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : 'Unknown error';
        console.error('[Claude Code] Install version failed:', errorMsg, error);
        return {
          success: false,
          error: `Failed to install version: ${errorMsg}`,
        };
      }
    }
  );

  // Get all Claude CLI installations found on the system
  ipcMain.handle(
    IPC_CHANNELS.CLAUDE_CODE_GET_INSTALLATIONS,
    async (): Promise<IPCResult<ClaudeInstallationList>> => {
      try {
        debugLog('[Claude Code] Scanning for installations...');

        // Get current active path from settings
        const settings = readSettingsFile();
        const activePath = settings?.claudePath as string | undefined;

        const installations = await scanClaudeInstallations(activePath || null);
        debugLog('[Claude Code] Found', installations.length, 'installations');

        return {
          success: true,
          data: {
            installations,
            activePath: activePath || (installations.length > 0 ? installations[0].path : null),
          },
        };
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : 'Unknown error';
        console.error('[Claude Code] Failed to scan installations:', errorMsg, error);
        return {
          success: false,
          error: `Failed to scan Claude CLI installations: ${errorMsg}`,
        };
      }
    }
  );

  // Set the active Claude CLI path
  ipcMain.handle(
    IPC_CHANNELS.CLAUDE_CODE_SET_ACTIVE_PATH,
    async (_event, cliPath: string): Promise<IPCResult<{ path: string }>> => {
      try {
        debugLog('[Claude Code] Setting active path:', cliPath);

        // Security validation: reject paths with shell metacharacters or directory traversal
        if (!isSecurePath(cliPath)) {
          throw new Error('Invalid path: contains potentially unsafe characters');
        }

        // Normalize path to prevent directory traversal
        const normalizedPath = path.resolve(cliPath);

        // Validate the path exists and is executable
        if (!existsSync(normalizedPath)) {
          throw new Error('Claude CLI not found at specified path');
        }

        const [isValid, version] = await validateClaudeCliAsync(normalizedPath);
        if (!isValid) {
          throw new Error('Claude CLI at specified path is not valid or not executable');
        }

        // Save to settings using established pattern: merge with DEFAULT_APP_SETTINGS
        const currentSettings = readSettingsFile() || {};
        const mergedSettings = {
          ...DEFAULT_APP_SETTINGS,
          ...currentSettings,
          claudePath: normalizedPath,
        } as Record<string, unknown>;
        writeSettingsFile(mergedSettings);

        // Update CLI tool manager cache
        configureTools({ claudePath: normalizedPath });

        debugLog('[Claude Code] Active path set:', normalizedPath, 'version:', version);

        return {
          success: true,
          data: { path: normalizedPath },
        };
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : 'Unknown error';
        console.error('[Claude Code] Failed to set active path:', errorMsg, error);
        return {
          success: false,
          error: `Failed to set active Claude CLI path: ${errorMsg}`,
        };
      }
    }
  );

  console.warn('[IPC] Claude Code handlers registered');
}
