import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const shotWindow = vi.hoisted(() => ({ hang: false }));
vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
  // A shot window whose page never finishes loading, when a test asks for it
  BrowserWindow: class {
    webContents = { setWindowOpenHandler: () => undefined, on: () => undefined, capturePage: async () => ({ isEmpty: () => true }) };
    loadURL() { return shotWindow.hang ? new Promise(() => undefined) : Promise.resolve(); }
    destroy() {}
  },
  protocol: { handle: vi.fn() },
}));
const spec = vi.hoisted(() => ({ dir: '' }));
vi.mock('../../app-logger', () => ({ appLog: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), log: vi.fn() } }));
vi.mock('../task/workspace-handlers', () => ({ resolveSpecDir: () => spec.dir }));
vi.mock('../task/shared', () => ({
  findTaskAndProject: () => ({ task: { id: 't', status: 'human_review', reviewReason: 'design_review' }, project: { id: 'p', settings: { designMode: 'full', designApproval: 'owner' } } }),
}));
const startTask = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock('../task/execution-handlers', () => ({ startTask }));
vi.mock('../../agent', () => ({ AgentManager: class {} }));
vi.mock('../../project-store', () => ({ projectStore: {} }));

import { approveTaskDesign, commentTaskDesign, taskDesign } from '../task-design-handlers';

const state = () => JSON.parse(readFileSync(join(spec.dir, 'design', 'state.json'), 'utf-8'));

beforeEach(() => {
  spec.dir = mkdtempSync(join(tmpdir(), 'vt-design-'));
  mkdirSync(join(spec.dir, 'design'), { recursive: true });
  writeFileSync(join(spec.dir, 'design', 'state.json'), JSON.stringify({ stage: 'wireframes', round: 1 }));
  writeFileSync(join(spec.dir, 'design', 'canvas.json'), JSON.stringify({ frames: [{ file: 'home.html', title: 'Home', kind: 'wireframe' }] }));
  writeFileSync(join(spec.dir, 'design', 'home.html'), '<p>home</p>');
  startTask.mockClear();
});
afterEach(() => rmSync(spec.dir, { recursive: true, force: true }));

// The Telegram bot's Approve / Comment run what the Design tab's buttons run
describe('design approval actions', () => {
  it('says which stage waits for the owner', () => {
    expect(taskDesign('t')?.waiting).toBe('wireframes');
  });

  it('approves the waiting stage and starts the task again', async () => {
    expect(await approveTaskDesign({} as never, () => null, 't', 'wireframes')).toEqual({ success: true });
    expect(state().approved.wireframes).toBeTruthy();
    expect(startTask).toHaveBeenCalledWith({}, expect.any(Function), 't');
  });

  it("starts the task at once after the design is approved: QA's screen pictures are taken in the background", async () => {
    writeFileSync(join(spec.dir, 'design', 'state.json'), JSON.stringify({ stage: 'design', round: 1, approved: { wireframes: 'x' } }));
    mkdirSync(join(spec.dir, 'design', 'screens'), { recursive: true });
    writeFileSync(join(spec.dir, 'design', 'screens', 'home.html'), '<p>home</p>');
    writeFileSync(join(spec.dir, 'design', 'canvas.json'), JSON.stringify({ frames: [{ file: 'screens/home.html', title: 'Home', kind: 'screen', width: 1280, height: 800 }] }));
    shotWindow.hang = true;
    try {
      const result = await Promise.race([approveTaskDesign({} as never, () => null, 't', 'design'), new Promise((resolve) => setTimeout(() => resolve('waited'), 1500))]);
      expect(result).toEqual({ success: true });
      expect(startTask).toHaveBeenCalled();
    } finally {
      shotWindow.hang = false;
    }
  });

  it('refuses a stage that does not wait', async () => {
    expect((await approveTaskDesign({} as never, () => null, 't', 'design')).success).toBe(false);
    expect(startTask).not.toHaveBeenCalled();
  });

  it('sends a comment on the whole set back to the designer', async () => {
    expect(await commentTaskDesign({} as never, () => null, 't', [{ frame: '', text: 'Bigger buttons' }])).toEqual({ success: true });
    expect(state().comments).toEqual([{ n: 1, frame: '', text: 'Bigger buttons' }]);
    expect(startTask).toHaveBeenCalled();
  });
});
