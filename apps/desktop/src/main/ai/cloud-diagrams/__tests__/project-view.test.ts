import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { cloudArchitectureFile, cloudArchitectureView, type ViewInput } from '../project-view';
import { detectCloudTools } from '../terravision';

function project() {
  const root = mkdtempSync(join(tmpdir(), 'vtl-view-'));
  const specs = join(root, '.vibe-teamlead', 'specs');
  const spec = (id: string) => join(specs, id);
  const tasks = [
    { id: 't1', title: 'Design the cloud', specId: '001-cloud', status: 'human_review' },
    { id: 't2', title: 'Add storage', specId: '002-storage', status: 'done' },
    { id: 't3', title: 'Old work', specId: '003-old', status: 'done' },
  ];
  const input: ViewInput = {
    projectPath: root,
    tasks,
    specDirs: (task) => [spec(task.specId)],
    enabled: true,
    tools: detectCloudTools((name) => `/bin/${name}`),
    platform: 'darwin',
  };
  return { root, spec, input };
}

const at = (file: string, seconds: number) => utimesSync(file, seconds, seconds);

describe('cloudArchitectureView', () => {
  it('shows the tools, and nothing else for a project without diagrams', async () => {
    const { input } = project();
    const view = await cloudArchitectureView(input);
    expect(view).toEqual({ enabled: true, tools: { ready: true, drawFromCode: true, missing: [], hints: expect.objectContaining({ uv: 'brew install uv' }) }, decisions: [] });
  });

  it("shows the latest drawing from code, with its SVG, and the latest architect's design", async () => {
    const { root, spec, input } = project();
    const store = join(root, '.vibe-teamlead', 'cloud-architecture');
    mkdirSync(join(store, 'latest'), { recursive: true });
    writeFileSync(join(store, 'latest', 'architecture-azure.svg'), '<svg/>');
    writeFileSync(join(store, 'meta.json'), JSON.stringify({ drawn: { commit: 'abc', drawnAt: '2026-11-18T10:00:00Z', source: 'infra', files: { svg: 'architecture-azure.svg' } }, lastAttempt: { at: 'x', commit: 'abc', status: 'drawn' } }));
    for (const [id, seconds] of [['001-cloud', 2000], ['002-storage', 1000]] as const) {
      const dir = join(spec(id), 'architecture', 'diagrams');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'cloud-architecture-azure.svg'), `<svg id="${id}"/>`);
      writeFileSync(join(dir, 'cloud-architecture-azure.drawio'), '<mxfile/>');
      at(join(dir, 'cloud-architecture-azure.svg'), seconds);
    }
    const view = await cloudArchitectureView(input);
    expect(view.fromCode?.drawn?.commit).toBe('abc');
    expect(view.fromCode?.svg).toBe(`data:image/svg+xml;base64,${Buffer.from('<svg/>').toString('base64')}`);
    expect(view.designed).toMatchObject({ taskId: 't1', taskTitle: 'Design the cloud', hasDrawio: true });
    expect(Buffer.from(view.designed!.svg!.split(',')[1], 'base64').toString()).toContain('001-cloud');
  });

  it('lists the decisions (ADRs) of merged tasks, newest first', async () => {
    const { spec, input } = project();
    const write = (id: string, name: string, text: string, seconds: number) => {
      const dir = join(spec(id), 'architecture', 'adr');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, name), text);
      at(join(dir, name), seconds);
    };
    write('001-cloud', '0001-not-merged.md', '# Not merged yet', 3000);
    write('002-storage', '0001-blob.md', '---\nstatus: accepted\n---\n# Use Blob Storage', 2000);
    write('003-old', '0001-postgres.md', '# Use Postgres', 1000);
    write('003-old', 'README.md', '# Index', 1000);
    const view = await cloudArchitectureView(input);
    expect(view.decisions.map((d) => [d.taskId, d.title, d.status])).toEqual([
      ['t2', 'Use Blob Storage', 'accepted'],
      ['t3', 'Use Postgres', undefined],
    ]);
  });
});

describe('cloudArchitectureFile', () => {
  it('resolves only the known files: the drawing from code, its folder, and the design', async () => {
    const { root, spec, input } = project();
    const store = join(root, '.vibe-teamlead', 'cloud-architecture');
    mkdirSync(join(store, 'latest'), { recursive: true });
    writeFileSync(join(store, 'latest', 'a.drawio'), '');
    writeFileSync(join(store, 'meta.json'), JSON.stringify({ drawn: { commit: 'c', drawnAt: 'x', source: '.', files: { drawio: 'a.drawio', html: '../../escape.html' } } }));
    const dir = join(spec('001-cloud'), 'architecture', 'diagrams');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'cloud-architecture-aws.drawio'), '');
    writeFileSync(join(dir, 'cloud-architecture-aws.svg'), '');
    expect(await cloudArchitectureFile(input, 'drawio')).toBe(join(store, 'latest', 'a.drawio'));
    expect(await cloudArchitectureFile(input, 'folder')).toBe(join(store, 'latest'));
    expect(await cloudArchitectureFile(input, 'html')).toBeUndefined();
    expect(await cloudArchitectureFile(input, 'svg')).toBeUndefined();
    expect(await cloudArchitectureFile(input, 'designed-drawio')).toBe(join(dir, 'cloud-architecture-aws.drawio'));
  });
});
