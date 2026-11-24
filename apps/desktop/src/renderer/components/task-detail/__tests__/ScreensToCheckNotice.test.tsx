/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string, o?: Record<string, unknown>) => (o ? `${key}:${JSON.stringify(o)}` : key) }),
}));

import type { Task, TaskDesign } from '../../../../shared/types';
import { ScreensToCheckNotice } from '../ScreensToCheckNotice';

afterEach(cleanup);

const design = {
  frames: [{ file: 'screens/busy.html', title: 'Sign-in · busy', kind: 'screen', width: 1280, height: 900, x: 0, y: 0 }],
  compare: { screens: [
    { file: 'screens/busy.html', width: 1280, notShown: 'The token request answers instantly', differences: [] },
    { file: 'screens/ok.html', width: 1280, built: 'qa-browser/ok.png', differences: [] },
  ] },
} as unknown as TaskDesign;

function setup(task: Partial<Task>) {
  (window as unknown as { electronAPI: unknown }).electronAPI = { design: { taskDesign: vi.fn(async () => ({ success: true, data: design })) } };
  const onOpenDesign = vi.fn();
  render(<ScreensToCheckNotice task={{ id: 't1', ...task } as Task} onOpenDesign={onOpenDesign} />);
  return onOpenDesign;
}

describe('ScreensToCheckNotice', () => {
  it("names each screen QA couldn't show, why, and what to do, with a way to the Design tab", async () => {
    const onOpenDesign = setup({ status: 'human_review' });
    expect(await screen.findByText(/Sign-in · busy/)).toBeInTheDocument();
    expect(screen.getByText(/answers instantly/)).toBeInTheDocument();
    expect(screen.getByText('taskScreens.how')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'taskScreens.openDesign' }));
    expect(onOpenDesign).toHaveBeenCalled();
  });

  it('says nothing for a task not waiting for review', async () => {
    setup({ status: 'in_progress' });
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByText('taskScreens.how')).not.toBeInTheDocument();
  });
});
