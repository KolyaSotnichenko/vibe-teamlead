/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import { AddProjectModal } from '../AddProjectModal';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
}));

const addProject = vi.fn();
const selectDirectory = vi.fn();
const createProjectFolder = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  Object.defineProperty(window, 'electronAPI', {
    value: { addProject, selectDirectory, createProjectFolder, getDefaultProjectLocation: vi.fn().mockResolvedValue('') },
    writable: true,
    configurable: true,
  });
});

describe('AddProjectModal and WSL', () => {
  it('refuses a folder inside WSL with its own message, without adding it', async () => {
    selectDirectory.mockResolvedValue('\\\\wsl.localhost\\Ubuntu\\home\\me\\app');
    render(<AddProjectModal open onOpenChange={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'addProject.openExistingAriaLabel' }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('addProject.wslUnsupported'));
    expect(addProject).not.toHaveBeenCalled();
  });

  it('refuses a new project whose location is inside WSL, creating nothing', async () => {
    selectDirectory.mockResolvedValue('\\\\wsl$\\Ubuntu\\home\\me');
    render(<AddProjectModal open onOpenChange={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'addProject.createNewAriaLabel' }));
    fireEvent.change(screen.getByPlaceholderText('addProject.projectNamePlaceholder'), { target: { value: 'app' } });
    fireEvent.click(screen.getByRole('button', { name: /addProject.browse/ }));
    await waitFor(() => expect(selectDirectory).toHaveBeenCalled());
    fireEvent.click(screen.getByRole('button', { name: /addProject.createProject/ }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('addProject.wslUnsupported'));
    expect(createProjectFolder).not.toHaveBeenCalled();
  });
});
