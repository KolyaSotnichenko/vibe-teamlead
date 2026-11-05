/**
 * Detect the external tools the pipeline uses (security gates, browser QA,
 * Strix) and report what is bundled, installed or missing.
 */

import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { resolveBundledTools } from './ai/claude-code/bundled-tools';
import { dockerAvailable, strixPath } from './ai/security/strix';
import { findOnPath, runProcess } from './platform/exec';
import { isMacOS } from './platform';
import type { ToolCheck } from '../shared/types/tools-check';

async function version(bin: string, args = ['--version']): Promise<string | undefined> {
  const result = await runProcess(bin, args, { timeoutMs: 5000, maxOutput: 2000 });
  if (result.code !== 0) return undefined;
  const line = `${result.stdout}${result.stderr}`.trim().split('\n')[0];
  return line ? line.slice(0, 80) : undefined;
}

function findChrome(): string | undefined {
  if (isMacOS()) {
    const app = 'Google Chrome.app/Contents/MacOS/Google Chrome';
    return [join('/Applications', app), join(homedir(), 'Applications', app)].find((p) => existsSync(p));
  }
  return findOnPath('google-chrome') ?? findOnPath('google-chrome-stable');
}

export async function checkTools(): Promise<ToolCheck[]> {
  const bundled = resolveBundledTools();
  const installed = async (bin: string | undefined): Promise<Pick<ToolCheck, 'status' | 'path' | 'version'>> =>
    bin ? { status: 'ready', path: bin, version: await version(bin) } : { status: 'missing' };

  const strixBin = findOnPath('strix', strixPath());
  const dockerBin = findOnPath('docker', strixPath());
  const chrome = findChrome();

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
    { id: 'codegraph', status: bundled.codegraphBin ? 'bundled' : 'missing', path: bundled.codegraphBin, neededFor: 'code_graph', optional: true },
    {
      id: 'gitleaks',
      ...gitleaks,
      // Bundled in release builds (Resources/scanners); a Homebrew install works too.
      status: gitleaks.status === 'ready' && bundled.gitleaksBin?.includes('/scanners/') ? 'bundled' : gitleaks.status,
      installCommand: 'brew install gitleaks',
      installUrl: 'https://github.com/gitleaks/gitleaks#installing',
      neededFor: 'security_gates',
      optional: true,
    },
    {
      id: 'osv-scanner',
      ...osv,
      status: osv.status === 'ready' && bundled.osvScannerBin?.includes('/scanners/') ? 'bundled' : osv.status,
      installCommand: 'brew install osv-scanner',
      installUrl: 'https://google.github.io/osv-scanner/installation/',
      neededFor: 'security_gates',
      optional: true,
    },
    {
      // Never bundled (a Python package): used when installed
      id: 'semgrep',
      ...semgrep,
      installCommand: 'brew install semgrep',
      installUrl: 'https://semgrep.dev/docs/getting-started/quickstart',
      neededFor: 'security_gates',
      optional: true,
    },
    {
      id: 'chrome',
      status: chrome ? 'ready' : 'missing',
      path: chrome,
      installCommand: 'brew install --cask google-chrome',
      installUrl: 'https://www.google.com/chrome/',
      neededFor: 'browser_qa',
      optional: true,
    },
    {
      id: 'docker',
      status: !dockerBin ? 'missing' : dockerRunning ? 'ready' : 'not_running',
      path: dockerBin,
      installCommand: 'brew install --cask docker',
      installUrl: 'https://docs.docker.com/desktop/setup/install/mac-install/',
      neededFor: 'security_qa',
      optional: true,
    },
    {
      id: 'strix',
      ...strix,
      installCommand: 'uv tool install strix-agent',
      installUrl: 'https://github.com/usestrix/strix',
      neededFor: 'security_qa',
      optional: true,
    },
  ];
}
