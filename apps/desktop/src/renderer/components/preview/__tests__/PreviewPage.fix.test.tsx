/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

import type { PreviewStatus, Project } from '../../../../shared/types';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string, o?: { summary?: string }) => (o?.summary ? `${key}:${o.summary}` : key), i18n: { language: 'en' } }) }));
vi.mock('../../../stores/task-store', () => ({ createTask: vi.fn(), startTaskOrQueue: vi.fn(), submitReview: vi.fn() }));
vi.mock('../../../stores/project-store', () => ({ updateProjectSettings: vi.fn() }));
const session = vi.hoisted(() => ({ status: null as PreviewStatus | null }));
vi.mock('../usePreviewSession', () => ({ usePreviewSession: () => ({ status: session.status, boxRef: { current: null } }) }));

import { PreviewPage } from '../PreviewPage';

const PROJECT = { id: 'p1', path: '/p1', settings: { previewServices: [{ name: 'web', dir: '', command: 'npm run dev', page: true }] } } as unknown as Project;
const api = {
  runningDoc: vi.fn(async () => ({ success: true, data: { exists: false, dir: '/p1' } })),
  navigate: vi.fn(), resetData: vi.fn(), recipe: vi.fn(async () => ({ success: true, data: { source: 'settings', servicesFrom: 'settings', services: [] } })),
  proposeServices: vi.fn(async () => ({ success: true, data: [] })), fix: vi.fn(), cancelFix: vi.fn(), start: vi.fn(),
  env: vi.fn(async () => ({ success: false, error: 'not in this test' })),
};

beforeEach(() => {
  (window as unknown as { electronAPI: unknown }).electronAPI = { preview: api };
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('PreviewPage and the agent that fixes a start', () => {
  it('says the agent is working while it tries, over the stage the start is at', () => {
    session.status = { projectId: 'p1', stage: 'install', origins: [], fix: { state: 'running', tries: 1 } };
    render(<PreviewPage project={PROJECT} />);
    expect(screen.getByText('preview.fix.running')).toBeInTheDocument();
    expect(screen.getByText('preview.stage.install')).toBeInTheDocument();
  });

  it('shows what the agent found under the failure', () => {
    session.status = { projectId: 'p1', stage: 'failed', origins: [], message: 'web did not start', fix: { state: 'done', outcome: 'unknown', summary: 'Не знайшов причини.' } };
    render(<PreviewPage project={PROJECT} />);
    expect(screen.getByRole('alert')).toHaveTextContent('web did not start');
    expect(screen.getByText('Не знайшов причини.')).toBeInTheDocument();
  });

  it('says what the agent changed over the page it made start, until the owner puts it away', () => {
    session.status = { projectId: 'p1', stage: 'ready', origins: [], url: 'http://localhost:1', fix: { state: 'done', outcome: 'fixed', summary: 'Команду виправлено.' } };
    render(<PreviewPage project={PROJECT} />);
    expect(screen.getByText('preview.fix.fixed:Команду виправлено.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'preview.fix.dismiss' }));
    expect(screen.queryByText('preview.fix.fixed:Команду виправлено.')).not.toBeInTheDocument();
  });

  it('shows no panel for a failed start the agent has nothing to do with', () => {
    session.status = { projectId: 'p1', stage: 'failed', origins: [], message: 'web did not start' };
    render(<PreviewPage project={PROJECT} />);
    expect(screen.queryByRole('button', { name: 'preview.fix.ask' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'preview.fix.tryAgain' })).not.toBeInTheDocument();
  });

  it("opens the variables from what the agent says is missing", () => {
    session.status = { projectId: 'p1', stage: 'failed', origins: [], message: 'x', fix: { state: 'done', outcome: 'needs_owner', summary: 's', missing: [{ what: 'K', why: 'w', variable: 'K' }] } };
    render(<PreviewPage project={PROJECT} />);
    fireEvent.click(screen.getByRole('button', { name: 'preview.fix.environment' }));
    expect(screen.getByRole('complementary', { name: 'preview.toolbar.env' })).toBeInTheDocument();
  });
});
