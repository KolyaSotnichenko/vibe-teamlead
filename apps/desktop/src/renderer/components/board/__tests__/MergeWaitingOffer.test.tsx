/**
 * @vitest-environment jsdom
 */
/**
 * The offer to merge the tasks that already wait, raised when auto-merge is turned on in
 * Settings → Project → Queue. It lives at the app's level, so it shows whatever screen is open
 * and stays after Settings closes.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';

const { mergeNow } = vi.hoisted(() => ({ mergeNow: vi.fn(async () => undefined) }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }) }));
vi.mock('../../../hooks/useAutoMerge', () => ({ getAutoMerge: () => ({ mergeNow, mergeable: vi.fn() }) }));
vi.mock('../../../stores/task-store', () => ({ useTaskStore: { getState: () => ({ tasks: [] }) } }));

import { MergeWaitingOffer } from '../MergeWaitingOffer';
import { useMergeWaitingStore } from '../../../lib/queue-settings';

afterEach(() => {
  cleanup();
  useMergeWaitingStore.setState({ tasks: [] });
  mergeNow.mockClear();
});

describe('MergeWaitingOffer', () => {
  it('shows nothing until tasks are offered', () => {
    render(<MergeWaitingOffer />);
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  });

  it('merges the offered tasks on yes and closes', () => {
    render(<MergeWaitingOffer />);
    const tasks = [{ id: 't1', title: 'One' }];
    act(() => useMergeWaitingStore.getState().offer(tasks));
    expect(screen.getByText('One')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'queue.mergeWaiting.merge' }));
    expect(mergeNow).toHaveBeenCalledWith(tasks);
    expect(useMergeWaitingStore.getState().tasks).toEqual([]);
  });

  it('merges nothing on not now', () => {
    render(<MergeWaitingOffer />);
    act(() => useMergeWaitingStore.getState().offer([{ id: 't1', title: 'One' }]));
    fireEvent.click(screen.getByRole('button', { name: 'queue.mergeWaiting.notNow' }));
    expect(mergeNow).not.toHaveBeenCalled();
    expect(useMergeWaitingStore.getState().tasks).toEqual([]);
  });
});
