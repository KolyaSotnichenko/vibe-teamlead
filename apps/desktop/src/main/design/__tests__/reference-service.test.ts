import { mkdtempSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

const createFromPath = vi.fn((_p: string): unknown => ({ isEmpty: () => true }));
vi.mock('electron', () => ({
  nativeImage: { createFromPath: (p: string) => createFromPath(p), createThumbnailFromPath: async () => ({ isEmpty: () => true }) },
  BrowserWindow: vi.fn(),
  session: { fromPartition: vi.fn() },
}));
vi.mock('../../ai/claude-code/task', () => ({ runClaudeTask: vi.fn(async () => { throw new Error('no model in tests'); }) }));
vi.mock('../../ipc-handlers/feature-settings-helper', () => ({ getFeatureSettings: () => ({ model: 'opus', thinkingLevel: 'low' }) }));
vi.mock('../../ai/prompts/prompt-loader', () => ({ tryLoadPrompt: () => 'design agent' }));

import { runClaudeTask } from '../../ai/claude-code/task';
import { addReferenceFiles, addReferenceUrls, listReferences, makePreview, mergePalette, normalizeUrl, onReferencesChanged, removeReference, resumePending, setReferenceRole } from '../reference-service';

describe('reference service', () => {
  it('adds a token file as "as is" and digests it in code, without a model', async () => {
    const project = mkdtempSync(path.join(tmpdir(), 'vtl-refsvc-'));
    const src = path.join(mkdtempSync(path.join(tmpdir(), 'vtl-src-')), 'globals.css');
    writeFileSync(src, ':root { --ink: #1C1D19; --signal: #D6401A; --font-body: Archivo; }');
    const done = new Promise<void>((resolve) => onReferencesChanged(() => {
      if (listReferences(project).references[0]?.status === 'ready') resolve();
    }));

    const { list, skipped } = await addReferenceFiles(project, [src, path.join(path.dirname(src), 'notes.docx')]);
    expect(skipped).toEqual(['notes.docx']);
    expect(list.references[0]).toMatchObject({ kind: 'tokens', role: 'as-is', name: 'globals.css' });
    expect(existsSync(path.join(project, list.references[0].file as string))).toBe(true);

    await done;
    const ref = listReferences(project).references[0];
    expect(ref.notes?.palette.map((c) => c.value)).toEqual(['#1C1D19', '#D6401A']);
    expect(ref.notes?.fonts).toEqual(['Archivo']);

    expect(setReferenceRole(project, ref.id, 'inspiration').references[0].role).toBe('inspiration');
    const after = removeReference(project, ref.id);
    expect(after.references).toEqual([]);
    expect(existsSync(path.join(project, ref.file as string))).toBe(false);
  });

  it('adds sites by URL once, and refuses what is not http(s)', () => {
    const project = mkdtempSync(path.join(tmpdir(), 'vtl-refsvc-'));
    onReferencesChanged(() => {});
    const { list, skipped } = addReferenceUrls(project, ['linear.app', 'https://linear.app/', 'file:///etc/passwd', 'javascript:alert(1)']);
    expect(list.references.map((r) => r.source)).toEqual(['https://linear.app/']);
    expect(skipped).toEqual(['file:///etc/passwd', 'javascript:alert(1)']);
    expect(normalizeUrl('stripe.com/docs')).toBe('https://stripe.com/docs');
  });

  it('names measured colours with the roles the agent gave them, never inventing new ones', () => {
    expect(mergePalette([{ value: '#101114', share: 0.7 }, { value: '#5E6AD2', share: 0.02 }], [{ value: '#5e6ad2', role: 'accent' }, { value: '#FFFFFF', role: 'made up' }])).toEqual([
      { value: '#101114', share: 0.7 },
      { value: '#5E6AD2', share: 0.02, role: 'accent' },
    ]);
    expect(mergePalette([], [{ value: '#D6401A', role: 'signal' }])).toEqual([{ value: '#D6401A', role: 'signal' }]);
  });

  it('digests a reference once, though the list is read (and resumes pending ones) on every change', async () => {
    const project = mkdtempSync(path.join(tmpdir(), 'vtl-refsvc-'));
    const src = path.join(mkdtempSync(path.join(tmpdir(), 'vtl-src-')), 'brand.pdf');
    writeFileSync(src, '%PDF-1.4');
    const look = { summary: 'Brand book', paletteRoles: [], fonts: [], traits: [], takeaways: [] };
    vi.mocked(runClaudeTask).mockClear();
    vi.mocked(runClaudeTask).mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 20));
      return { text: '', output: look, session: {} as never };
    });
    // The tab reads the list on each change, and reading it resumes what is pending or digesting
    const ready = new Promise<void>((resolve) => onReferencesChanged((p) => {
      if (p !== project) return;
      resumePending(project);
      if (listReferences(project).references[0]?.status === 'ready') resolve();
    }));
    await addReferenceFiles(project, [src]);
    await ready;
    await new Promise((r) => setTimeout(r, 200));
    expect(runClaudeTask).toHaveBeenCalledTimes(1);
    expect(listReferences(project).references[0].status).toBe('ready');
  });

  it('previews a WebP the image decoder cannot read by converting it to PNG first', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'vtl-webp-'));
    const target = path.join(dir, 'ref.preview.png');
    const png = { isEmpty: () => false, getSize: () => ({ width: 400, height: 300 }), toPNG: () => Buffer.from('png') };
    createFromPath.mockImplementation((p: string) => (p === target ? png : { isEmpty: () => true }));
    const convert = vi.fn(async () => true);
    expect(await makePreview(path.join(dir, 'design2.webp'), target, 'image', convert)).toBe(true);
    expect(convert).toHaveBeenCalledWith(path.join(dir, 'design2.webp'), target);
    expect(existsSync(target)).toBe(true);
    createFromPath.mockImplementation(() => ({ isEmpty: () => true }));
    expect(await makePreview(path.join(dir, 'bad.webp'), target, 'image', async () => false)).toBe(false);
  });
});
