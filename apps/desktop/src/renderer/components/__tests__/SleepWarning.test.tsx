/**
 * @vitest-environment jsdom
 */
import { act, render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { SleepWarning } from '../SleepWarning';

const { toast, dismiss } = vi.hoisted(() => ({ toast: vi.fn(), dismiss: vi.fn() }));

vi.mock('../../hooks/use-toast', () => ({ toast }));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { count?: number }) => (options?.count === undefined ? key : `${key}:${options.count}`),
  }),
}));

let emit: (event: { tasks: number }) => void;

beforeEach(() => {
  vi.clearAllMocks();
  toast.mockReturnValue({ dismiss });
  Object.assign(window, {
    electronAPI: {
      onSleptWhileRunning: (callback: typeof emit) => {
        emit = callback;
        return () => undefined;
      },
    },
  });
});

describe('SleepWarning', () => {
  it('stays until read: nobody is looking at the moment the Mac wakes', () => {
    render(<SleepWarning />);
    act(() => emit({ tasks: 3 }));
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({
      title: 'sleepWarning.title',
      description: 'sleepWarning.description:3',
      duration: Number.POSITIVE_INFINITY,
    }));
  });

  it('shows one warning however many times the Mac woke', () => {
    render(<SleepWarning />);
    act(() => emit({ tasks: 3 }));
    act(() => emit({ tasks: 3 }));
    expect(dismiss).toHaveBeenCalledTimes(1);
    expect(toast).toHaveBeenCalledTimes(2);
  });
});
