/**
 * @vitest-environment jsdom
 */
/**
 * GitHub PRs is mounted (hidden) when the app starts. Regression: a connection check that failed then
 * (e.g. the GitHub App token had expired and was still being refreshed) stuck as "GitHub Not
 * Connected" — opening the page never checked again, while GitHub Issues (mounted on open) worked.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';

// Stable like react-i18next's own t
const i18n = vi.hoisted(() => ({ t: (key: string) => key, i18n: { language: 'en' } }));
vi.mock('react-i18next', () => ({ useTranslation: () => i18n }));

import { useGitHubPRs } from '../useGitHubPRs';

const github = {
  checkGitHubConnection: vi.fn(),
  listPRs: vi.fn(async () => ({ prs: [], hasNextPage: false, endCursor: null })),
  getPRReviewsBatch: vi.fn(async () => ({})),
  startStatusPolling: vi.fn(async () => undefined),
  stopStatusPolling: vi.fn(async () => undefined),
};

beforeEach(() => {
  (window as unknown as { electronAPI: unknown }).electronAPI = { github };
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('useGitHubPRs connection', () => {
  it('checks the connection again when the page becomes active, and connects', async () => {
    github.checkGitHubConnection.mockResolvedValueOnce({
      success: true,
      data: { connected: false, error: 'No GitHub token or repository configured' },
    });
    const { result, rerender } = renderHook(({ active }) => useGitHubPRs('p1', { isActive: active }), {
      initialProps: { active: false },
    });
    await waitFor(() => expect(github.checkGitHubConnection).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.isConnected).toBe(false);

    github.checkGitHubConnection.mockResolvedValue({
      success: true,
      data: { connected: true, repoFullName: 'acme/app' },
    });
    rerender({ active: true });
    await waitFor(() => expect(result.current.isConnected).toBe(true));
    expect(github.checkGitHubConnection).toHaveBeenCalledTimes(2);
    expect(result.current.repoFullName).toBe('acme/app');
    expect(github.listPRs).toHaveBeenCalledWith('p1');
  });

  it('checks once on mount when it starts active', async () => {
    github.checkGitHubConnection.mockResolvedValue({ success: true, data: { connected: true, repoFullName: 'acme/app' } });
    const { result } = renderHook(() => useGitHubPRs('p1', { isActive: true }));
    await waitFor(() => expect(result.current.isConnected).toBe(true));
    expect(github.checkGitHubConnection).toHaveBeenCalledTimes(1);
  });
});
