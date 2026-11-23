/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

import type { PreviewService, PreviewStatus, Project } from '../../../../shared/types';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }) }));
vi.mock('../../../stores/task-store', () => ({ createTask: vi.fn(), startTaskOrQueue: vi.fn(), submitReview: vi.fn() }));
const store = vi.hoisted(() => ({ updateProjectSettings: vi.fn(async () => true) }));
vi.mock('../../../stores/project-store', () => store);
const session = vi.hoisted(() => ({ status: null as PreviewStatus | null, hook: vi.fn() }));
vi.mock('../usePreviewSession', () => ({
  usePreviewSession: (...args: unknown[]) => {
    session.hook(...args);
    return { status: session.status, boxRef: { current: null } };
  },
}));

import { PreviewPage } from '../PreviewPage';

const SAVED: PreviewService[] = [{ name: 'web', dir: '', command: 'npm run dev', page: true }];
const projectWith = (services: PreviewService[]) => ({ id: 'p1', path: '/p1', settings: { previewServices: services } }) as unknown as Project;
const api = {
  runningDoc: vi.fn(async () => ({ success: true, data: { exists: false, dir: '/p1' } })),
  navigate: vi.fn(),
  resetData: vi.fn(),
  recipe: vi.fn(),
  proposeServices: vi.fn(),
  restartServices: vi.fn(async () => ({ success: true })),
};

beforeEach(() => {
  session.status = null;
  api.recipe.mockResolvedValue({ success: true, data: { source: 'none', servicesFrom: 'none', services: [] } });
  api.proposeServices.mockResolvedValue({ success: true, data: [] });
  (window as unknown as { electronAPI: unknown }).electronAPI = { preview: api };
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('PreviewPage and the recipe', () => {
  it('starts the preview on open for a project with no saved services, without the form', () => {
    render(<PreviewPage project={projectWith([])} />);
    expect(session.hook).toHaveBeenLastCalledWith('p1', true, undefined);
    expect(session.hook.mock.calls.every(([, enabled]) => enabled === true)).toBe(true);
    expect(screen.queryByText('preview.services.intro')).not.toBeInTheDocument();
    expect(api.proposeServices).not.toHaveBeenCalled();
  });

  it('shows the form with the proposal when the preview says it needs services, and starts again once they are saved', async () => {
    api.proposeServices.mockResolvedValue({ success: true, data: [{ name: 'a', dir: 'apps/a', command: 'pnpm dev', page: true }, { name: 'b', dir: 'apps/b', command: 'pnpm dev' }] });
    session.status = { projectId: 'p1', stage: 'failed', origins: [], needsServices: true, message: 'Choose exactly one service whose page the preview shows.' };
    render(<PreviewPage project={projectWith([])} />);
    expect(await screen.findByDisplayValue('a')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'preview.services.cancel' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'preview.services.save' }));
    await waitFor(() => expect(store.updateProjectSettings).toHaveBeenCalledWith('p1', { previewServices: expect.arrayContaining([expect.objectContaining({ name: 'a', page: true })]) }));
    // Saved: the preview starts by the new services, and the form is gone
    await waitFor(() => expect(api.restartServices).toHaveBeenCalledWith('p1'));
    await waitFor(() => expect(screen.queryByDisplayValue('a')).not.toBeInTheDocument());
  });

  it('fills the form from the saved services when they have no single page', async () => {
    const saved = [{ name: 'api', dir: 'services/api', command: 'pnpm dev' }];
    api.recipe.mockResolvedValue({ success: true, data: { source: 'settings', servicesFrom: 'settings', services: saved } });
    session.status = { projectId: 'p1', stage: 'failed', origins: [], needsServices: true, message: 'Choose exactly one service whose page the preview shows.' };
    render(<PreviewPage project={projectWith(saved)} />);
    expect(await screen.findByDisplayValue('api')).toBeInTheDocument();
    expect(api.proposeServices).not.toHaveBeenCalled();
  });

  it('says why preview.json was not used on the form too, when the owner is asked for the services', async () => {
    session.status = { projectId: 'p1', stage: 'failed', origins: [], needsServices: true, message: 'Choose exactly one service whose page the preview shows.', recipe: { source: 'none', kind: 'web', invalid: 'version must be 1.' } };
    render(<PreviewPage project={projectWith([])} />);
    expect(await screen.findByText('preview.recipeInvalid')).toBeInTheDocument();
  });

  it('keeps the preview running while the owner only looks at the services', async () => {
    api.recipe.mockResolvedValue({ success: true, data: { source: 'settings', servicesFrom: 'settings', services: SAVED } });
    session.status = { projectId: 'p1', stage: 'ready', origins: [], url: 'http://localhost:1', recipe: { source: 'settings', kind: 'web' } };
    render(<PreviewPage project={projectWith(SAVED)} />);
    fireEvent.click(screen.getByRole('button', { name: 'preview.toolbar.services' }));
    expect(await screen.findByDisplayValue('web')).toBeInTheDocument();
    expect(session.hook).toHaveBeenLastCalledWith('p1', true, undefined);
    fireEvent.click(screen.getByRole('button', { name: 'preview.services.cancel' }));
    expect(await screen.findByRole('button', { name: 'preview.toolbar.services' })).toBeInTheDocument();
    expect(api.restartServices).not.toHaveBeenCalled();
  });

  it("says the main process's sentences by their keys, and leaves a tool's own output as it is", async () => {
    session.status = {
      projectId: 'p1', stage: 'failed', origins: [], message: 'api did not start', logTail: 'Error: boom',
      servicesNotices: ['search (x) did not get ready in time.', 'something a tool printed'],
      database: 'unavailable', databaseReason: 'postgres:16 did not get ready in time.',
      said: [
        { key: 'serviceNotStarted', params: { service: 'api' }, text: 'api did not start' },
        { key: 'composeNotReady', params: { name: 'search', image: 'x' }, text: 'search (x) did not get ready in time.' },
        { key: 'imageNotReady', params: { image: 'postgres:16' }, text: 'postgres:16 did not get ready in time.' },
      ],
    };
    render(<PreviewPage project={projectWith(SAVED)} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('preview.say.serviceNotStarted');
    expect(screen.getByText('preview.say.composeNotReady')).toBeInTheDocument();
    expect(screen.getByText('preview.say.imageNotReady')).toBeInTheDocument();
    expect(screen.getByText('something a tool printed')).toBeInTheDocument();
  });

  it('says when preview.json was not used', async () => {
    session.status = { projectId: 'p1', stage: 'ready', origins: [], url: 'http://localhost:1', recipe: { source: 'settings', kind: 'web', invalid: 'version must be 1.' } };
    render(<PreviewPage project={projectWith(SAVED)} />);
    expect(await screen.findByText('preview.recipeInvalid')).toBeInTheDocument();
  });

  it('lets the owner change saved services when the preview.json names none of its own', async () => {
    api.recipe.mockResolvedValue({ success: true, data: { source: 'file', servicesFrom: 'settings', services: SAVED } });
    session.status = { projectId: 'p1', stage: 'ready', origins: [], url: 'http://localhost:1', recipe: { source: 'file', kind: 'web' } };
    render(<PreviewPage project={projectWith(SAVED)} />);
    fireEvent.click(screen.getByRole('button', { name: 'preview.toolbar.services' }));
    expect(await screen.findByDisplayValue('web')).toBeEnabled();
    expect(screen.getByRole('button', { name: 'preview.services.save' })).toBeInTheDocument();
  });

  it('says in the app\'s language what a project of another kind is', async () => {
    session.status = { projectId: 'p1', stage: 'failed', origins: [], message: 'This project is a desktop app. The preview shows web apps for now; see how to run it below.', recipe: { source: 'file', kind: 'desktop' } };
    render(<PreviewPage project={projectWith(SAVED)} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('preview.kind.desktop');
  });

  it("Services shows a file recipe's services read-only, with a way back", async () => {
    api.recipe.mockResolvedValue({ success: true, data: { source: 'file', servicesFrom: 'file', services: [{ name: 'site', dir: '', command: 'make serve', page: true }] } });
    session.status = { projectId: 'p1', stage: 'ready', origins: [], url: 'http://localhost:1', recipe: { source: 'file', kind: 'web' } };
    render(<PreviewPage project={projectWith([])} />);
    fireEvent.click(screen.getByRole('button', { name: 'preview.toolbar.services' }));
    expect(await screen.findByDisplayValue('site')).toBeDisabled();
    expect(screen.getByText('preview.services.fromFile')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'preview.services.save' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'preview.services.cancel' }));
    expect(await screen.findByRole('button', { name: 'preview.toolbar.services' })).toBeInTheDocument();
  });
});
