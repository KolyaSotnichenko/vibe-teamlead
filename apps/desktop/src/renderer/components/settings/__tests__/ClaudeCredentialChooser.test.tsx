/**
 * @vitest-environment jsdom
 */
/**
 * One chooser for every place that asks for the Claude credential (Settings → Claude,
 * the onboarding wizard, the GitHub setup dialog): API key by default, or a Claude
 * subscription token; the choice is saved as soon as it is picked.
 */
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { saveSettings, openClaudeSetupToken } = vi.hoisted(() => ({
  saveSettings: vi.fn(async () => true),
  openClaudeSetupToken: vi.fn(),
}));
vi.mock('../../../stores/settings-store', () => ({ saveSettings }));
vi.mock('../../../lib/open-terminal', () => ({ openClaudeSetupToken }));
vi.mock('../ClaudeCredentialPanel', () => ({
  ClaudeCredentialPanel: ({ slot = 'api' }: { slot?: string }) => <div>panel:{slot}</div>,
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }) }));

import { ClaudeCredentialChooser, isModeConfigured } from '../ClaudeCredentialChooser';

const status = { configured: false, source: 'none' } as const;

describe('ClaudeCredentialChooser', () => {
  beforeEach(() => vi.clearAllMocks());

  it('defaults to the API key: shows the key panel, not "Get a token"', () => {
    render(<ClaudeCredentialChooser subscription={false} status={status} onStatusChange={vi.fn()} />);
    expect(screen.getByText('panel:api')).toBeTruthy();
    expect(screen.queryByText('claude.setupToken.button')).toBeNull();
    expect(screen.getByRole('radio', { name: /claude\.mode\.api\b/ }).getAttribute('aria-checked')).toBe('true');
  });

  it('saves the subscription mode as soon as it is picked and reports it', () => {
    const onModeChange = vi.fn();
    render(<ClaudeCredentialChooser subscription={false} onModeChange={onModeChange} status={status} onStatusChange={vi.fn()} />);
    fireEvent.click(screen.getByText('claude.mode.subscription'));
    expect(saveSettings).toHaveBeenCalledWith({ useClaudeSubscription: true });
    expect(onModeChange).toHaveBeenCalledWith(true);
  });

  it('saves the API mode back when it is picked', () => {
    render(<ClaudeCredentialChooser subscription status={status} onStatusChange={vi.fn()} />);
    fireEvent.click(screen.getByText('claude.mode.api'));
    expect(saveSettings).toHaveBeenCalledWith({ useClaudeSubscription: false });
  });

  it('in subscription mode, shows the token panel and "Get a token" opens the setup-token terminal', () => {
    render(<ClaudeCredentialChooser subscription status={status} onStatusChange={vi.fn()} />);
    expect(screen.getByText('panel:subscription')).toBeTruthy();
    expect(screen.queryByText('panel:api')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'claude.setupToken.button' }));
    expect(openClaudeSetupToken).toHaveBeenCalledTimes(1);
  });

  it('renders the API extras (the base URL field in Settings) only in API mode', () => {
    const { rerender } = render(
      <ClaudeCredentialChooser subscription={false} status={status} onStatusChange={vi.fn()} apiExtra={<div>base-url</div>} />
    );
    expect(screen.getByText('base-url')).toBeTruthy();
    rerender(<ClaudeCredentialChooser subscription status={status} onStatusChange={vi.fn()} apiExtra={<div>base-url</div>} />);
    expect(screen.queryByText('base-url')).toBeNull();
  });
});

describe('isModeConfigured', () => {
  it('checks the slot the mode uses', () => {
    const s = {
      configured: true,
      source: 'stored' as const,
      api: { configured: true, source: 'stored' as const },
      subscription: { configured: false, source: 'none' as const },
    };
    expect(isModeConfigured(s, false)).toBe(true);
    expect(isModeConfigured(s, true)).toBe(false);
  });

  it('falls back to the active credential when the slots are not reported', () => {
    expect(isModeConfigured({ configured: true, source: 'stored' }, false)).toBe(true);
    expect(isModeConfigured({ configured: false, source: 'none' }, true)).toBe(false);
  });
});
