/**
 * How the user installs (or starts) each external tool, per platform.
 * Homebrew on macOS; winget on Windows (pip for Semgrep, which has no winget package).
 * Pure: the main process fills the tools check from it, and the renderer uses it for
 * skip hints in reports, where no check has run.
 */

import type { ToolId } from '../types/tools-check';

export type HintPlatform = 'darwin' | 'win32' | 'linux';

export interface ToolInstallHint {
  /** Terminal command that installs the tool */
  command: string;
  /** Page with installation instructions */
  url: string;
}

const STRIX: ToolInstallHint = { command: 'uv tool install strix-agent', url: 'https://github.com/usestrix/strix' };

const MAC: Partial<Record<ToolId, ToolInstallHint>> = {
  gitleaks: { command: 'brew install gitleaks', url: 'https://github.com/gitleaks/gitleaks#installing' },
  'osv-scanner': { command: 'brew install osv-scanner', url: 'https://google.github.io/osv-scanner/installation/' },
  semgrep: { command: 'brew install semgrep', url: 'https://semgrep.dev/docs/getting-started/quickstart' },
  chrome: { command: 'brew install --cask google-chrome', url: 'https://www.google.com/chrome/' },
  docker: { command: 'brew install --cask docker', url: 'https://docs.docker.com/desktop/setup/install/mac-install/' },
  strix: STRIX,
};

const WINDOWS: Partial<Record<ToolId, ToolInstallHint>> = {
  'git-bash': { command: 'winget install --id Git.Git -e', url: 'https://git-scm.com/download/win' },
  gitleaks: { command: 'winget install --id Gitleaks.Gitleaks -e', url: 'https://github.com/gitleaks/gitleaks#installing' },
  'osv-scanner': { command: 'winget install --id Google.OSVScanner -e', url: 'https://google.github.io/osv-scanner/installation/' },
  semgrep: { command: 'pip install semgrep', url: 'https://semgrep.dev/docs/getting-started/quickstart' },
  chrome: { command: 'winget install --id Google.Chrome -e', url: 'https://www.google.com/chrome/' },
  docker: { command: 'winget install --id Docker.DockerDesktop -e', url: 'https://docs.docker.com/desktop/setup/install/windows-install/' },
  strix: STRIX,
};

export function toolInstallHints(platform: HintPlatform): Partial<Record<ToolId, ToolInstallHint>> {
  return platform === 'win32' ? WINDOWS : MAC;
}

/** Command that starts Docker Desktop. */
export function startDockerCommand(platform: HintPlatform): string {
  return platform === 'win32' ? 'start "" "%ProgramFiles%\\Docker\\Docker\\Docker Desktop.exe"' : 'open -a Docker';
}
