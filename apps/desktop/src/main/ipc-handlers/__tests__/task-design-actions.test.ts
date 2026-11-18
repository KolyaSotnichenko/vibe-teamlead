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
const spec = vi.hoisted(() => ({ dir: '', reviewReason: 'design_review', status: 'human_review' }));
vi.mock('../../app-logger', () => ({ appLog: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), log: vi.fn() } }));
vi.mock('../task/workspace-handlers', () => ({ resolveSpecDir: () => spec.dir }));
vi.mock('../task/shared', () => ({
  findTaskAndProject: () => ({ task: { id: 't', status: spec.status, reviewReason: spec.reviewReason }, project: { id: 'p', settings: { designMode: 'full', designApproval: 'owner' } } }),
}));
const startTask = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock('../task/execution-handlers', () => ({ startTask }));
vi.mock('../../agent', () => ({ AgentManager: class {} }));
vi.mock('../../project-store', () => ({ projectStore: {} }));

import { approveTaskDesign, commentTaskDesign, retryTaskDesign, skipTaskDesign, stopDesignWait, taskDesign } from '../task-design-handlers';

const state = () => JSON.parse(readFileSync(join(spec.dir, 'design', 'state.json'), 'utf-8'));

beforeEach(() => {
  spec.dir = mkdtempSync(join(tmpdir(), 'vt-design-'));
  mkdirSync(join(spec.dir, 'design'), { recursive: true });
  writeFileSync(join(spec.dir, 'design', 'state.json'), JSON.stringify({ stage: 'wireframes', round: 1 }));
  writeFileSync(join(spec.dir, 'design', 'canvas.json'), JSON.stringify({ frames: [{ file: 'home.html', title: 'Home', kind: 'wireframe' }] }));
  writeFileSync(join(spec.dir, 'design', 'home.html'), '<p>home</p>');
  startTask.mockClear();
  spec.reviewReason = 'design_review';
  spec.status = 'human_review';
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

describe('a design the designer could not make', () => {
  const failed = () => {
    spec.reviewReason = 'design_failed';
    writeFileSync(join(spec.dir, 'design', 'failed.json'), JSON.stringify({ error: 'Rate limit reached', job: 'design', at: '2026-11-18T10:00:00Z' }));
  };

  it("shows the designer's error while the task waits for the owner", () => {
    failed();
    expect(taskDesign('t')).toMatchObject({ waiting: null, failure: { error: 'Rate limit reached' } });
    spec.reviewReason = 'design_review';
    expect(taskDesign('t')?.failure).toBeNull();
  });

  it('trying again keeps the design where it was and starts the task', async () => {
    failed();
    expect(await retryTaskDesign({} as never, () => null, 't')).toEqual({ success: true });
    expect(state()).toEqual({ stage: 'wireframes', round: 1 });
    expect(startTask).toHaveBeenCalled();
  });

  it("building without a design is recorded as the owner's decision", async () => {
    failed();
    expect(await skipTaskDesign({} as never, () => null, 't')).toEqual({ success: true });
    expect(state()).toMatchObject({ stage: 'skipped', skipped: { by: 'owner', reason: 'Rate limit reached' } });
    expect(taskDesign('t')?.skipNote).toEqual({ by: 'owner', reason: 'Rate limit reached' });
    expect(startTask).toHaveBeenCalled();
  });

  it('refuses both when the task does not wait for that decision', async () => {
    expect((await skipTaskDesign({} as never, () => null, 't')).success).toBe(false);
    expect((await retryTaskDesign({} as never, () => null, 't')).success).toBe(false);
    expect(state().stage).toBe('wireframes');
    expect(startTask).not.toHaveBeenCalled();
  });
});

// Stop waiting on the card and the Design tab: the designer waiting out a rate limit stops for the owner now
describe('stop waiting for the designer', () => {
  it('tells the running task to stop waiting', () => {
    spec.status = 'in_progress';
    const agentManager = { stopDesignWait: vi.fn(() => true) };
    expect(stopDesignWait(agentManager as never, 't')).toEqual({ success: true });
    expect(agentManager.stopDesignWait).toHaveBeenCalledWith('t');
  });

  it('refuses when the task is not running', () => {
    const agentManager = { stopDesignWait: vi.fn(() => true) };
    expect(stopDesignWait(agentManager as never, 't').success).toBe(false);
    expect(agentManager.stopDesignWait).not.toHaveBeenCalled();
    spec.status = 'in_progress';
    expect(stopDesignWait({ stopDesignWait: () => false } as never, 't').success).toBe(false);
  });
});
