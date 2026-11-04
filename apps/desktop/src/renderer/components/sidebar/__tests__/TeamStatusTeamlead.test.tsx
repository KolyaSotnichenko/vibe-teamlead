/**
 * @vitest-environment jsdom
 */
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string, o?: Record<string, unknown>) => (o && 'count' in o ? `${key}:${o.count}` : key) }),
}));
const speak = vi.fn();
vi.mock('../teamlead/droid-voice', async (orig) => ({ ...(await orig<object>()), speak: (p: string) => speak(p) }));

import { useSettingsStore } from '../../../stores/settings-store';
import { useTaskStore } from '../../../stores/task-store';
import { TeamStatus } from '../TeamStatus';

const task = (id: string, status: string, reviewReason?: string) => ({ id, projectId: 'p1', status, reviewReason, subtasks: [] });
const setTasks = (tasks: unknown[]) => act(() => useTaskStore.setState({ tasks: tasks as never }));
const mood = () => document.querySelector('[data-mood]')?.getAttribute('data-mood');

beforeEach(() => {
  speak.mockClear();
  useSettingsStore.setState((s) => ({ settings: { ...s.settings, teamleadVoice: true } }));
  useTaskStore.setState({ tasks: [] as never });
});
afterEach(cleanup);

describe('TeamStatus teamlead', () => {
  it('shows the mood for the project, silently at first, then speaks when it changes', () => {
    setTasks([task('a', 'in_progress')]);
    render(<TeamStatus projectId="p1" collapsed={false} />);
    expect(mood()).toBe('working');
    expect(screen.getByText('teamStatus.mood.working:1')).toBeInTheDocument();
    expect(speak).not.toHaveBeenCalled();

    setTasks([task('a', 'human_review', 'completed')]);
    expect(mood()).toBe('review');
    expect(speak).toHaveBeenCalledWith('pleased');

    setTasks([task('a', 'human_review', 'errors')]);
    expect(mood()).toBe('error');
    expect(speak).toHaveBeenLastCalledWith('sad');
  });

  it('celebrates a merge, then goes back', () => {
    vi.useFakeTimers();
    try {
      setTasks([task('a', 'human_review', 'completed')]);
      render(<TeamStatus projectId="p1" collapsed={false} />);
      setTasks([task('a', 'done')]);
      expect(mood()).toBe('done');
      expect(speak).toHaveBeenLastCalledWith('laugh');
      act(() => void vi.advanceTimersByTime(2500));
      expect(mood()).toBe('idle');
    } finally {
      vi.useRealTimers();
    }
  });

  it('waves back when clicked, and stays quiet with the voice off', () => {
    useSettingsStore.setState((s) => ({ settings: { ...s.settings, teamleadVoice: false } }));
    render(<TeamStatus projectId="p1" collapsed={false} />);
    expect(mood()).toBe('idle');
    fireEvent.click(screen.getByRole('button', { name: /teamStatus.teamleadLabel/ }));
    expect(mood()).toBe('hello');
    expect(speak).not.toHaveBeenCalled();
  });

  it('ignores other projects', () => {
    setTasks([{ ...task('a', 'in_progress'), projectId: 'p2' }]);
    render(<TeamStatus projectId="p1" collapsed={false} />);
    expect(mood()).toBe('idle');
  });
});
