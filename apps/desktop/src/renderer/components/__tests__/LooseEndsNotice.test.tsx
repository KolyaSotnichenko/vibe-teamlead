/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string, o?: Record<string, unknown>) => (o ? `${key} ${JSON.stringify(o)}` : key) }),
}));
const createTask = vi.fn(async () => ({ id: 't9' }));
vi.mock('../../stores/task-store', () => ({ createTask: (...a: unknown[]) => createTask(...(a as [])) }));
const updateProjectSettings = vi.fn(async () => true);
vi.mock('../../stores/project-store', () => ({
  updateProjectSettings: (...a: unknown[]) => updateProjectSettings(...(a as [])),
  useProjectStore: (select: (s: unknown) => unknown) => select({ projects: [{ id: 'p1', settings: { ignoredLooseEnds: ['old\nx'] } }] }),
}));

import { LooseEndsNotice } from '../LooseEndsNotice';

const HOME = { file: 'apps/web/src/app/page.tsx', line: 10, text: 'Placeholder home page — the app skeleton ships before any domain feature.' };

function setup(found = [HOME]) {
  const getLooseEnds = vi.fn(async () => ({ success: true, data: found }));
  (window as unknown as { electronAPI: unknown }).electronAPI = { getLooseEnds };
  render(<LooseEndsNotice projectId="p1" refreshKey={1} />);
  return { getLooseEnds };
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('LooseEndsNotice', () => {
  it('says nothing when the product has no placeholders', async () => {
    const { getLooseEnds } = setup([]);
    await waitFor(() => expect(getLooseEnds).toHaveBeenCalledWith('p1'));
    expect(screen.queryByText(/looseEnds.title/)).not.toBeInTheDocument();
  });

  it('names each placeholder with its file and line once opened', async () => {
    setup();
    fireEvent.click(await screen.findByRole('button', { name: /looseEnds.title/ }));
    expect(screen.getByText('apps/web/src/app/page.tsx:10')).toBeInTheDocument();
    expect(screen.getByText(HOME.text)).toBeInTheDocument();
  });

  it('creates a task to replace it, naming the file, line and text', async () => {
    setup();
    fireEvent.click(await screen.findByRole('button', { name: /looseEnds.title/ }));
    fireEvent.click(screen.getByRole('button', { name: 'looseEnds.createTask' }));
    await waitFor(() => expect(createTask).toHaveBeenCalled());
    const [projectId, title, description] = createTask.mock.calls[0] as unknown as [string, string, string];
    expect(projectId).toBe('p1');
    expect(title).toContain('apps/web/src/app/page.tsx');
    expect(description).toContain('apps/web/src/app/page.tsx:10');
    expect(description).toContain(HOME.text);
    expect(await screen.findByText('looseEnds.taskCreated')).toBeInTheDocument();
  });

  it('leaves it when the owner says so, kept in the project settings with the earlier ones', async () => {
    setup();
    fireEvent.click(await screen.findByRole('button', { name: /looseEnds.title/ }));
    fireEvent.click(screen.getByRole('button', { name: 'looseEnds.leave' }));
    await waitFor(() => expect(updateProjectSettings).toHaveBeenCalledWith('p1', { ignoredLooseEnds: ['old\nx', `${HOME.file}\n${HOME.text}`] }));
    await waitFor(() => expect(screen.queryByText(/looseEnds.title/)).not.toBeInTheDocument());
  });
});
