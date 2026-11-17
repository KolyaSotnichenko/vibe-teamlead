/**
 * @vitest-environment jsdom
 */
/**
 * The mode is saved when it is picked, like the key and the connection test next to it:
 * before, it waited for the dialog's Save, so a user could save a subscription token, pass
 * the test, close the dialog, and still run every session in API mode with no key.
 */
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

const { saveSettings } = vi.hoisted(() => ({ saveSettings: vi.fn(async () => true) }));
vi.mock('../../../stores/settings-store', () => ({ saveSettings }));
vi.mock('../../../hooks/useClaudeCredential', () => ({ useClaudeCredential: () => ({ status: {}, setStatus: vi.fn() }) }));
vi.mock('../ClaudeCredentialPanel', () => ({ ClaudeCredentialPanel: () => null }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }) }));

import { ClaudeSettings } from '../ClaudeSettings';

describe('ClaudeSettings mode', () => {
  it('saves the subscription mode as soon as it is picked', () => {
    const onSettingsChange = vi.fn();
    render(<ClaudeSettings settings={{ useClaudeSubscription: false } as never} onSettingsChange={onSettingsChange} />);
    fireEvent.click(screen.getByText('claude.mode.subscription'));
    expect(saveSettings).toHaveBeenCalledWith({ useClaudeSubscription: true });
    expect(onSettingsChange).toHaveBeenCalledWith(expect.objectContaining({ useClaudeSubscription: true }));
  });
});
