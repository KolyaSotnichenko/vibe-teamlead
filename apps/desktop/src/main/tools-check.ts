/**
 * Detect the external tools the pipeline uses (security gates, browser QA,
 * Strix) and report what is bundled, installed or missing.
 */

import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, win32 } from 'node:path';

import { resolveBundledTools } from './ai/claude-code/bundled-tools';
import { dockerAvailable, strixPath } from './ai/security/strix';
import { findOnPath, runProcess } from './platform/exec';
import { getPlatformKey } from './platform';
import { envValue } from './platform/env';
import { findGitBash } from './platform/git-bash';
import type { ToolCheck } from '../shared/types/tools-check';
import { startDockerCommand, toolInstallHints } from '../shared/utils/tool-install-hints';

async function version(bin: string, args = ['--version']): Promise<string | undefined> {
  const result = await runProcess(bin, args, { timeoutMs: 5000, maxOutput: 2000 });
  if (result.code !== 0) return undefined;
  const line = `${result.stdout}${result.stderr}`.trim().split('\n')[0];
  return line ? line.slice(0, 80) : undefined;
}

/** Where Google Chrome is installed: the app on macOS, chrome.exe in its install folders on Windows, PATH elsewhere. */
export function findChrome(
  platform: 'darwin' | 'win32' | 'linux' = getPlatformKey(),
  env: NodeJS.ProcessEnv = process.env,
  exists: (path: string) => boolean = existsSync
): string | undefined {
  if (platform === 'darwin') {
    const app = 'Google Chrome.app/Contents/MacOS/Google Chrome';
    return [join('/Applications', app), join(homedir(), 'Applications', app)].find((p) => exists(p));
  }
  if (platform === 'win32') {
    const exe = win32.join('Google', 'Chrome', 'Application', 'chrome.exe');
    return ['ProgramFiles', 'ProgramFiles(x86)', 'LOCALAPPDATA']
      .map((name) => envValue(env, name))
      .filter((dir): dir is string => !!dir)
      .map((dir) => win32.join(dir, exe))
      .find((p) => exists(p));
  }
  return findOnPath('google-chrome') ?? findOnPath('google-chrome-stable');
}

/** A scanner from the app's Resources/scanners folder, with either path separator. Pure. */
export function isBundledScanner(path: string | undefined): boolean {
  return !!path && /[\\/]scanners[\\/]/.test(path);
}

/** Git for Windows: agents (Claude Code's Bash tool) and app checks run commands with its bash. Windows only. */
function gitBashRow(platform: 'darwin' | 'win32' | 'linux'): ToolCheck[] {
  if (platform !== 'win32') return [];
  const bash = findGitBash({ platform });
  return [
    {
      id: 'git-bash',
      status: bash ? 'ready' : 'missing',
      path: bash ?? undefined,
      ...installHint(platform, 'git-bash'),
      neededFor: 'agents',
      optional: false,
    },
  ];
}

/** installCommand and installUrl of a tool for this platform */
function installHint(platform: 'darwin' | 'win32' | 'linux', id: ToolCheck['id']): Pick<ToolCheck, 'installCommand' | 'installUrl'> {
  const hint = toolInstallHints(platform)[id];
  return { installCommand: hint?.command, installUrl: hint?.url };
}

export async function checkTools(platform: 'darwin' | 'win32' | 'linux' = getPlatformKey()): Promise<ToolCheck[]> {
  const bundled = resolveBundledTools();
  const installed = async (bin: string | undefined): Promise<Pick<ToolCheck, 'status' | 'path' | 'version'>> =>
    bin ? { status: 'ready', path: bin, version: await version(bin) } : { status: 'missing' };

  const strixBin = findOnPath('strix', strixPath());
  const dockerBin = findOnPath('docker', strixPath());
  const chrome = findChrome(platform);

  const [gitleaks, osv, semgrep, strix, dockerRunning] = await Promise.all([
    installed(bundled.gitleaksBin),
    installed(bundled.osvScannerBin),
    installed(bundled.semgrepBin),
    installed(strixBin),
    dockerBin ? dockerAvailable() : Promise.resolve(false),
  ]);

  return [
    {
      id: 'claude-code',
      status: bundled.claudeCodeExecutable ? 'bundled' : 'missing',
      path: bundled.claudeCodeExecutable,
      neededFor: 'agents',
      optional: false,
    },
    ...gitBashRow(platform),
    { id: 'codegraph', status: bundled.codegraphBin ? 'bundled' : 'missing', path: bundled.codegraphBin, neededFor: 'code_graph', optional: true },
    {
      id: 'gitleaks',
      ...gitleaks,
      // Bundled in release builds (Resources/scanners); an install by the user (Homebrew, winget) works too.
      status: gitleaks.status === 'ready' && isBundledScanner(bundled.gitleaksBin) ? 'bundled' : gitleaks.status,
      ...installHint(platform, 'gitleaks'),
      neededFor: 'security_gates',
      optional: true,
    },
    {
      id: 'osv-scanner',
      ...osv,
      status: osv.status === 'ready' && isBundledScanner(bundled.osvScannerBin) ? 'bundled' : osv.status,
      ...installHint(platform, 'osv-scanner'),
      neededFor: 'security_gates',
      optional: true,
    },
    {
      // Never bundled (a Python package): used when installed
      id: 'semgrep',
      ...semgrep,
      ...installHint(platform, 'semgrep'),
      neededFor: 'security_gates',
      optional: true,
    },
    {
      id: 'chrome',
      status: chrome ? 'ready' : 'missing',
      path: chrome,
      ...installHint(platform, 'chrome'),
      neededFor: 'browser_qa',
      optional: true,
    },
    {
      id: 'docker',
      status: !dockerBin ? 'missing' : dockerRunning ? 'ready' : 'not_running',
      path: dockerBin,
      ...installHint(platform, 'docker'),
      startCommand: startDockerCommand(platform),
      neededFor: 'security_qa',
      optional: true,
    },
    {
      id: 'strix',
      ...strix,
      ...installHint(platform, 'strix'),
      neededFor: 'security_qa',
      optional: true,
    },
  ];
}
