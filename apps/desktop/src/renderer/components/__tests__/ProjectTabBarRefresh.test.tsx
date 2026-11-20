/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('../SortableProjectTab', () => ({ SortableProjectTab: ({ project }: { project: { name: string } }) => <span>{project.name}</span> }));
vi.mock('../ProjectUsage', () => ({ ProjectUsage: () => <span>usage</span> }));

import { ProjectTabBar } from '../ProjectTabBar';
import type { Project } from '../../../shared/types';

const projects = [{ id: 'p1', name: 'P', path: '/p' } as Project];
const bar = (props: Partial<Parameters<typeof ProjectTabBar>[0]> = {}) =>
  render(<ProjectTabBar projects={projects} activeProjectId="p1" onProjectSelect={vi.fn()} onProjectClose={vi.fn()} onAddProject={vi.fn()} {...props} />);

afterEach(cleanup);

describe('ProjectTabBar: refreshing the board', () => {
  it('is an icon next to the usage counter that reloads the tasks', () => {
    const onRefresh = vi.fn();
    bar({ onRefresh });
    const button = screen.getByRole('button', { name: 'tasks:refreshTasks' });
    fireEvent.click(button);
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it('says it is refreshing and takes no second click meanwhile', () => {
    const onRefresh = vi.fn();
    bar({ onRefresh, isRefreshing: true });
    const button = screen.getByRole('button', { name: 'common:buttons.refreshing' });
    expect(button).toBeDisabled();
    fireEvent.click(button);
    expect(onRefresh).not.toHaveBeenCalled();
  });

  it('is not there on pages other than the board', () => {
    bar();
    expect(screen.queryByRole('button', { name: 'tasks:refreshTasks' })).not.toBeInTheDocument();
  });
});
