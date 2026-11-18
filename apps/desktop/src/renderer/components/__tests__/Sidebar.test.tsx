/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('../UpdateBanner', () => ({ UpdateBanner: () => null }));
vi.mock('../GitSetupModal', () => ({ GitSetupModal: () => null }));
vi.mock('../brief-import', () => ({ BriefImportDialog: () => null }));
vi.mock('../sidebar/TeamStatus', () => ({ TeamStatus: () => null }));

import { useProjectStore } from '../../stores/project-store';
import { Sidebar } from '../Sidebar';

beforeEach(() => {
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    checkGitStatus: vi.fn().mockResolvedValue({ success: false }),
  };
  useProjectStore.setState({
    projects: [{ id: 'p1', name: 'P', path: '/p', settings: {} } as never],
    selectedProjectId: 'p1',
  });
});
afterEach(cleanup);

function renderSidebar() {
  const onViewChange = vi.fn();
  render(<Sidebar onSettingsClick={vi.fn()} onNewTaskClick={vi.fn()} activeView="kanban" onViewChange={onViewChange} />);
  return onViewChange;
}

describe('Sidebar', () => {
  it('keeps the Build and Plan groups and no longer lists the Knowledge pages', () => {
    renderSidebar();
    expect(screen.getByText('sections.build')).toBeInTheDocument();
    expect(screen.getByText('sections.plan')).toBeInTheDocument();
    expect(screen.queryByText('sections.knowledge')).not.toBeInTheDocument();
    for (const label of ['items.context', 'items.changelog', 'items.agentTools', 'items.docs']) {
      expect(screen.queryByText(`navigation:${label}`)).not.toBeInTheDocument();
    }
    expect(screen.getByText('navigation:items.kanban')).toBeInTheDocument();
  });

  it('still opens the Knowledge pages by their shortcuts', () => {
    const onViewChange = renderSidebar();
    const cases: Array<[string, string]> = [
      ['c', 'context'],
      ['l', 'changelog'],
      ['m', 'agent-tools'],
      ['h', 'docs'],
      ['k', 'kanban'],
    ];
    for (const [key, view] of cases) {
      fireEvent.keyDown(window, { key });
      expect(onViewChange).toHaveBeenLastCalledWith(view);
    }
  });
});
