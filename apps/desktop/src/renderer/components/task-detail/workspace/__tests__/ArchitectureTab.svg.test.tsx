/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import { ArchitectureTab } from '../ArchitectureTab';
import type { TaskWorkspace, WorkspaceDiagram } from '../../../../../shared/types';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
}));
vi.mock('../../../../hooks/use-toast', () => ({ useToast: () => ({ toast: vi.fn() }) }));

const getImage = vi.fn();

beforeEach(() => {
  getImage.mockReset();
  getImage.mockImplementation(async (_task: string, rel: string) => ({ success: true, data: `data:test,${rel}` }));
  (window as unknown as { electronAPI: unknown }).electronAPI = { getTaskWorkspaceImage: getImage, openTaskWorkspaceFile: vi.fn() };
});

const workspace = (diagrams: WorkspaceDiagram[]): TaskWorkspace => ({
  specDir: '/tmp/spec',
  hasQaCoverage: false,
  timeline: [],
  architecture: { adrs: [], diagrams },
  security: {},
});

describe('ArchitectureTab SVG diagrams', () => {
  it("shows a TerraVision diagram's SVG rather than its PNG, with the draw.io button", async () => {
    render(
      <ArchitectureTab
        taskId="t1"
        projectId="p1"
        workspace={workspace([{ name: 'cloud-architecture-azure', kind: 'drawio', drawioPath: 'architecture/diagrams/cloud-architecture-azure.drawio', pngPath: 'architecture/diagrams/cloud-architecture-azure.png', svgPath: 'architecture/diagrams/cloud-architecture-azure.svg' }])}
      />,
    );
    await waitFor(() => expect(screen.getByAltText('cloud-architecture-azure')).toHaveAttribute('src', 'data:test,architecture/diagrams/cloud-architecture-azure.svg'));
    expect(screen.getByText('tasks:workspace.architecture.openInDrawio')).toBeInTheDocument();
  });

  it('shows an SVG on its own', async () => {
    render(<ArchitectureTab taskId="t2" projectId="p1" workspace={workspace([{ name: 'cloud', kind: 'svg', svgPath: 'architecture/diagrams/cloud.svg' }])} />);
    await waitFor(() => expect(screen.getByAltText('cloud')).toHaveAttribute('src', 'data:test,architecture/diagrams/cloud.svg'));
    expect(screen.getByText('.svg')).toBeInTheDocument();
  });
});
