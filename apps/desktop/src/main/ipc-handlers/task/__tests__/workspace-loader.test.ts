import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { isInside, loadTaskWorkspace, resolveSpecFile } from '../workspace-handlers';

describe('loadTaskWorkspace', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'vt-workspace-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns an empty workspace when nothing has been written yet', async () => {
    const ws = await loadTaskWorkspace(dir);
    expect(ws).toEqual({ specDir: dir, hasQaCoverage: false, timeline: [], architecture: { adrs: [], diagrams: [] }, security: {} });
  });

  it('omits invalid files instead of failing', async () => {
    writeFileSync(path.join(dir, 'implementation_plan.json'), '{ not json');
    writeFileSync(path.join(dir, 'task_logs.json'), '[]');
    const ws = await loadTaskWorkspace(dir);
    expect(ws.plan).toBeUndefined();
    expect(ws.timeline).toEqual([]);
  });

  it('reads spec, plan, QA and architecture artifacts', async () => {
    writeFileSync(path.join(dir, 'spec.md'), '- **AC-1** Given a, when b, then c. — Test: unit\n');
    writeFileSync(
      path.join(dir, 'implementation_plan.json'),
      JSON.stringify({ phases: [{ id: 'p1', name: 'P1', subtasks: [{ id: 's1', title: 'S1', description: '[AC-1] do it', status: 'completed' }] }] })
    );
    writeFileSync(path.join(dir, 'qa_report.md'), '| AC | Test (file::name) | Asserts the criterion? | Result |\n|--|--|--|--|\n| AC-1 | `t::x` | yes | PASS |\n');
    const arch = path.join(dir, 'architecture');
    mkdirSync(path.join(arch, 'adr'), { recursive: true });
    mkdirSync(path.join(arch, 'diagrams'), { recursive: true });
    writeFileSync(path.join(arch, 'architecture.md'), '# Architecture');
    writeFileSync(path.join(arch, 'adr', '0001-x.md'), '# Pick X\n\nStatus: accepted');
    writeFileSync(path.join(arch, 'adr', 'README.md'), '# index');
    writeFileSync(path.join(arch, 'diagrams', 'context.drawio'), '<mxfile/>');
    writeFileSync(path.join(arch, 'diagrams', 'context.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    writeFileSync(path.join(arch, 'diagrams', 'deploy.drawio'), '<mxfile/>');
    writeFileSync(path.join(arch, 'diagrams', 'flow.mmd'), 'sequenceDiagram\n  A->>B: hi');
    writeFileSync(path.join(arch, 'diagrams', 'empty.mmd'), '   ');

    const ws = await loadTaskWorkspace(dir);
    expect(ws.hasQaCoverage).toBe(true);
    expect(ws.spec?.criteria[0]).toMatchObject({ id: 'AC-1', status: 'pass', coveredBy: ['s1'], testLevel: 'unit' });
    expect(ws.architecture.markdown).toBe('# Architecture');
    expect(ws.architecture.adrs).toEqual([expect.objectContaining({ title: 'Pick X', status: 'accepted' })]);
    expect(ws.architecture.diagrams).toEqual([
      { name: 'context', kind: 'drawio', drawioPath: 'architecture/diagrams/context.drawio', pngPath: 'architecture/diagrams/context.png', pngVersion: expect.any(Number) },
      { name: 'deploy', kind: 'drawio', drawioPath: 'architecture/diagrams/deploy.drawio' },
      { name: 'flow', kind: 'mermaid', mermaidSource: 'sequenceDiagram\n  A->>B: hi' },
    ]);
  });
});

describe('isInside', () => {
  it('rejects paths that escape the root', () => {
    expect(isInside('/a/spec', '/a/spec/architecture/x.drawio')).toBe(true);
    expect(isInside('/a/spec', '/a/spec/../other')).toBe(false);
    expect(isInside('/a/spec', '/a/spec-evil/x')).toBe(false);
  });
});

describe('resolveSpecFile', () => {
  it('only resolves real files inside the spec directory, following symlinks', async () => {
    const spec = mkdtempSync(path.join(tmpdir(), 'vt-spec-'));
    const outside = mkdtempSync(path.join(tmpdir(), 'vt-out-'));
    mkdirSync(path.join(spec, 'architecture'));
    writeFileSync(path.join(spec, 'architecture', 'c.drawio'), '<mxfile/>');
    writeFileSync(path.join(outside, 'evil.command'), 'echo hi');
    symlinkSync(path.join(outside, 'evil.command'), path.join(spec, 'architecture', 'x.drawio'));

    expect(await resolveSpecFile(spec, 'architecture/c.drawio')).toMatch(/c\.drawio$/);
    expect(await resolveSpecFile(spec, 'architecture/x.drawio')).toBeNull();
    expect(await resolveSpecFile(spec, '../x')).toBeNull();
    expect(await resolveSpecFile(spec, '/etc/passwd')).toBeNull();
    expect(await resolveSpecFile(spec, 42)).toBeNull();
    rmSync(spec, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });
});
