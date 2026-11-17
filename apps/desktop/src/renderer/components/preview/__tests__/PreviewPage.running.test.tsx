/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

import type { PreviewRunningDoc, PreviewStatus, Project } from '../../../../shared/types';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }) }));
vi.mock('../../../stores/task-store', () => ({ createTask: vi.fn(), startTaskOrQueue: vi.fn(), submitReview: vi.fn() }));
vi.mock('../../../stores/project-store', () => ({ updateProjectSettings: vi.fn() }));
const session = vi.hoisted(() => ({ status: null as PreviewStatus | null }));
vi.mock('../usePreviewSession', () => ({ usePreviewSession: () => ({ status: session.status, boxRef: { current: null } }) }));

import { PreviewPage } from '../PreviewPage';

const PROJECT = { id: 'p1', path: '/p1', settings: { previewServices: [{ name: 'web', command: 'npm run dev', page: true }] } } as unknown as Project;
const HAS: PreviewRunningDoc = { exists: true, markdown: '## Start\n\nrun it', truncated: false, dir: '/p1' };
const NONE: PreviewRunningDoc = { exists: false, dir: '/p1' };

function withDoc(doc: PreviewRunningDoc) {
  (window as unknown as { electronAPI: unknown }).electronAPI = { preview: { runningDoc: vi.fn(async () => ({ success: true, data: doc })), navigate: vi.fn(), resetData: vi.fn() } };
}

beforeEach(() => {
  session.status = null;
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('PreviewPage and RUNNING.md', () => {
  it('when the preview did not start, shows RUNNING.md under the error', async () => {
    withDoc(HAS);
    session.status = { projectId: 'p1', stage: 'failed', origins: [], message: 'web exited with code 1' };
    render(<PreviewPage project={PROJECT} />);
    expect(screen.getByRole('alert')).toHaveTextContent('web exited with code 1');
    expect(await screen.findByRole('heading', { name: 'Start' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'preview.running.openTerminal' })).toBeInTheDocument();
  });

  it('when it did not start and there is no RUNNING.md, offers the task that writes it', async () => {
    withDoc(NONE);
    session.status = { projectId: 'p1', stage: 'failed', origins: [], message: 'no' };
    render(<PreviewPage project={PROJECT} />);
    expect(await screen.findByRole('button', { name: 'preview.running.createTask' })).toBeInTheDocument();
  });

  it('under the address notice, shows RUNNING.md too', async () => {
    withDoc(HAS);
    session.status = { projectId: 'p1', stage: 'ready', url: 'http://localhost:4100', origins: [], addressIssues: [{ service: 'api', unreachable: { path: '/api', result: '502' } }] };
    render(<PreviewPage project={PROJECT} />);
    expect(await screen.findByRole('heading', { name: 'Start' })).toBeInTheDocument();
  });

  it('while the app runs fine, keeps RUNNING.md behind the "How to run" button', async () => {
    withDoc(HAS);
    session.status = { projectId: 'p1', stage: 'ready', url: 'http://localhost:4100', origins: [] };
    render(<PreviewPage project={PROJECT} />);
    const button = await screen.findByRole('button', { name: 'preview.toolbar.running' });
    expect(screen.queryByRole('heading', { name: 'Start' })).not.toBeInTheDocument();
    fireEvent.click(button);
    expect(screen.getByRole('heading', { name: 'Start' })).toBeInTheDocument();
  });

  it('has no "How to run" button without RUNNING.md, and no create button while the app runs fine', async () => {
    withDoc(NONE);
    session.status = { projectId: 'p1', stage: 'ready', url: 'http://localhost:4100', origins: [] };
    render(<PreviewPage project={PROJECT} />);
    await Promise.resolve();
    expect(screen.queryByRole('button', { name: 'preview.toolbar.running' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'preview.running.createTask' })).not.toBeInTheDocument();
  });
});
