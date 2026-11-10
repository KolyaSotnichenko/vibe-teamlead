/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string, o?: Record<string, unknown>) => (o && 'count' in o ? `${key}:${o.count}` : key), i18n: { language: 'en' } }),
}));

import type { Task, TaskDesign } from '../../../../../shared/types';
import { DesignTab } from '../DesignTab';

afterEach(cleanup);

const design = (over: Partial<TaskDesign> = {}): TaskDesign => ({
  frames: [{ file: 'wireframes/roadmap.html', title: 'Roadmap · desktop', kind: 'wireframe', width: 1280, height: 900, x: 0, y: 0 }],
  stage: 'wireframes',
  round: 1,
  approved: {},
  waiting: 'wireframes',
  compare: null,
  settings: { mode: 'full', approval: 'owner' },
  frameSrc: { 'wireframes/roadmap.html': 'data:text/html,<p>x</p>' },
  ...over,
});

function setup(data: TaskDesign) {
  const api = {
    taskDesign: vi.fn(async () => ({ success: true, data })),
    approveTaskDesign: vi.fn(async () => ({ success: true })),
    commentTaskDesign: vi.fn(async () => ({ success: true })),
  };
  (window as unknown as { electronAPI: unknown }).electronAPI = { design: api };
  render(<DesignTab task={{ id: 't1', status: 'human_review', reviewReason: 'design_review', subtasks: [] } as unknown as Task} />);
  return api;
}

describe('DesignTab', () => {
  it('approves the wireframes the task waits at', async () => {
    const api = setup(design());
    fireEvent.click(await screen.findByRole('button', { name: 'design.approveWireframes' }));
    await waitFor(() => expect(api.approveTaskDesign).toHaveBeenCalledWith('t1', 'wireframes'));
  });

  it('a click on a frame in comment mode becomes a comment, sent for the next round', async () => {
    const api = setup(design());
    fireEvent.click(await screen.findByRole('button', { name: 'design.comment' }));
    const frame = screen.getByTitle('Roadmap · desktop') as HTMLIFrameElement;
    act(() => {
      window.dispatchEvent(new MessageEvent('message', { data: { type: 'vt-design:pick', selector: 'main > section', x: 120, y: 80 }, source: frame.contentWindow }));
    });
    fireEvent.change(await screen.findByLabelText('design.commentOn'), { target: { value: 'Votes on every card' } });
    // Approving waits until the comments are sent or removed
    expect(screen.getByRole('button', { name: 'design.approveWireframes' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'design.send:1' }));
    await waitFor(() =>
      expect(api.commentTaskDesign).toHaveBeenCalledWith('t1', [{ frame: 'wireframes/roadmap.html', width: 1280, selector: 'main > section', x: 120, y: 80, text: 'Votes on every card' }]),
    );
  });

  it('a pick from anything but a frame is ignored', async () => {
    setup(design());
    fireEvent.click(await screen.findByRole('button', { name: 'design.comment' }));
    act(() => {
      window.dispatchEvent(new MessageEvent('message', { data: { type: 'vt-design:pick', selector: 'x', x: 1, y: 1 }, source: window }));
    });
    expect(screen.queryByLabelText('design.commentOn')).not.toBeInTheDocument();
  });

  it('says why there is nothing to show', async () => {
    setup(design({ frames: [], stage: 'skipped', waiting: null }));
    expect(await screen.findByText('design.empty.noUiTitle')).toBeInTheDocument();
  });
});
