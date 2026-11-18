/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import type { CloudArchitectureView } from '../../../../shared/types';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string, opts?: Record<string, unknown>) => (opts ? `${key} ${JSON.stringify(opts)}` : key), i18n: { language: 'en' } }),
}));
const createTask = vi.hoisted(() => vi.fn());
vi.mock('../../../stores/task-store', () => ({ createTask }));
const toast = vi.hoisted(() => vi.fn());
vi.mock('../../../hooks/use-toast', () => ({ useToast: () => ({ toast }) }));
const settings = vi.hoisted(() => ({ value: { architectMode: 'complex' } as Record<string, unknown> }));
vi.mock('../../../stores/settings-store', () => ({ useSettingsStore: (pick: (s: { settings: Record<string, unknown> }) => unknown) => pick({ settings: settings.value }) }));
const openTask = vi.hoisted(() => vi.fn());
vi.mock('../../../lib/open-task', () => ({ openTask }));

import { CloudArchitectureTab } from '../CloudArchitectureTab';

const hints = { uv: 'brew install uv', graphviz: 'brew install graphviz', git: 'brew install git', terraform: 'brew install opentofu' };
const get = vi.fn();
const open = vi.fn(async () => ({ success: true }));

const view = (over: Partial<CloudArchitectureView> = {}): CloudArchitectureView => ({
  enabled: true,
  tools: { ready: true, drawFromCode: true, missing: [], hints },
  decisions: [],
  ...over,
});

beforeEach(() => {
  get.mockReset();
  open.mockClear();
  createTask.mockReset();
  openTask.mockReset();
  settings.value = { architectMode: 'complex' };
  (window as unknown as { electronAPI: unknown }).electronAPI = { cloudArchitecture: { get, open, onUpdated: () => () => undefined } };
});

describe('CloudArchitectureTab', () => {
  it('shows the designed diagram and the one drawn from code side by side, with which merge it came from', async () => {
    get.mockResolvedValue({
      success: true,
      data: view({
        designed: { taskId: 't1', taskTitle: 'Design the cloud', svg: 'data:image/svg+xml;base64,AA', hasDrawio: true, at: 1 },
        fromCode: {
          drawn: { commit: 'abcdef1234', taskId: 't2', taskTitle: 'Add storage', drawnAt: '2026-11-18T10:00:00Z', source: 'infra', files: { svg: 'a.svg', drawio: 'a.drawio', html: 'a.html' } },
          svg: 'data:image/svg+xml;base64,BB',
        },
      }),
    });
    render(<CloudArchitectureTab projectId="p1" />);
    expect(await screen.findByAltText('cloud:tab.designed.title')).toHaveAttribute('src', 'data:image/svg+xml;base64,AA');
    expect(screen.getByAltText('cloud:tab.fromCode.title')).toHaveAttribute('src', 'data:image/svg+xml;base64,BB');
    expect(screen.getByText(/cloud:tab.fromCode.drawnFrom .*"commit":"abcdef1"/)).toBeInTheDocument();
    expect(screen.getByText(/cloud:tab.fromCode.afterTask .*Add storage/)).toBeInTheDocument();
    fireEvent.click(screen.getByText('cloud:tab.fromCode.openHtml'));
    expect(open).toHaveBeenCalledWith('p1', 'html');
    fireEvent.click(screen.getByText('cloud:tab.designed.openDrawio'));
    expect(open).toHaveBeenCalledWith('p1', 'designed-drawio');
  });

  it('says quietly why the last merge was not drawn, and keeps the last drawing', async () => {
    get.mockResolvedValue({ success: true, data: view({ fromCode: { lastAttempt: { at: 'x', commit: 'c0ffee12345', status: 'refused', detail: 'main.tf: a provisioner runs commands' } } }) });
    render(<CloudArchitectureTab projectId="p1" />);
    expect(await screen.findByText(/cloud:tab.fromCode.status.refused .*provisioner/)).toBeInTheDocument();
    expect(screen.getByText('cloud:tab.fromCode.none')).toBeInTheDocument();
  });

  it('names the missing tools when TerraVision is not ready', async () => {
    get.mockResolvedValue({ success: true, data: view({ tools: { ready: false, drawFromCode: false, missing: ['uv', 'graphviz'], hints } }) });
    render(<CloudArchitectureTab projectId="p1" />);
    expect(await screen.findByText('cloud:tab.missingTools')).toBeInTheDocument();
    expect(screen.getByText('brew install uv')).toBeInTheDocument();
    // without the tools the architect has nothing to draw with: the task would draw nothing
    expect(screen.getByText('cloud:tab.design.button')).toBeDisabled();
    expect(screen.getByText('cloud:tab.design.missingTools')).toBeInTheDocument();
  });

  it('lists the decisions of merged tasks, each opening its task', async () => {
    get.mockResolvedValue({ success: true, data: view({ decisions: [{ taskId: 't2', taskTitle: 'Add storage', fileName: '0001-blob.md', title: 'Use Blob Storage', status: 'accepted', at: 2 }] }) });
    render(<CloudArchitectureTab projectId="p1" />);
    fireEvent.click(await screen.findByText('Use Blob Storage'));
    expect(openTask).toHaveBeenCalledWith('t2');
  });

  it('creates the design task in Planning, marked architecture-only so it ends after its architect', async () => {
    get.mockResolvedValue({ success: true, data: view() });
    createTask.mockResolvedValue({ id: 't9' });
    render(<CloudArchitectureTab projectId="p1" />);
    fireEvent.click(await screen.findByText('cloud:tab.design.button'));
    await waitFor(() => expect(createTask).toHaveBeenCalled());
    const [projectId, title, description, metadata] = createTask.mock.calls[0];
    expect(projectId).toBe('p1');
    expect(title).toBe('cloud:tab.design.title');
    expect(description).toContain('cloud:tab.design.description');
    expect(description).toContain('<!-- vibe-teamlead:cloud-architecture-design -->');
    // Architecture only: the task ends after the architect, with no planner, code, QA or merge
    expect(metadata).toEqual({ sourceType: 'manual', cloudArchitectureDesign: true, architectureOnly: true, requireReviewBeforeCoding: true });
  });

  it("can't create the design task while the architect is turned off", async () => {
    settings.value = { architectMode: 'never' };
    get.mockResolvedValue({ success: true, data: view() });
    render(<CloudArchitectureTab projectId="p1" />);
    expect(await screen.findByText('cloud:tab.design.button')).toBeDisabled();
    expect(screen.getByText('cloud:tab.design.architectOff')).toBeInTheDocument();
  });

  it('says when the feature is off, opens Settings at Agents, and keeps the decisions', async () => {
    get.mockResolvedValue({ success: true, data: view({ enabled: false, decisions: [{ taskId: 't1', taskTitle: 'Auth', fileName: '0001.md', title: 'Use Entra ID', at: 1 }] }) });
    const opened = vi.fn();
    window.addEventListener('open-app-settings', opened);
    render(<CloudArchitectureTab projectId="p1" />);
    expect(await screen.findByText('cloud:tab.off')).toBeInTheDocument();
    fireEvent.click(screen.getByText('cloud:tab.openSettings'));
    expect((opened.mock.calls[0][0] as CustomEvent).detail).toBe('agent');
    window.removeEventListener('open-app-settings', opened);
    expect(screen.getByText('Use Entra ID')).toBeInTheDocument();
  });

  it("can't create the design task while cloud diagrams are off, and says why", async () => {
    get.mockResolvedValue({ success: true, data: view({ enabled: false }) });
    render(<CloudArchitectureTab projectId="p1" />);
    expect(await screen.findByText('cloud:tab.design.button')).toBeDisabled();
    expect(screen.getByText('cloud:tab.design.off')).toBeInTheDocument();
  });
});
