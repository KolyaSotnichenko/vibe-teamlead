/**
 * @vitest-environment jsdom
 */
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

const { openClaudeSetupToken } = vi.hoisted(() => ({ openClaudeSetupToken: vi.fn() }));
vi.mock('../../../lib/open-terminal', () => ({ openClaudeSetupToken }));
vi.mock('../../../stores/settings-store', () => ({ saveSettings: vi.fn(async () => true) }));
vi.mock('../../../hooks/useClaudeCredential', () => ({ useClaudeCredential: () => ({ status: {}, setStatus: vi.fn() }) }));
vi.mock('../ClaudeCredentialPanel', () => ({ ClaudeCredentialPanel: () => null }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }) }));

import { ClaudeSettings } from '../ClaudeSettings';

describe('ClaudeSettings "Get a token"', () => {
  it('in subscription mode, asks the app for the setup-token terminal', () => {
    render(<ClaudeSettings settings={{ useClaudeSubscription: true } as never} onSettingsChange={vi.fn()} />);
    expect(screen.getByText('claude.setupToken.help')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'claude.setupToken.button' }));
    expect(openClaudeSetupToken).toHaveBeenCalledTimes(1);
  });

  it('is not shown in API key mode (the default)', () => {
    render(<ClaudeSettings settings={{} as never} onSettingsChange={vi.fn()} />);
    expect(screen.queryByText('claude.setupToken.button')).toBeNull();
  });
});
