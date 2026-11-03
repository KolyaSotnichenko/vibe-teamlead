/**
 * @vitest-environment jsdom
 */
import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { diagramImagePath, joinSpecPath, WorkspaceMarkdown } from '../workspace-ui';

describe('spec-dir paths', () => {
  it('joins and normalises paths relative to the markdown file', () => {
    expect(joinSpecPath('architecture', 'diagrams/context.png')).toBe('architecture/diagrams/context.png');
    expect(joinSpecPath('architecture', './diagrams/a%20b.png?x=1')).toBe('architecture/diagrams/a b.png');
    expect(joinSpecPath('architecture/adr', '../diagrams/c.png')).toBe('architecture/diagrams/c.png');
  });

  it('shows the PNG for a diagram file and nothing for other files', () => {
    expect(diagramImagePath('architecture/diagrams/context.png')).toBe('architecture/diagrams/context.png');
    expect(diagramImagePath('architecture/diagrams/containers.drawio')).toBe('architecture/diagrams/containers.png');
    expect(diagramImagePath('architecture/diagrams/login.mmd')).toBe('architecture/diagrams/login.png');
    expect(diagramImagePath('architecture/adr/0001.md')).toBeNull();
  });
});

describe('WorkspaceMarkdown with assets', () => {
  it('loads a relative diagram image and a linked diagram from the spec folder', async () => {
    const getTaskWorkspaceImage = vi.fn(async (_task: string, path: string) => ({ success: true, data: `data:image/png;base64,${btoa(path)}` }));
    (window as unknown as { electronAPI: unknown }).electronAPI = { getTaskWorkspaceImage };
    render(
      <WorkspaceMarkdown
        markdown={'![Context](diagrams/context.png)\n\nSee [Containers](diagrams/containers.drawio) and [docs](https://example.com).'}
        assets={{ taskId: 't1', projectId: 'p1', baseDir: 'architecture' }}
      />
    );
    await waitFor(() => expect(screen.getByAltText('Context')).toBeTruthy());
    expect((screen.getByAltText('Context') as HTMLImageElement).src).toBe(`data:image/png;base64,${btoa('architecture/diagrams/context.png')}`);
    expect(screen.getByAltText('Containers')).toBeTruthy();
    expect(getTaskWorkspaceImage).toHaveBeenCalledWith('t1', 'architecture/diagrams/containers.png', 'p1');
    expect(screen.getByRole('link', { name: 'docs' }).getAttribute('href')).toBe('https://example.com');
  });
});
