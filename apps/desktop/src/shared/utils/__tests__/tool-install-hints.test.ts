import { describe, expect, it } from 'vitest';
import { startDockerCommand, toolInstallHints } from '../tool-install-hints';

describe('toolInstallHints', () => {
  it('keeps Homebrew on macOS exactly as before', () => {
    expect(toolInstallHints('darwin')).toEqual({
      gitleaks: { command: 'brew install gitleaks', url: 'https://github.com/gitleaks/gitleaks#installing' },
      'osv-scanner': { command: 'brew install osv-scanner', url: 'https://google.github.io/osv-scanner/installation/' },
      semgrep: { command: 'brew install semgrep', url: 'https://semgrep.dev/docs/getting-started/quickstart' },
      chrome: { command: 'brew install --cask google-chrome', url: 'https://www.google.com/chrome/' },
      docker: { command: 'brew install --cask docker', url: 'https://docs.docker.com/desktop/setup/install/mac-install/' },
      strix: { command: 'uv tool install strix-agent', url: 'https://github.com/usestrix/strix' },
    });
    expect(startDockerCommand('darwin')).toBe('open -a Docker');
  });

  it('uses winget on Windows (pip for Semgrep, which has no winget package)', () => {
    const hints = toolInstallHints('win32');
    expect(hints.gitleaks?.command).toBe('winget install --id Gitleaks.Gitleaks -e');
    expect(hints['osv-scanner']?.command).toBe('winget install --id Google.OSVScanner -e');
    expect(hints.semgrep?.command).toBe('pip install semgrep');
    expect(hints.chrome?.command).toBe('winget install --id Google.Chrome -e');
    expect(hints.docker).toEqual({
      command: 'winget install --id Docker.DockerDesktop -e',
      url: 'https://docs.docker.com/desktop/setup/install/windows-install/',
    });
    expect(hints['git-bash']).toEqual({ command: 'winget install --id Git.Git -e', url: 'https://git-scm.com/download/win' });
    expect(hints.strix?.command).toBe('uv tool install strix-agent');
    expect(Object.values(hints).some((h) => h?.command?.startsWith('brew'))).toBe(false);
    expect(startDockerCommand('win32')).toBe('start "" "%ProgramFiles%\\Docker\\Docker\\Docker Desktop.exe"');
  });
});
