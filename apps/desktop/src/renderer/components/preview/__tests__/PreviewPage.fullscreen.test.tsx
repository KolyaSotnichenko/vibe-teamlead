/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

import type { PreviewStatus, Project } from '../../../../shared/types';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }) }));
vi.mock('../../../stores/task-store', () => ({ createTask: vi.fn(), startTaskOrQueue: vi.fn(), submitReview: vi.fn() }));
vi.mock('../../../stores/project-store', () => ({ updateProjectSettings: vi.fn() }));
const session = vi.hoisted(() => ({ status: null as PreviewStatus | null }));
vi.mock('../usePreviewSession', () => ({ usePreviewSession: () => ({ status: session.status, boxRef: { current: null } }) }));

import { PreviewPage } from '../PreviewPage';
import { PreviewFullScreenContext } from '../preview-fullscreen';

const PROJECT = { id: 'p1', path: '/p1', settings: { previewServices: [{ name: 'web', command: 'npm run dev', page: true }] } } as unknown as Project;

beforeEach(() => {
  session.status = { projectId: 'p1', stage: 'ready', origins: [], url: 'http://localhost:5173' } as PreviewStatus;
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    preview: { runningDoc: vi.fn(async () => ({ success: true, data: { exists: false, dir: '/p1' } })), navigate: vi.fn(), resetData: vi.fn() },
  };
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const fullScreenArea = () => document.querySelector('[data-preview-fullscreen]');

describe('the preview full screen', () => {
  it('covers the whole window with its toolbar and side panels, and Esc brings it back', () => {
    render(<PreviewPage project={PROJECT} />);
    expect(fullScreenArea()).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'preview.toolbar.fullScreen' }));
    const area = fullScreenArea();
    expect(area).not.toBeNull();
    expect(area?.parentElement).toBe(document.body);
    // Notes, logs and the rest stay at hand
    expect(area).toContainElement(screen.getByRole('button', { name: 'preview.toolbar.notes' }));

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(fullScreenArea()).toBeNull();
  });

  it('in a task window, fills the window it is in (asked to take the whole screen) and Esc does not close it', () => {
    const onFullScreen = vi.fn();
    const closedByEscape = vi.fn();
    document.addEventListener('keydown', (event) => event.key === 'Escape' && closedByEscape(), { capture: true });
    render(
      <PreviewFullScreenContext.Provider value={onFullScreen}>
        <div role="dialog">
          <PreviewPage project={PROJECT} task={{ id: 't1', title: 'Task' } as never} />
        </div>
      </PreviewFullScreenContext.Provider>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'preview.toolbar.fullScreen' }));
    expect(screen.getByRole('dialog')).toContainElement(fullScreenArea() as HTMLElement);
    expect(onFullScreen).toHaveBeenLastCalledWith(true);

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(fullScreenArea()).toBeNull();
    expect(onFullScreen).toHaveBeenLastCalledWith(false);
    expect(closedByEscape).not.toHaveBeenCalled();
  });

  it('has a button to leave it', () => {
    render(<PreviewPage project={PROJECT} />);
    fireEvent.click(screen.getByRole('button', { name: 'preview.toolbar.fullScreen' }));
    fireEvent.click(screen.getByRole('button', { name: 'preview.toolbar.exitFullScreen' }));
    expect(fullScreenArea()).toBeNull();
  });
});
