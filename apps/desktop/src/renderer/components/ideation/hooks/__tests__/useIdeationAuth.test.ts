/**
 * Unit tests for useIdeationAuth hook
 * Ideation can run when the app's Claude credential is configured.
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';

import { useIdeationAuth } from '../useIdeationAuth';

const mockGetStatus = vi.fn();

describe('useIdeationAuth', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (window as unknown as { electronAPI: unknown }).electronAPI = {
      getClaudeCredentialStatus: mockGetStatus,
    };
  });

  it('starts loading and reports no token until the status arrives', () => {
    mockGetStatus.mockReturnValue(new Promise(() => undefined));
    const { result } = renderHook(() => useIdeationAuth());
    expect(result.current.isLoading).toBe(true);
    expect(result.current.hasToken).toBe(false);
  });

  it('reports a token when a Claude credential is configured', async () => {
    mockGetStatus.mockResolvedValue({
      success: true,
      data: { configured: true, source: 'stored', kind: 'api-key', hint: 'abcd' },
    });
    const { result } = renderHook(() => useIdeationAuth());
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.hasToken).toBe(true);
  });

  it('reports no token when nothing is configured', async () => {
    mockGetStatus.mockResolvedValue({ success: true, data: { configured: false, source: 'none' } });
    const { result } = renderHook(() => useIdeationAuth());
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.hasToken).toBe(false);
  });

  it('treats a failed status request as not configured', async () => {
    mockGetStatus.mockRejectedValue(new Error('ipc down'));
    const { result } = renderHook(() => useIdeationAuth());
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.hasToken).toBe(false);
  });
});
