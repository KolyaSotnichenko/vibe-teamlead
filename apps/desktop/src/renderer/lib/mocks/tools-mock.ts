/** Browser preview of the tools check: a typical fresh Mac. */

import type { ToolCheck, ToolsCheckAPI } from '../../../shared/types';

export const sampleToolChecks: ToolCheck[] = [
  { id: 'claude-code', status: 'bundled', neededFor: 'agents', optional: false },
  { id: 'codegraph', status: 'bundled', neededFor: 'code_graph', optional: true },
  { id: 'gitleaks', status: 'ready', version: 'v8.28.0', path: '/opt/homebrew/bin/gitleaks', installCommand: 'brew install gitleaks', installUrl: 'https://github.com/gitleaks/gitleaks#installing', neededFor: 'security_gates', optional: true },
  { id: 'osv-scanner', status: 'missing', installCommand: 'brew install osv-scanner', installUrl: 'https://google.github.io/osv-scanner/installation/', neededFor: 'security_gates', optional: true },
  { id: 'chrome', status: 'ready', path: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', installCommand: 'brew install --cask google-chrome', installUrl: 'https://www.google.com/chrome/', neededFor: 'browser_qa', optional: true },
  { id: 'docker', status: 'not_running', path: '/usr/local/bin/docker', installCommand: 'brew install --cask docker', installUrl: 'https://docs.docker.com/desktop/setup/install/mac-install/', neededFor: 'security_qa', optional: true },
  { id: 'strix', status: 'missing', installCommand: 'uv tool install strix-agent', installUrl: 'https://github.com/usestrix/strix', neededFor: 'security_qa', optional: true },
];

export const toolsMock: ToolsCheckAPI = {
  check: async () => ({ success: true, data: sampleToolChecks }),
};
