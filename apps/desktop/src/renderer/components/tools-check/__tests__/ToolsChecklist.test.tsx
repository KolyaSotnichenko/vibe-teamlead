/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom';
import { ToolsChecklist } from '../ToolsChecklist';
import { sampleToolChecks } from '../../../lib/mocks/tools-mock';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => (opts ? `${key} ${JSON.stringify(opts)}` : key),
    i18n: { language: 'en' },
  }),
}));

vi.mock('../../../stores/settings-store', () => ({
  useSettingsStore: (selector: (s: unknown) => unknown) => selector({ settings: { securityQaEnabled: false } }),
}));

const check = vi.fn();
const openExternal = vi.fn();
const writeText = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  check.mockResolvedValue({ success: true, data: sampleToolChecks });
  writeText.mockResolvedValue(undefined);
  Object.defineProperty(window, 'electronAPI', { value: { tools: { check }, openExternal }, writable: true, configurable: true });
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
});

const row = (name: string) => screen.getByText(name, { selector: 'p' }).closest('li') as HTMLElement;

describe('ToolsChecklist', () => {
  it('shows a pending row, then one row per tool with its status in words', async () => {
    render(<ToolsChecklist />);
    expect(screen.getByText('tools.checking')).toBeInTheDocument();

    await waitFor(() => expect(screen.getByText('OSV-Scanner')).toBeInTheDocument());
    for (const name of ['Claude Code', 'CodeGraph', 'gitleaks', 'Google Chrome', 'Docker', 'Strix']) {
      expect(screen.getByText(name, { selector: 'p' })).toBeInTheDocument();
    }
    expect(within(row('gitleaks')).getByText('tools.status.ready')).toBeInTheDocument();
    expect(within(row('gitleaks')).getByText('v8.28.0 · /opt/homebrew/bin/gitleaks')).toBeInTheDocument();
    expect(within(row('OSV-Scanner')).getByText('tools.status.missing')).toBeInTheDocument();
    expect(within(row('Docker')).getByText('tools.status.not_running')).toBeInTheDocument();
    expect(within(row('Claude Code')).getByText('tools.status.bundled')).toBeInTheDocument();
    expect(screen.getByText('tools.optionalNote')).toBeInTheDocument();
  });

  it('summarises each area', async () => {
    render(<ToolsChecklist />);
    await waitFor(() => expect(screen.getByText('tools.areas.browser_qa.title:')).toBeInTheDocument());
    expect(screen.getByText(/tools\.summary\.needs .*OSV-Scanner/)).toBeInTheDocument();
    expect(screen.getByText(/tools\.summary\.needs .*tools\.summary\.running.*Docker.*Strix/)).toBeInTheDocument();
    expect(screen.getByText(/tools\.summary\.securityQaOff/)).toBeInTheDocument();
  });

  it('shows the install command with Copy and a guide link for a missing tool', async () => {
    render(<ToolsChecklist />);
    await waitFor(() => expect(screen.getByText('brew install osv-scanner')).toBeInTheDocument());
    const osv = row('OSV-Scanner');

    await act(async () => {
      fireEvent.click(within(osv).getByRole('button', { name: /tools\.copyFor/ }));
    });
    expect(writeText).toHaveBeenCalledWith('brew install osv-scanner');
    expect(within(osv).getByText('tools.copied')).toBeInTheDocument();

    fireEvent.click(within(osv).getByRole('button', { name: /tools\.guideFor/ }));
    expect(openExternal).toHaveBeenCalledWith('https://google.github.io/osv-scanner/installation/');
  });

  it('tells the user to start Docker Desktop when Docker is not running', async () => {
    render(<ToolsChecklist />);
    await waitFor(() => expect(screen.getByText('Docker', { selector: 'p' })).toBeInTheDocument());
    const docker = row('Docker');
    expect(within(docker).getByText('tools.fix.startDocker')).toBeInTheDocument();
    expect(within(docker).getByText('open -a Docker')).toBeInTheDocument();
    expect(within(docker).queryByRole('button', { name: /tools\.guideFor/ })).not.toBeInTheDocument();
  });

  it('runs the check again on "Check again"', async () => {
    render(<ToolsChecklist />);
    await waitFor(() => expect(screen.getByText('OSV-Scanner')).toBeInTheDocument());
    check.mockResolvedValueOnce({
      success: true,
      data: sampleToolChecks.map((t) => (t.id === 'osv-scanner' ? { ...t, status: 'ready', version: '2.0.2' } : t)),
    });
    fireEvent.click(screen.getByRole('button', { name: /tools\.checkAgain/ }));
    expect(screen.getByText('tools.checkingAgain')).toBeInTheDocument();
    await waitFor(() => expect(within(row('OSV-Scanner')).getByText('tools.status.ready')).toBeInTheDocument());
    expect(check).toHaveBeenCalledTimes(2);
  });

  it('shows the error and keeps "Check again" available when the check fails', async () => {
    check.mockResolvedValue({ success: false, error: 'spawn failed' });
    render(<ToolsChecklist />);
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('spawn failed'));
    expect(screen.getByRole('button', { name: /tools\.checkAgain/ })).not.toBeDisabled();
  });
});
