import { ipcMain, dialog, app, shell, session } from 'electron';
import { existsSync, writeFileSync, mkdirSync, statSync, readFileSync } from 'fs';
import { execFileSync } from 'node:child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import { is } from '@electron-toolkit/utils';

// ESM-compatible __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
import { IPC_CHANNELS, DEFAULT_APP_SETTINGS, DEFAULT_AGENT_PROFILES, SPELL_CHECK_LANGUAGE_MAP, DEFAULT_SPELL_CHECK_LANGUAGE, sanitizeThinkingLevel, VALID_THINKING_LEVELS } from '../../shared/constants';
import { setAppLanguage } from '../app-language';
import { isSupportedLanguage, resolveSupportedLanguage } from '../../shared/constants/i18n';
import type {
  AppSettings,
  IPCResult
} from '../../shared/types';
import { AgentManager } from '../agent';
import type { BrowserWindow } from 'electron';
import { setUpdateChannel, setUpdateChannelWithDowngradeCheck } from '../app-updater';
import { getSettingsPath, readSettingsFile } from '../settings-utils';
import { resetMemoryService } from './context/memory-service-factory';
import { configureTools, getToolPath, getToolInfo, isPathFromWrongPlatform, preWarmToolCache } from '../cli-tool-manager';
import { stripLegacySettings } from '../ai/claude-code/credential-migration';

const settingsPath = getSettingsPath();

/**
 * Auto-detect the auto-claude prompts path relative to the app location.
 * Works across platforms (macOS, Windows, Linux) in both dev and production modes.
 * Prompts live in apps/desktop/prompts/ (dev) or extraResources/prompts (prod).
 */
const detectAutoBuildSourcePath = (): string | null => {
  const possiblePaths: string[] = [];

  // Development mode paths
  if (is.dev) {
    // In dev, __dirname is typically apps/desktop/out/main
    // We need to go up to find apps/desktop/prompts
    possiblePaths.push(
      path.resolve(__dirname, '..', '..', 'prompts'),            // From out/main -> apps/desktop/prompts
      path.resolve(process.cwd(), 'apps', 'desktop', 'prompts') // From cwd (repo root)
    );
  } else {
    // Production mode paths (packaged app)
    // Prompts are bundled as extraResources/prompts
    // On all platforms, it should be at process.resourcesPath/prompts
    possiblePaths.push(
      path.resolve(process.resourcesPath, 'prompts')             // Primary: extraResources/prompts
    );
    // Fallback paths for different app structures
    const appPath = app.getAppPath();
    possiblePaths.push(
      path.resolve(appPath, '..', 'prompts'),                    // Sibling to asar
      path.resolve(appPath, '..', '..', 'Resources', 'prompts') // macOS bundle structure
    );
  }

  // Add process.cwd() as last resort on all platforms
  possiblePaths.push(path.resolve(process.cwd(), 'apps', 'desktop', 'prompts'));

  // Enable debug logging with DEBUG=1
  const debug = process.env.DEBUG === '1' || process.env.DEBUG === 'true';

  if (debug) {
    console.warn('[detectAutoBuildSourcePath] Platform:', process.platform);
    console.warn('[detectAutoBuildSourcePath] Is dev:', is.dev);
    console.warn('[detectAutoBuildSourcePath] __dirname:', __dirname);
    console.warn('[detectAutoBuildSourcePath] app.getAppPath():', app.getAppPath());
    console.warn('[detectAutoBuildSourcePath] process.cwd():', process.cwd());
    console.warn('[detectAutoBuildSourcePath] Checking paths:', possiblePaths);
  }

  for (const p of possiblePaths) {
    // Use planner.md as marker - this is the file needed for task planning
    const markerPath = path.join(p, 'planner.md');
    const exists = existsSync(p) && existsSync(markerPath);

    if (debug) {
      console.warn(`[detectAutoBuildSourcePath] Checking ${p}: ${exists ? '✓ FOUND' : '✗ not found'}`);
    }

    if (exists) {
      console.warn(`[detectAutoBuildSourcePath] Auto-detected prompts path: ${p}`);
      return p;
    }
  }

  console.warn('[detectAutoBuildSourcePath] Could not auto-detect Vibe Teamlead prompts path. Please configure manually in settings.');
  console.warn('[detectAutoBuildSourcePath] Set DEBUG=1 environment variable for detailed path checking.');
  return null;
};

/**
 * Register all settings-related IPC handlers
 */
export function registerSettingsHandlers(
  agentManager: AgentManager,
  getMainWindow: () => BrowserWindow | null
): void {
  // ============================================
  // Settings Operations
  // ============================================

  ipcMain.handle(
    IPC_CHANNELS.SETTINGS_GET,
    async (): Promise<IPCResult<AppSettings>> => {
      // Load settings using shared helper and merge with defaults
      // Fields of the removed multi-provider layer are dropped (startup migration
      // already moved the Claude key; this keeps old files loading cleanly)
      const savedSettings = stripLegacySettings(readSettingsFile() ?? {}).settings;
      const settings: AppSettings = { ...DEFAULT_APP_SETTINGS, ...savedSettings };
      let needsSave = false;

      // Migration: Set agent profile to 'auto' for users who haven't made a selection (one-time)
      // This ensures new users get the optimized 'auto' profile as the default
      // while preserving existing user preferences
      if (!settings._migratedAgentProfileToAuto) {
        // Only set 'auto' if user hasn't made a selection yet
        if (!settings.selectedAgentProfile) {
          settings.selectedAgentProfile = 'auto';
        }
        settings._migratedAgentProfileToAuto = true;
        needsSave = true;
      }

      // Migration: Sync defaultModel with selectedAgentProfile (#414)
      // Fixes bug where defaultModel was stuck at 'opus' regardless of profile selection
      if (!settings._migratedDefaultModelSync) {
        if (settings.selectedAgentProfile) {
          const profile = DEFAULT_AGENT_PROFILES.find(p => p.id === settings.selectedAgentProfile);
          if (profile) {
            settings.defaultModel = profile.model;
          }
        }
        settings._migratedDefaultModelSync = true;
        needsSave = true;
      }

      // Migration: Replace legacy thinking levels with valid equivalents
      // The 'ultrathink' value was removed but may persist in stored customPhaseThinking
      if (!settings._migratedUltrathinkToHigh) {
        if (settings.customPhaseThinking) {
          let changed = false;
          for (const phase of Object.keys(settings.customPhaseThinking) as Array<keyof typeof settings.customPhaseThinking>) {
            if (!(VALID_THINKING_LEVELS as readonly string[]).includes(settings.customPhaseThinking[phase])) {
              const mapped = sanitizeThinkingLevel(settings.customPhaseThinking[phase]);
              settings.customPhaseThinking[phase] = mapped as import('../../shared/types/settings').ThinkingLevel;
              changed = true;
            }
          }
          if (changed) {
            console.warn('[SETTINGS_GET] Migrated invalid thinking levels in customPhaseThinking');
          }
        }
        if (settings.featureThinking) {
          let changed = false;
          for (const feature of Object.keys(settings.featureThinking) as Array<keyof typeof settings.featureThinking>) {
            if (!(VALID_THINKING_LEVELS as readonly string[]).includes(settings.featureThinking[feature])) {
              const mapped = sanitizeThinkingLevel(settings.featureThinking[feature]);
              settings.featureThinking[feature] = mapped as import('../../shared/types/settings').ThinkingLevel;
              changed = true;
            }
          }
          if (changed) {
            console.warn('[SETTINGS_GET] Migrated invalid thinking levels in featureThinking');
          }
        }
        settings._migratedUltrathinkToHigh = true;
        needsSave = true;
      }

      // Migration: A UI language that is no longer shipped (French was replaced by
      // Ukrainian) falls back to the OS language when available, otherwise English
      if (settings.language !== undefined && !isSupportedLanguage(settings.language)) {
        settings.language = resolveSupportedLanguage(settings.language, app.getLocale?.());
        needsSave = true;
      }

      // Migration: Clear CLI tool paths that are from a different platform
      // Fixes issue where Windows paths persisted on macOS (and vice versa)
      // when settings were synced/transferred between platforms
      // See: https://github.com/AndyMik90/Auto-Claude/issues/XXX
      const pathFields = ['pythonPath', 'gitPath', 'githubCLIPath', 'gitlabCLIPath', 'claudePath', 'autoBuildPath'] as const;
      for (const field of pathFields) {
        const pathValue = settings[field];
        if (pathValue && isPathFromWrongPlatform(pathValue)) {
          console.warn(
            `[SETTINGS_GET] Clearing ${field} - path from different platform: ${pathValue}`
          );
          delete settings[field];
          needsSave = true;
        }
      }

      // If no manual autoBuildPath is set, try to auto-detect
      if (!settings.autoBuildPath) {
        const detectedPath = detectAutoBuildSourcePath();
        if (detectedPath) {
          settings.autoBuildPath = detectedPath;
        }
      }

      // Persist migration changes
      if (needsSave) {
        try {
          writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf-8');
        } catch (error) {
          console.error('[SETTINGS_GET] Failed to persist migration:', error);
          // Continue anyway - settings will be migrated in-memory for this session
        }
      }

      // Configure CLI tools with current settings
      configureTools({
        pythonPath: settings.pythonPath,
        gitPath: settings.gitPath,
        githubCLIPath: settings.githubCLIPath,
        gitlabCLIPath: settings.gitlabCLIPath,
        claudePath: settings.claudePath,
      });

      // Re-warm cache asynchronously after configuring (non-blocking)
      preWarmToolCache(['claude']).catch((error) => {
        console.warn('[SETTINGS_GET] Failed to re-warm CLI cache:', error);
      });

      return { success: true, data: settings as AppSettings };
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.SETTINGS_SAVE,
    async (_, settings: Partial<AppSettings>): Promise<IPCResult> => {
      try {
        // Load current settings using shared helper
        const savedSettings = stripLegacySettings(readSettingsFile() ?? {}).settings;
        const currentSettings = { ...DEFAULT_APP_SETTINGS, ...savedSettings };
        const safeSettings = stripLegacySettings(settings as Record<string, unknown>).settings as Partial<AppSettings>;
        const newSettings = { ...currentSettings, ...safeSettings };

        // Sync defaultModel when agent profile changes (#414)
        if (settings.selectedAgentProfile) {
          const profile = DEFAULT_AGENT_PROFILES.find(p => p.id === settings.selectedAgentProfile);
          if (profile) {
            newSettings.defaultModel = profile.model;
          }
        }

        writeFileSync(settingsPath, JSON.stringify(newSettings, null, 2), 'utf-8');

        // Apply Python path if changed
        if (settings.pythonPath || settings.autoBuildPath) {
          agentManager.configure(settings.pythonPath, settings.autoBuildPath);
        }

        // Configure CLI tools if any paths changed
        if (
          settings.pythonPath !== undefined ||
          settings.gitPath !== undefined ||
          settings.githubCLIPath !== undefined ||
          settings.gitlabCLIPath !== undefined ||
          settings.claudePath !== undefined
        ) {
          configureTools({
            pythonPath: newSettings.pythonPath,
            gitPath: newSettings.gitPath,
            githubCLIPath: newSettings.githubCLIPath,
            gitlabCLIPath: newSettings.gitlabCLIPath,
            claudePath: newSettings.claudePath,
          });

          // Re-warm cache asynchronously after configuring (non-blocking)
          preWarmToolCache(['claude']).catch((error) => {
            console.warn('[SETTINGS_SAVE] Failed to re-warm CLI cache:', error);
          });
        }

        // Reset memory service singleton when memory-related settings change
        if (
          settings.memoryEmbeddingProvider !== undefined ||
          settings.memoryEnabled !== undefined ||
          settings.globalOpenAIApiKey !== undefined ||
          settings.globalGoogleApiKey !== undefined ||
          settings.memoryVoyageApiKey !== undefined ||
          settings.memoryAzureApiKey !== undefined ||
          settings.ollamaBaseUrl !== undefined ||
          settings.memoryOllamaEmbeddingModel !== undefined
        ) {
          resetMemoryService();
        }

        // Update auto-updater channel if betaUpdates setting changed
        if (settings.betaUpdates !== undefined) {
          if (settings.betaUpdates) {
            // Enabling beta updates - just switch channel
            setUpdateChannel('beta');
          } else {
            // Disabling beta updates - switch to stable and check if downgrade is available
            // This will notify the renderer if user is on a prerelease and stable version exists
            setUpdateChannelWithDowngradeCheck('latest', true).catch((err) => {
              console.error('[settings-handlers] Failed to check for stable downgrade:', err);
            });
          }
        }

        return { success: true };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to save settings'
        };
      }
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.SETTINGS_GET_CLI_TOOLS_INFO,
    async (): Promise<IPCResult<{
      python: ReturnType<typeof getToolInfo>;
      git: ReturnType<typeof getToolInfo>;
      gh: ReturnType<typeof getToolInfo>;
      glab: ReturnType<typeof getToolInfo>;
      claude: ReturnType<typeof getToolInfo>;
    }>> => {
      try {
        return {
          success: true,
          data: {
            python: getToolInfo('python'),
            git: getToolInfo('git'),
            gh: getToolInfo('gh'),
            glab: getToolInfo('glab'),
            claude: getToolInfo('claude'),
          },
        };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to get CLI tools info',
        };
      }
    }
  );

  /**
   * Read ~/.claude.json to check if Claude Code onboarding is complete.
   * This allows Auto-Claude to respect Claude Code's onboarding status and
   * avoid showing the onboarding wizard to users who have already completed it.
   */
  ipcMain.handle(
    IPC_CHANNELS.SETTINGS_CLAUDE_CODE_GET_ONBOARDING_STATUS,
    async (): Promise<IPCResult<{ hasCompletedOnboarding: boolean }>> => {
      try {
        const homeDir = app.getPath('home');
        const claudeJsonPath = path.join(homeDir, '.claude.json');

        // If file doesn't exist, user hasn't completed Claude Code onboarding
        if (!existsSync(claudeJsonPath)) {
          return {
            success: true,
            data: { hasCompletedOnboarding: false }
          };
        }

        const content = readFileSync(claudeJsonPath, 'utf-8');
        const claudeConfig = JSON.parse(content);

        // Check for hasCompletedOnboarding field
        const hasCompletedOnboarding = claudeConfig.hasCompletedOnboarding === true;

        return {
          success: true,
          data: { hasCompletedOnboarding }
        };
      } catch (error) {
        // On error (parse error, read error, etc.), log and return false
        // This ensures we don't block onboarding due to corrupted .claude.json
        console.warn('[SETTINGS_CLAUDE_CODE_GET_ONBOARDING_STATUS] Error reading ~/.claude.json:', error);
        return {
          success: true,
          data: { hasCompletedOnboarding: false }
        };
      }
    }
  );

  // ============================================
  // Dialog Operations
  // ============================================

  ipcMain.handle(
    IPC_CHANNELS.DIALOG_SELECT_DIRECTORY,
    async (): Promise<string | null> => {
      const mainWindow = getMainWindow();
      if (!mainWindow) return null;

      const result = await dialog.showOpenDialog(mainWindow, {
        properties: ['openDirectory'],
        title: 'Select Project Directory'
      });

      if (result.canceled || result.filePaths.length === 0) {
        return null;
      }

      return result.filePaths[0];
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.DIALOG_CREATE_PROJECT_FOLDER,
    async (
      _,
      location: string,
      name: string,
      initGit: boolean
    ): Promise<IPCResult<{ path: string; name: string; gitInitialized: boolean }>> => {
      try {
        // Validate inputs
        if (!location || !name) {
          return { success: false, error: 'Location and name are required' };
        }

        // Sanitize project name (convert to kebab-case, remove invalid chars)
        const sanitizedName = name
          .toLowerCase()
          .replace(/\s+/g, '-')
          .replace(/[^a-z0-9-_]/g, '')
          .replace(/-+/g, '-')
          .replace(/^-|-$/g, '');

        if (!sanitizedName) {
          return { success: false, error: 'Invalid project name' };
        }

        const projectPath = path.join(location, sanitizedName);

        // Check if folder already exists
        if (existsSync(projectPath)) {
          return { success: false, error: `Folder "${sanitizedName}" already exists at this location` };
        }

        // Create the directory
        mkdirSync(projectPath, { recursive: true });

        // Initialize git if requested
        let gitInitialized = false;
        if (initGit) {
          try {
            execFileSync(getToolPath('git'), ['init'], { cwd: projectPath, stdio: 'ignore' });
            gitInitialized = true;
          } catch {
            // Git init failed, but folder was created - continue without git
            console.warn('Failed to initialize git repository');
          }
        }

        return {
          success: true,
          data: {
            path: projectPath,
            name: sanitizedName,
            gitInitialized
          }
        };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to create project folder'
        };
      }
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.DIALOG_GET_DEFAULT_PROJECT_LOCATION,
    async (): Promise<string | null> => {
      try {
        // Return user's home directory + common project folders
        const homeDir = app.getPath('home');
        const commonPaths = [
          path.join(homeDir, 'Projects'),
          path.join(homeDir, 'Developer'),
          path.join(homeDir, 'Code'),
          path.join(homeDir, 'Documents')
        ];

        // Return the first one that exists, or Documents as fallback
        for (const p of commonPaths) {
          if (existsSync(p)) {
            return p;
          }
        }

        return path.join(homeDir, 'Documents');
      } catch {
        return null;
      }
    }
  );

  // ============================================
  // App Info
  // ============================================

  ipcMain.handle(IPC_CHANNELS.APP_VERSION, async (): Promise<string> => {
    // Return the actual bundled version from package.json
    const version = app.getVersion();
    console.log('[settings-handlers] APP_VERSION returning:', version);
    return version;
  });

  // ============================================
  // Shell Operations
  // ============================================

  ipcMain.handle(
    IPC_CHANNELS.SHELL_OPEN_EXTERNAL,
    async (_, url: string): Promise<void> => {
      // Validate URL scheme to prevent opening dangerous protocols
      try {
        const parsedUrl = new URL(url);
        if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
          console.warn(`[SHELL_OPEN_EXTERNAL] Blocked URL with unsafe protocol: ${parsedUrl.protocol}`);
          throw new Error(`Unsafe URL protocol: ${parsedUrl.protocol}`);
        }
        await shell.openExternal(url);
      } catch (error) {
        if (error instanceof TypeError) {
          // Invalid URL format
          console.warn(`[SHELL_OPEN_EXTERNAL] Invalid URL format: ${url}`);
          throw new Error('Invalid URL format');
        }
        throw error;
      }
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.SHELL_OPEN_TERMINAL,
    async (_, dirPath: string): Promise<IPCResult<void>> => {
      try {
        // Validate dirPath input
        if (!dirPath || typeof dirPath !== 'string' || dirPath.trim() === '') {
          return {
            success: false,
            error: 'Directory path is required and must be a non-empty string'
          };
        }

        // Resolve to absolute path
        const resolvedPath = path.resolve(dirPath);

        // Verify path exists
        if (!existsSync(resolvedPath)) {
          return {
            success: false,
            error: `Directory does not exist: ${resolvedPath}`
          };
        }

        // Verify it's a directory
        try {
          if (!statSync(resolvedPath).isDirectory()) {
            return {
              success: false,
              error: `Path is not a directory: ${resolvedPath}`
            };
          }
        } catch (_statError) {
          return {
            success: false,
            error: `Cannot access path: ${resolvedPath}`
          };
        }

        const platform = process.platform;

        if (platform === 'darwin') {
          // macOS: Use execFileSync with argument array to prevent injection
          execFileSync('open', ['-a', 'Terminal', resolvedPath], { stdio: 'ignore' });
        } else if (platform === 'win32') {
          // Windows: Use cmd.exe directly with argument array
          // /C tells cmd to execute the command and terminate
          // /K keeps the window open after executing cd
          execFileSync('cmd.exe', ['/K', 'cd', '/d', resolvedPath], {
            stdio: 'ignore',
            windowsHide: false,
            shell: false  // Explicitly disable shell to prevent injection
          });
        } else {
          // Linux: Try common terminal emulators with argument arrays
          // Note: xterm uses cwd option to avoid shell injection vulnerabilities
          const terminals: Array<{ cmd: string; args: string[]; useCwd?: boolean }> = [
            { cmd: 'gnome-terminal', args: ['--working-directory', resolvedPath] },
            { cmd: 'konsole', args: ['--workdir', resolvedPath] },
            { cmd: 'xfce4-terminal', args: ['--working-directory', resolvedPath] },
            { cmd: 'xterm', args: ['-e', 'bash'], useCwd: true }
          ];

          let opened = false;
          for (const { cmd, args, useCwd } of terminals) {
            try {
              execFileSync(cmd, args, {
                stdio: 'ignore',
                ...(useCwd ? { cwd: resolvedPath } : {})
              });
              opened = true;
              break;
            } catch {
            }
          }

          if (!opened) {
            return {
              success: false,
              error: 'No supported terminal emulator found. Please install gnome-terminal, konsole, xfce4-terminal, or xterm.'
            };
          }
        }

        return { success: true };
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : 'Unknown error';
        return {
          success: false,
          error: `Failed to open terminal: ${errorMsg}`
        };
      }
    }
  );

  // ============================================
  // Spell Check Operations
  // ============================================

  /**
   * Set spell check languages based on app language.
   * Called when renderer's i18n language changes to sync spell checker.
   */
  ipcMain.handle(
    IPC_CHANNELS.SPELLCHECK_SET_LANGUAGES,
    async (_, language: string): Promise<IPCResult<{ success: boolean }>> => {
      try {
        // Validate language parameter
        if (!language || typeof language !== 'string') {
          return {
            success: false,
            error: 'Invalid language parameter'
          };
        }

        // Update tracked app language for context menu labels
        setAppLanguage(language);

        // Get spell check languages for this app language
        const spellCheckLanguages = SPELL_CHECK_LANGUAGE_MAP[resolveSupportedLanguage(language)] || [DEFAULT_SPELL_CHECK_LANGUAGE];

        // Get available languages on this system
        const availableLanguages = session.defaultSession.availableSpellCheckerLanguages;

        // Filter to only available languages
        const validLanguages = spellCheckLanguages.filter(lang =>
          availableLanguages.includes(lang)
        );

        // Fallback to default if none of the preferred languages are available
        const languagesToSet = validLanguages.length > 0
          ? validLanguages
          : (availableLanguages.includes(DEFAULT_SPELL_CHECK_LANGUAGE) ? [DEFAULT_SPELL_CHECK_LANGUAGE] : []);

        if (languagesToSet.length > 0) {
          session.defaultSession.setSpellCheckerLanguages(languagesToSet);
          console.log(`[SPELLCHECK] Languages set to: ${languagesToSet.join(', ')} for app language: ${language}`);
        } else {
          console.warn(`[SPELLCHECK] No valid spell check languages available for: ${language}`);
        }

        return {
          success: true,
          data: { success: true }
        };
      } catch (error) {
        console.error('[SPELLCHECK_SET_LANGUAGES] Error:', error);
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to set spell check languages'
        };
      }
    }
  );
}
