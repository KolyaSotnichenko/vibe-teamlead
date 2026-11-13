/**
 * Opening the user's terminal app with a command typed in (an install or sign-in command the
 * user runs themselves), and the escaping each terminal and shell needs. Moved here whole from
 * the Claude Code IPC handlers, which other handlers imported it from.
 */
import { execFileSync, spawn } from 'child_process';
import { existsSync } from 'fs';
import path from 'path';

import { isMacOS, isWindows } from '../platform';
import { readSettingsFile } from '../settings-utils';

/**
 * Escape a string for use inside AppleScript double-quoted strings.
 * In AppleScript:
 * - Backslashes must be escaped: \ → \\
 * - Double quotes must be escaped: " → \"
 * - Single quotes do NOT need escaping inside double-quoted strings
 */
export function escapeAppleScriptString(str: string): string {
  return str
    .replace(/\\/g, '\\\\')  // Escape backslashes first
    .replace(/"/g, '\\"');   // Escape double quotes
}

/**
 * Escape a string for safe use in PowerShell -Command context.
 * PowerShell requires escaping backticks, double quotes, dollar signs,
 * parentheses, semicolons, and ampersands.
 */
export function escapePowerShellCommand(str: string): string {
  return str
    .replace(/`/g, '``')      // Escape backticks (PowerShell escape char)
    .replace(/"/g, '`"')      // Escape double quotes
    .replace(/\$/g, '`$')     // Escape dollar signs (variable expansion)
    .replace(/\(/g, '`(')     // Escape opening parentheses
    .replace(/\)/g, '`)')     // Escape closing parentheses
    .replace(/;/g, '`;')      // Escape semicolons (statement separator)
    .replace(/&/g, '`&')      // Escape ampersands (call operator)
    .replace(/\r/g, '`r')     // Escape carriage returns
    .replace(/\n/g, '`n');    // Escape newlines
}

/**
 * Escape a string for safe use in Git Bash -c context.
 * Bash requires escaping single quotes, double quotes, backslashes, and other metacharacters.
 */
export function escapeGitBashCommand(str: string): string {
  // For bash -c with double quotes, escape: backslash, double quote, dollar, backtick,
  // semicolon, pipe, and exclamation mark (all bash metacharacters that could allow command injection)
  return str
    .replace(/\\/g, '\\\\')   // Escape backslashes first
    .replace(/"/g, '\\"')     // Escape double quotes
    .replace(/\$/g, '\\$')    // Escape dollar signs
    .replace(/`/g, '\\`')     // Escape backticks
    .replace(/;/g, '\\;')     // Escape semicolons (command separator)
    .replace(/\|/g, '\\|')    // Escape pipes (command piping)
    .replace(/!/g, '\\!');    // Escape exclamation marks (history expansion)
}

/**
 * Escape a string for safe use in bash -c context (Linux terminals).
 * Uses the same escaping rules as escapeGitBashCommand for consistency.
 * Defense-in-depth: Currently all commands come from trusted sources (getInstallCommand,
 * getInstallVersionCommand), but this prevents potential command injection if future
 * code adds new call sites with less controlled input.
 */
export function escapeBashCommand(str: string): string {
  // Reuse the same escaping logic as Git Bash
  return escapeGitBashCommand(str);
}

/**
 * Open a terminal with the given command
 * Uses the user's preferred terminal from settings
 * Supports macOS, Windows, and Linux terminals
 */
export async function openTerminalWithCommand(command: string): Promise<void> {
  const settings = readSettingsFile();
  const preferredTerminal = settings?.preferredTerminal as string | undefined;

  console.warn('[Claude Code] Platform:', isWindows() ? 'Windows' : isMacOS() ? 'macOS' : 'Linux');
  console.warn('[Claude Code] Preferred terminal:', preferredTerminal);

  if (isMacOS()) {
    // macOS: Use AppleScript to open terminal with command
    const escapedCommand = escapeAppleScriptString(command);
    let script: string;

    // Map SupportedTerminal values to terminal handling
    // Values come from settings.preferredTerminal (SupportedTerminal type)
    const terminalId = preferredTerminal?.toLowerCase() || 'terminal';

    console.warn('[Claude Code] Using terminal:', terminalId);

    if (terminalId === 'iterm2') {
      // iTerm2 - handle both running and not-running cases to prevent double windows
      script = `
        if application "iTerm" is running then
          tell application "iTerm"
            create window with default profile
            tell current session of current window
              write text "${escapedCommand}"
            end tell
            activate
          end tell
        else
          tell application "iTerm"
            activate
          end tell
          delay 0.5
          tell application "iTerm"
            tell current session of current window
              write text "${escapedCommand}"
            end tell
          end tell
        end if
      `;
    } else if (terminalId === 'warp') {
      // Warp - open and send command
      script = `
        tell application "Warp"
          activate
        end tell
        delay 0.5
        tell application "System Events"
          keystroke "${escapedCommand}"
          keystroke return
        end tell
      `;
    } else if (terminalId === 'kitty') {
      // Kitty - use command line
      spawn('kitty', ['--', 'bash', '-c', command], { detached: true, stdio: 'ignore' }).unref();
      return;
    } else if (terminalId === 'alacritty') {
      // Alacritty - use command line
      spawn('open', ['-a', 'Alacritty', '--args', '-e', 'bash', '-c', command], { detached: true, stdio: 'ignore' }).unref();
      return;
    } else if (terminalId === 'wezterm') {
      // WezTerm - use command line
      spawn('wezterm', ['start', '--', 'bash', '-c', command], { detached: true, stdio: 'ignore' }).unref();
      return;
    } else if (terminalId === 'ghostty') {
      // Ghostty
      script = `
        tell application "Ghostty"
          activate
        end tell
        delay 0.3
        tell application "System Events"
          keystroke "${escapedCommand}"
          keystroke return
        end tell
      `;
    } else if (terminalId === 'hyper') {
      // Hyper
      script = `
        tell application "Hyper"
          activate
        end tell
        delay 0.3
        tell application "System Events"
          keystroke "${escapedCommand}"
          keystroke return
        end tell
      `;
    } else if (terminalId === 'tabby') {
      // Tabby (formerly Terminus)
      script = `
        tell application "Tabby"
          activate
        end tell
        delay 0.3
        tell application "System Events"
          keystroke "${escapedCommand}"
          keystroke return
        end tell
      `;
    } else {
      // Default: Terminal.app (handles 'terminal', 'system', or any unknown value)
      // IMPORTANT: do script FIRST, then activate - this prevents opening a blank default window
      // when Terminal.app isn't already running
      script = `
        tell application "Terminal"
          do script "${escapedCommand}"
          activate
        end tell
      `;
    }

    console.warn('[Claude Code] Running AppleScript...');
    execFileSync('osascript', ['-e', script], { stdio: 'pipe' });

  } else if (isWindows()) {
    // Windows: Use appropriate terminal
    // Values match SupportedTerminal type: 'windowsterminal', 'powershell', 'cmd', 'conemu', 'cmder',
    // 'gitbash', 'alacritty', 'wezterm', 'hyper', 'tabby', 'cygwin', 'msys2'
    const terminalId = preferredTerminal?.toLowerCase() || 'powershell';

    console.warn('[Claude Code] Using terminal:', terminalId);
    console.warn('[Claude Code] Command to run:', command);

    // Helper to spawn a detached process on Windows
    // This is more reliable than exec() + start command because:
    // 1. spawn() launches the executable directly without requiring CMD shell
    // 2. detached: true allows the terminal to persist after our app exits
    // 3. stdio: 'ignore' prevents our app from being blocked by terminal output
    const spawnWindowsTerminal = (executable: string, args: string[]): Promise<void> => {
      // Give the process a brief moment to spawn and open its window.
      // 300ms is sufficient for most terminal emulators to start, but short
      // enough that the UI doesn't feel sluggish.
      const SPAWN_WAIT_MS = 300;

      return new Promise((resolve, reject) => {
        console.warn(`[Claude Code] Spawning: ${executable}`, args);

        const child = spawn(executable, args, {
          detached: true,
          stdio: 'ignore',
          windowsHide: false,
        });

        // Detach from the child process so it runs independently
        child.unref();

        const timer = setTimeout(() => {
          child.removeListener('error', onError);
          resolve();
        }, SPAWN_WAIT_MS);

        const onError = (err: Error) => {
          console.error(`[Claude Code] Spawn error for ${executable}:`, err);
          clearTimeout(timer);
          reject(err);
        };

        child.on('error', onError);
      });
    };

    try {
      // Escape command for PowerShell context to prevent command injection
      const escapedCommand = escapePowerShellCommand(command);

      if (terminalId === 'windowsterminal') {
        // Windows Terminal - open new tab with PowerShell
        // wt.exe accepts arguments directly without needing CMD's start command
        await spawnWindowsTerminal('wt', ['new-tab', 'powershell', '-NoExit', '-Command', escapedCommand]);
      } else if (terminalId === 'gitbash') {
        // Git Bash - use the passed command (escaped for bash context)
        const escapedBashCommand = escapeGitBashCommand(command);
        const gitBashPaths = [
          'C:\\Program Files\\Git\\git-bash.exe',
          'C:\\Program Files (x86)\\Git\\git-bash.exe',
        ];
        const gitBashPath = gitBashPaths.find(p => existsSync(p));
        if (gitBashPath) {
          await spawnWindowsTerminal(gitBashPath, ['-c', escapedBashCommand]);
        } else {
          throw new Error('Git Bash not found');
        }
      } else if (terminalId === 'alacritty') {
        // Alacritty - launch with PowerShell
        await spawnWindowsTerminal('alacritty', ['-e', 'powershell', '-NoExit', '-Command', escapedCommand]);
      } else if (terminalId === 'wezterm') {
        // WezTerm - use start subcommand with PowerShell
        await spawnWindowsTerminal('wezterm', ['start', '--', 'powershell', '-NoExit', '-Command', escapedCommand]);
      } else if (terminalId === 'cmd') {
        // Command Prompt - spawn cmd.exe with /k (keep window open)
        // The command runs PowerShell to execute the install script
        const cmdPath = process.env.ComSpec || path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'cmd.exe');
        await spawnWindowsTerminal(cmdPath, ['/k', 'powershell', '-NoExit', '-Command', escapedCommand]);
      } else if (terminalId === 'conemu') {
        // ConEmu - open with PowerShell tab running the command
        const conemuPaths = [
          'C:\\Program Files\\ConEmu\\ConEmu64.exe',
          'C:\\Program Files (x86)\\ConEmu\\ConEmu.exe',
        ];
        const conemuPath = conemuPaths.find(p => existsSync(p));
        if (conemuPath) {
          // ConEmu uses -run to specify the command to execute
          await spawnWindowsTerminal(conemuPath, ['-run', `powershell -NoExit -Command ${escapedCommand}`]);
        } else {
          // Fall back to PowerShell if ConEmu not found
          console.warn('[Claude Code] ConEmu not found, falling back to PowerShell');
          await spawnWindowsTerminal('powershell', ['-NoExit', '-Command', escapedCommand]);
        }
      } else if (terminalId === 'cmder') {
        // Cmder - portable console emulator for Windows
        const cmderPaths = [
          'C:\\cmder\\Cmder.exe',
          'C:\\tools\\cmder\\Cmder.exe',
          path.join(process.env.CMDER_ROOT || '', 'Cmder.exe'),
        ].filter(p => p); // Remove empty paths
        const cmderPath = cmderPaths.find(p => existsSync(p));
        if (cmderPath) {
          // Cmder uses /TASK for predefined tasks or /START for directory, but we can use /C for command
          await spawnWindowsTerminal(cmderPath, ['/SINGLE', '/START', '', '/TASK', `powershell -NoExit -Command ${escapedCommand}`]);
        } else {
          // Fall back to PowerShell if Cmder not found
          console.warn('[Claude Code] Cmder not found, falling back to PowerShell');
          await spawnWindowsTerminal('powershell', ['-NoExit', '-Command', escapedCommand]);
        }
      } else if (terminalId === 'hyper') {
        // Hyper - Electron-based terminal
        const hyperPaths = [
          path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Hyper', 'Hyper.exe'),
          path.join(process.env.USERPROFILE || '', 'AppData', 'Local', 'Programs', 'Hyper', 'Hyper.exe'),
        ];
        const hyperPath = hyperPaths.find(p => existsSync(p));
        if (hyperPath) {
          // Launch Hyper and it will pick up the shell; send command via PowerShell since Hyper
          // doesn't have a built-in way to run commands on startup
          await spawnWindowsTerminal(hyperPath, []);
          console.warn('[Claude Code] Hyper opened - command must be pasted manually');
        } else {
          console.warn('[Claude Code] Hyper not found, falling back to PowerShell');
          await spawnWindowsTerminal('powershell', ['-NoExit', '-Command', escapedCommand]);
        }
      } else if (terminalId === 'tabby') {
        // Tabby (formerly Terminus) - modern terminal for Windows
        const tabbyPaths = [
          path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Tabby', 'Tabby.exe'),
          path.join(process.env.USERPROFILE || '', 'AppData', 'Local', 'Programs', 'Tabby', 'Tabby.exe'),
        ];
        const tabbyPath = tabbyPaths.find(p => existsSync(p));
        if (tabbyPath) {
          // Tabby opens with default shell; similar to Hyper, no command line arg for running commands
          await spawnWindowsTerminal(tabbyPath, []);
          console.warn('[Claude Code] Tabby opened - command must be pasted manually');
        } else {
          console.warn('[Claude Code] Tabby not found, falling back to PowerShell');
          await spawnWindowsTerminal('powershell', ['-NoExit', '-Command', escapedCommand]);
        }
      } else if (terminalId === 'cygwin') {
        // Cygwin terminal
        const cygwinPaths = [
          'C:\\cygwin64\\bin\\mintty.exe',
          'C:\\cygwin\\bin\\mintty.exe',
        ];
        const cygwinPath = cygwinPaths.find(p => existsSync(p));
        if (cygwinPath) {
          // mintty with bash, escaping for bash context
          const escapedBashCommand = escapeGitBashCommand(command);
          await spawnWindowsTerminal(cygwinPath, ['-e', '/bin/bash', '-lc', escapedBashCommand]);
        } else {
          console.warn('[Claude Code] Cygwin not found, falling back to PowerShell');
          await spawnWindowsTerminal('powershell', ['-NoExit', '-Command', escapedCommand]);
        }
      } else if (terminalId === 'msys2') {
        // MSYS2 terminal
        const msys2Paths = [
          'C:\\msys64\\msys2_shell.cmd',
          'C:\\msys64\\mingw64.exe',
          'C:\\msys64\\usr\\bin\\mintty.exe',
        ];
        const msys2Path = msys2Paths.find(p => existsSync(p));
        if (msys2Path) {
          const escapedBashCommand = escapeGitBashCommand(command);
          if (msys2Path.endsWith('.cmd')) {
            // Use the shell launcher script
            await spawnWindowsTerminal(msys2Path, ['-mingw64', '-c', escapedBashCommand]);
          } else {
            // Use mintty directly
            await spawnWindowsTerminal(msys2Path, ['-e', '/bin/bash', '-lc', escapedBashCommand]);
          }
        } else {
          console.warn('[Claude Code] MSYS2 not found, falling back to PowerShell');
          await spawnWindowsTerminal('powershell', ['-NoExit', '-Command', escapedCommand]);
        }
      } else {
        // Default: PowerShell (handles 'powershell', 'system', or any unknown value)
        // Spawn PowerShell directly with the command - this is more reliable than using CMD's start command
        await spawnWindowsTerminal('powershell', ['-NoExit', '-Command', escapedCommand]);
      }
    } catch (err) {
      console.error('[Claude Code] Terminal execution failed:', err);
      throw new Error(`Failed to open terminal: ${err instanceof Error ? err.message : 'Unknown error'}`);
    }
  } else {
    // Linux: Use preferred terminal or try common emulators
    // Values match SupportedTerminal type: 'gnometerminal', 'konsole', 'xfce4terminal', 'tilix', etc.
    const terminalId = preferredTerminal?.toLowerCase() || '';

    console.warn('[Claude Code] Using terminal:', terminalId || 'auto-detect');

    // Command to run (keep terminal open after execution)
    // Note: Currently all commands come from trusted sources (getInstallCommand, getInstallVersionCommand),
    // which return multi-statement commands with semicolons as separators.
    // We do NOT escape these commands to preserve the semicolon command separators.
    // If future code needs to pass user input here, that input must be pre-sanitized.
    const bashCommand = `${command}; exec bash`;

    // Try to use preferred terminal if specified
    if (terminalId === 'gnometerminal') {
      spawn('gnome-terminal', ['--', 'bash', '-c', bashCommand], { detached: true, stdio: 'ignore' }).unref();
      return;
    } else if (terminalId === 'konsole') {
      spawn('konsole', ['-e', 'bash', '-c', bashCommand], { detached: true, stdio: 'ignore' }).unref();
      return;
    } else if (terminalId === 'xfce4terminal') {
      spawn('xfce4-terminal', ['-e', `bash -c "${bashCommand}"`], { detached: true, stdio: 'ignore' }).unref();
      return;
    } else if (terminalId === 'lxterminal') {
      spawn('lxterminal', ['-e', `bash -c "${bashCommand}"`], { detached: true, stdio: 'ignore' }).unref();
      return;
    } else if (terminalId === 'mate-terminal') {
      spawn('mate-terminal', ['-e', `bash -c "${bashCommand}"`], { detached: true, stdio: 'ignore' }).unref();
      return;
    } else if (terminalId === 'tilix') {
      spawn('tilix', ['-e', 'bash', '-c', bashCommand], { detached: true, stdio: 'ignore' }).unref();
      return;
    } else if (terminalId === 'terminator') {
      spawn('terminator', ['-e', `bash -c "${bashCommand}"`], { detached: true, stdio: 'ignore' }).unref();
      return;
    } else if (terminalId === 'guake') {
      spawn('guake', ['-e', bashCommand], { detached: true, stdio: 'ignore' }).unref();
      return;
    } else if (terminalId === 'yakuake') {
      spawn('yakuake', ['-e', bashCommand], { detached: true, stdio: 'ignore' }).unref();
      return;
    } else if (terminalId === 'kitty') {
      spawn('kitty', ['--', 'bash', '-c', bashCommand], { detached: true, stdio: 'ignore' }).unref();
      return;
    } else if (terminalId === 'alacritty') {
      spawn('alacritty', ['-e', 'bash', '-c', bashCommand], { detached: true, stdio: 'ignore' }).unref();
      return;
    } else if (terminalId === 'wezterm') {
      spawn('wezterm', ['start', '--', 'bash', '-c', bashCommand], { detached: true, stdio: 'ignore' }).unref();
      return;
    } else if (terminalId === 'hyper') {
      spawn('hyper', [], { detached: true, stdio: 'ignore' }).unref();
      return;
    } else if (terminalId === 'tabby') {
      spawn('tabby', [], { detached: true, stdio: 'ignore' }).unref();
      return;
    } else if (terminalId === 'xterm') {
      spawn('xterm', ['-e', 'bash', '-c', bashCommand], { detached: true, stdio: 'ignore' }).unref();
      return;
    } else if (terminalId === 'urxvt') {
      spawn('urxvt', ['-e', 'bash', '-c', bashCommand], { detached: true, stdio: 'ignore' }).unref();
      return;
    } else if (terminalId === 'st') {
      spawn('st', ['-e', 'bash', '-c', bashCommand], { detached: true, stdio: 'ignore' }).unref();
      return;
    } else if (terminalId === 'foot') {
      spawn('foot', ['bash', '-c', bashCommand], { detached: true, stdio: 'ignore' }).unref();
      return;
    }

    // Auto-detect (for 'system' or no preference): try common terminal emulators in order
    const terminals: Array<{ cmd: string; args: string[] }> = [
      { cmd: 'gnome-terminal', args: ['--', 'bash', '-c', bashCommand] },
      { cmd: 'konsole', args: ['-e', 'bash', '-c', bashCommand] },
      { cmd: 'xfce4-terminal', args: ['-e', `bash -c "${bashCommand}"`] },
      { cmd: 'tilix', args: ['-e', 'bash', '-c', bashCommand] },
      { cmd: 'terminator', args: ['-e', `bash -c "${bashCommand}"`] },
      { cmd: 'kitty', args: ['--', 'bash', '-c', bashCommand] },
      { cmd: 'alacritty', args: ['-e', 'bash', '-c', bashCommand] },
      { cmd: 'xterm', args: ['-e', 'bash', '-c', bashCommand] },
    ];

    let opened = false;
    for (const { cmd, args } of terminals) {
      try {
        spawn(cmd, args, { detached: true, stdio: 'ignore' }).unref();
        opened = true;
        console.warn('[Claude Code] Opened terminal:', cmd);
        break;
      } catch {
      }
    }

    if (!opened) {
      throw new Error('No supported terminal emulator found');
    }
  }
}
