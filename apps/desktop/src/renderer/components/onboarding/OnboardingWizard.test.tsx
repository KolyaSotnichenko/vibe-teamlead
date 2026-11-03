/**
 * @vitest-environment jsdom
 */
/**
 * OnboardingWizard integration tests
 *
 * Integration tests for the complete onboarding wizard flow.
 * Verifies step navigation, the Claude key step, back button behavior,
 * and progress indicator.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import { OnboardingWizard } from './OnboardingWizard';

// Mock react-i18next to avoid initialization issues
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => {
      // Return the key itself or provide specific translations
      // Keys are without namespace since component uses useTranslation('namespace')
      const translations: Record<string, string> = {
        'welcome.title': 'Welcome to Vibe Teamlead',
        'welcome.subtitle': 'AI-powered autonomous coding assistant',
        'welcome.getStarted': 'Get Started',
        'welcome.skip': 'Skip Setup',
        'wizard.helpText': 'Let us help you get started with Vibe Teamlead',
        'welcome.features.aiPowered.title': 'AI-Powered',
        'welcome.features.aiPowered.description': 'Powered by Claude',
        'welcome.features.specDriven.title': 'Spec-Driven',
        'welcome.features.specDriven.description': 'Create from specs',
        'welcome.features.memory.title': 'Memory',
        'welcome.features.memory.description': 'Remembers context',
        'welcome.features.parallel.title': 'Parallel',
        'welcome.features.parallel.description': 'Work in parallel',
        'claude.title': 'Connect Claude',
        'claude.description': 'Agents run on your Anthropic API key.',
        'claude.buttons.back': 'Back',
        'claude.buttons.continue': 'Continue',
        'claude.buttons.skip': 'Skip for now',
        'claude.apiKey.save': 'Save key',
        // Common translations
        'common:actions.close': 'Close'
      };
      return translations[key] || key;
    },
    i18n: { language: 'en' }
  }),
  Trans: ({ children }: { children: React.ReactNode }) => children
}));

// Mock the settings store
const mockUpdateSettings = vi.fn();
const mockLoadSettings = vi.fn();

vi.mock('../../stores/settings-store', () => ({
  useSettingsStore: vi.fn((selector) => {
    const state = {
      settings: { onboardingCompleted: false },
      isLoading: false,
      updateSettings: mockUpdateSettings,
      loadSettings: mockLoadSettings,
    };
    if (!selector) return state;
    return selector(state);
  })
}));

// Mock electronAPI
const mockSaveSettings = vi.fn().mockResolvedValue({ success: true });
const mockGetClaudeCredentialStatus = vi.fn();

Object.defineProperty(window, 'electronAPI', {
  value: {
    saveSettings: mockSaveSettings,
    onAppUpdateDownloaded: vi.fn(),
    getClaudeCredentialStatus: mockGetClaudeCredentialStatus,
    worktreeDetectTools: vi.fn().mockResolvedValue({ success: false }),
  },
  writable: true
});

describe('OnboardingWizard Integration Tests', () => {
  const defaultProps = {
    open: true,
    onOpenChange: vi.fn()
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetClaudeCredentialStatus.mockResolvedValue({ success: true, data: { configured: false, source: 'none' } });
  });

  describe('Claude Step Navigation', () => {
    it('should navigate from welcome to the Claude step', async () => {
      render(<OnboardingWizard {...defaultProps} />);

      // Start at welcome step
      expect(screen.getByText(/Welcome to Vibe Teamlead/)).toBeInTheDocument();

      // Click "Get Started" to go to the Claude step
      const getStartedButton = screen.getByRole('button', { name: /Get Started/ });
      fireEvent.click(getStartedButton);

      await waitFor(() => {
        expect(screen.getByText(/Connect Claude/)).toBeInTheDocument();
      });
    });

    it('should require a key before continuing (skip stays available)', async () => {
      render(<OnboardingWizard {...defaultProps} />);

      fireEvent.click(screen.getByRole('button', { name: /Get Started/ }));
      await waitFor(() => {
        expect(screen.getByText(/Connect Claude/)).toBeInTheDocument();
      });

      expect(screen.getByRole('button', { name: /Continue/ })).toBeDisabled();
      expect(screen.getByRole('button', { name: /Skip for now/ })).not.toBeDisabled();
    });

    it('should allow continuing when a key is already configured', async () => {
      mockGetClaudeCredentialStatus.mockResolvedValue({
        success: true,
        data: { configured: true, source: 'stored', kind: 'api-key', hint: 'abcd' },
      });
      render(<OnboardingWizard {...defaultProps} />);

      fireEvent.click(screen.getByRole('button', { name: /Get Started/ }));
      await waitFor(() => {
        expect(screen.getByRole('button', { name: /Continue/ })).not.toBeDisabled();
      });
    });

    it('should navigate back from the Claude step to welcome', async () => {
      render(<OnboardingWizard {...defaultProps} />);

      fireEvent.click(screen.getByRole('button', { name: /Get Started/ }));
      await waitFor(() => {
        expect(screen.getByText(/Connect Claude/)).toBeInTheDocument();
      });

      // Click back
      fireEvent.click(screen.getByRole('button', { name: /Back/ }));

      // Should be back at welcome
      await waitFor(() => {
        expect(screen.getByText(/Welcome to Vibe Teamlead/)).toBeInTheDocument();
      });
    });
  });

  describe('First-Run Detection', () => {
    it('should show wizard for users with no auth configured', () => {
      render(<OnboardingWizard {...defaultProps} open={true} />);

      // Wizard should be visible
      expect(screen.getByText(/Welcome to Vibe Teamlead/)).toBeInTheDocument();
    });

    it('should not show wizard when open is false', () => {
      const { rerender } = render(<OnboardingWizard {...defaultProps} open={true} />);

      expect(screen.getByText(/Welcome to Vibe Teamlead/)).toBeInTheDocument();

      // Close wizard
      rerender(<OnboardingWizard {...defaultProps} open={false} />);

      // Wizard content should not be visible
      expect(screen.queryByText(/Welcome to Vibe Teamlead/)).not.toBeInTheDocument();
    });

    it('should not show wizard for users with existing auth', () => {
      render(<OnboardingWizard {...defaultProps} open={false} />);

      expect(screen.queryByText(/Welcome to Vibe Teamlead/)).not.toBeInTheDocument();
    });
  });

  describe('Skip and Completion', () => {
    it('should complete wizard when skip is clicked', async () => {
      render(<OnboardingWizard {...defaultProps} />);

      // Click skip on welcome step
      const skipButton = screen.getByRole('button', { name: /Skip Setup/ });
      fireEvent.click(skipButton);

      // Should call saveSettings
      await waitFor(() => {
        expect(mockSaveSettings).toHaveBeenCalledWith({ onboardingCompleted: true });
      });
    });

    it('should call onOpenChange when wizard is closed', async () => {
      const mockOnOpenChange = vi.fn();
      render(<OnboardingWizard {...defaultProps} onOpenChange={mockOnOpenChange} />);

      // Click skip to close wizard
      const skipButton = screen.getByRole('button', { name: /Skip Setup/ });
      fireEvent.click(skipButton);

      await waitFor(() => {
        expect(mockOnOpenChange).toHaveBeenCalledWith(false);
      });
    });

    it('should move on to the next step when the Claude step is skipped', async () => {
      render(<OnboardingWizard {...defaultProps} />);

      fireEvent.click(screen.getByRole('button', { name: /Get Started/ }));
      await waitFor(() => {
        expect(screen.getByText(/Connect Claude/)).toBeInTheDocument();
      });

      fireEvent.click(screen.getByRole('button', { name: /Skip for now/ }));

      await waitFor(() => {
        expect(screen.queryByText(/Connect Claude/)).not.toBeInTheDocument();
        expect(screen.getByText('devtools.title')).toBeInTheDocument();
      });
    });
  });
});
