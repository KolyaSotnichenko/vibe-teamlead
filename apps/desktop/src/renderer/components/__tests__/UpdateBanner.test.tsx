/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { act, cleanup, render } from '@testing-library/react';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

import { UpdateBanner } from '../UpdateBanner';

const MINUTE = 60_000;
let checkAppUpdate: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.useFakeTimers();
  checkAppUpdate = vi.fn(async () => ({ success: true, data: null }));
  const none = () => () => undefined;
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    checkAppUpdate,
    getDownloadedAppUpdate: vi.fn(async () => ({ success: true, data: null })),
    onAppUpdateAvailable: none,
    onAppUpdateProgress: none,
    onAppUpdateDownloaded: none,
    onAppUpdateError: none,
    onAppUpdateReadOnlyVolume: none,
  };
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

// F-014: the banner asked GitHub every 5 minutes, although main checks by itself and tells the window
describe('UpdateBanner', () => {
  it('asks for an update when it appears, then once an hour, not every few minutes', async () => {
    render(<UpdateBanner />);
    await act(async () => { await Promise.resolve(); });
    expect(checkAppUpdate).toHaveBeenCalledTimes(1);
    await act(async () => { vi.advanceTimersByTime(30 * MINUTE); });
    expect(checkAppUpdate).toHaveBeenCalledTimes(1);
    await act(async () => { vi.advanceTimersByTime(31 * MINUTE); });
    expect(checkAppUpdate).toHaveBeenCalledTimes(2);
  });

  it('stops asking when it goes away', async () => {
    const { unmount } = render(<UpdateBanner />);
    unmount();
    await act(async () => { vi.advanceTimersByTime(180 * MINUTE); });
    expect(checkAppUpdate).toHaveBeenCalledTimes(1);
  });
});
