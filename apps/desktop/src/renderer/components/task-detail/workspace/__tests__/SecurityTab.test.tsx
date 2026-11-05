/**
 * @vitest-environment jsdom
 */
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import { SecurityTab } from '../SecurityTab';
import type { TaskWorkspace } from '../../../../../shared/types';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => (opts ? `${key} ${JSON.stringify(opts)}` : key),
    i18n: { language: 'en' },
  }),
}));

const workspace = (security: TaskWorkspace['security']): TaskWorkspace => ({
  specDir: '/tmp/spec',
  hasQaCoverage: false,
  timeline: [],
  architecture: { adrs: [], diagrams: [] },
  security,
});

describe('SecurityTab partial gates', () => {
  it('says which files a gate could not scan', () => {
    render(<SecurityTab workspace={workspace({ gates: { ran: ['semgrep'], skipped: [], partial: [{ gate: 'semgrep', reason: 'could not scan 1 file: a.ts' }], findings: [] } })} />);
    expect(screen.getByText('tasks:workspace.security.partial {"gate":"semgrep","reason":"could not scan 1 file: a.ts"}')).toBeInTheDocument();
  });
});

describe('SecurityTab skipped hints', () => {
  it('adds the install command and Settings → Tools to a gate skipped for a missing scanner', () => {
    render(
      <SecurityTab
        workspace={workspace({
          gates: {
            ran: ['gitleaks'],
            skipped: [
              { gate: 'osv-scanner', reason: 'OSV-Scanner is not available' },
              { gate: 'gitleaks', reason: 'nothing to scan' },
            ],
            findings: [],
          },
        })}
      />
    );
    expect(screen.getByText('brew install osv-scanner')).toBeInTheDocument();
    expect(screen.queryByText('brew install gitleaks')).not.toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'settings:tools.securityHint.openSettings' })).toHaveLength(1);
  });

  it('opens Settings → Tools from the hint', () => {
    const listener = vi.fn();
    window.addEventListener('open-app-settings', listener);
    render(
      <SecurityTab
        workspace={workspace({ gates: { ran: [], skipped: [{ gate: 'gitleaks', reason: 'gitleaks is not available' }], findings: [] } })}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: 'settings:tools.securityHint.openSettings' }));
    expect((listener.mock.calls[0][0] as CustomEvent).detail).toBe('tools');
    window.removeEventListener('open-app-settings', listener);
  });

  it('tells how to start Docker when Security QA was skipped for it', () => {
    render(<SecurityTab workspace={workspace({ pentest: { status: 'skipped', reason: 'Docker is not running', findings: [] } })} />);
    expect(screen.getByText('open -a Docker')).toBeInTheDocument();
    expect(screen.getByText('settings:tools.securityHint.start')).toBeInTheDocument();
  });

  it('tells how to install Strix when Security QA was skipped for it', () => {
    render(
      <SecurityTab
        workspace={workspace({ pentest: { status: 'skipped', reason: 'Strix is not installed (uv tool install strix-agent)', findings: [] } })}
      />
    );
    expect(screen.getByText('uv tool install strix-agent')).toBeInTheDocument();
  });

  it('adds no hint for a skip that a tool cannot fix', () => {
    render(
      <SecurityTab
        workspace={workspace({ pentest: { status: 'skipped', reason: 'Strix needs an Anthropic API key', findings: [] } })}
      />
    );
    expect(screen.queryByRole('button', { name: 'settings:tools.securityHint.openSettings' })).not.toBeInTheDocument();
  });
});
