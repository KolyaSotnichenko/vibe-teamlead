/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

import type { PreviewFix } from '../../../../shared/types';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, o?: Record<string, unknown>) => {
      const values = Object.entries(o ?? {}).filter(([name]) => name !== 'defaultValue').map(([, value]) => String(value));
      return values.length ? `${key}:${values.join(',')}` : key;
    },
    i18n: { language: 'en' },
  }),
}));
const tasks = vi.hoisted(() => ({ createTask: vi.fn(async () => ({ id: 't9' })), startTaskOrQueue: vi.fn(async () => true) }));
vi.mock('../../../stores/task-store', () => tasks);

import { StartFixPanel } from '../StartFixPanel';

const api = { fix: vi.fn(async () => ({ success: true })), cancelFix: vi.fn(async () => ({ success: true })), start: vi.fn(async () => ({ success: true })) };
const actions = { onEnvironment: vi.fn() };
const show = (fix: PreviewFix) => render(<StartFixPanel projectId="p1" fix={fix} onEnvironment={actions.onEnvironment} />);

beforeEach(() => {
  (window as unknown as { electronAPI: unknown }).electronAPI = { preview: api };
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('StartFixPanel', () => {
  it('says the agent is working, on which try, and lets the owner stop it', () => {
    show({ state: 'running', tries: 2 });
    expect(screen.getByText('preview.fix.running')).toBeInTheDocument();
    expect(screen.getByText('preview.fix.tries:2,5')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'preview.fix.stop' }));
    expect(api.cancelFix).toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'preview.fix.tryAgain' })).not.toBeInTheDocument();
  });

  it('says nothing about tries before the first one', () => {
    show({ state: 'running', tries: 0 });
    expect(screen.queryByText(/preview\.fix\.tries/)).not.toBeInTheDocument();
  });

  it('offers the agent when nothing ran for this failure, and a plain new start', () => {
    show({ state: 'idle' });
    fireEvent.click(screen.getByRole('button', { name: 'preview.fix.ask' }));
    expect(api.fix).toHaveBeenCalledWith('p1');
    fireEvent.click(screen.getByRole('button', { name: 'preview.fix.tryAgain' }));
    expect(api.start).toHaveBeenCalledWith('p1');
    expect(screen.queryByRole('button', { name: 'preview.fix.askAgain' })).not.toBeInTheDocument();
  });

  it('lists what only the owner can supply, with the way to the variables when one is named', () => {
    show({ state: 'done', outcome: 'needs_owner', summary: 'Бракує двох речей.', missing: [{ what: 'Docker', why: 'потрібен для бази' }, { what: 'STRIPE_SECRET_KEY', why: 'платежі', variable: 'STRIPE_SECRET_KEY' }] });
    expect(screen.getByText('preview.fix.missingTitle')).toBeInTheDocument();
    expect(screen.getByText('Бракує двох речей.')).toBeInTheDocument();
    expect(screen.getByText('Docker')).toBeInTheDocument();
    expect(screen.getByText('потрібен для бази')).toBeInTheDocument();
    expect(screen.getByText('STRIPE_SECRET_KEY')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'preview.fix.environment' }));
    expect(actions.onEnvironment).toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'preview.fix.tryAgain' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'preview.fix.askAgain' })).toBeInTheDocument();
  });

  it('has no way to the variables when nothing missing is a variable', () => {
    show({ state: 'done', outcome: 'needs_owner', summary: 's', missing: [{ what: 'Docker', why: 'x' }] });
    expect(screen.queryByRole('button', { name: 'preview.fix.environment' })).not.toBeInTheDocument();
  });

  it("shows the agent's task in full before it is made, makes it in Planning, and never starts it", async () => {
    show({ state: 'done', outcome: 'needs_code_change', summary: 'Адреса зашита в коді.', task: { title: 'Read the API address from API_URL', description: 'The proxy…\n\n- AC-1: …' } });
    expect(screen.getByText('Адреса зашита в коді.')).toBeInTheDocument();
    // An agent wrote it from what it read in the project: the owner reads it before anything works from it
    expect(screen.getByText('Read the API address from API_URL')).toBeInTheDocument();
    expect(screen.getByText(/The proxy…/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'preview.fix.createTask' }));
    await waitFor(() => expect(tasks.createTask).toHaveBeenCalledWith('p1', 'Read the API address from API_URL', 'The proxy…\n\n- AC-1: …'));
    expect(await screen.findByText('preview.fix.taskCreated')).toBeInTheDocument();
    expect(tasks.startTaskOrQueue).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'preview.fix.createTask' })).not.toBeInTheDocument();
  });

  it('says so when the task could not be made, and keeps the button', async () => {
    tasks.createTask.mockResolvedValueOnce(null as never);
    show({ state: 'done', outcome: 'needs_code_change', summary: 's', task: { title: 't', description: 'd' } });
    fireEvent.click(screen.getByRole('button', { name: 'preview.fix.createTask' }));
    expect(await screen.findByText('preview.fix.taskFailed')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'preview.fix.createTask' })).toBeInTheDocument();
  });

  it("says the agent could not work it out, with what it found, in the agent's words or the app's", () => {
    const { unmount } = show({ state: 'done', outcome: 'unknown', summary: 'Не знайшов причини.' });
    expect(screen.getByText('preview.fix.unknown')).toBeInTheDocument();
    expect(screen.getByText('Не знайшов причини.')).toBeInTheDocument();
    unmount();
    show({ state: 'done', outcome: 'unknown', summary: "The agent's session failed: x", summarySaid: { key: 'fixFailed', params: { reason: 'x' }, text: "The agent's session failed: x" } });
    expect(screen.getByText('preview.say.fixFailed:x')).toBeInTheDocument();
  });

  it('asks the agent again when the owner wants another look', () => {
    show({ state: 'done', outcome: 'unknown', summary: 's' });
    fireEvent.click(screen.getByRole('button', { name: 'preview.fix.askAgain' }));
    expect(api.fix).toHaveBeenCalledWith('p1');
  });

  it('shows nothing on a failed start for a fix that came up: the page says that', () => {
    const { container } = show({ state: 'done', outcome: 'fixed', summary: 's' });
    expect(container).toBeEmptyDOMElement();
  });
});
