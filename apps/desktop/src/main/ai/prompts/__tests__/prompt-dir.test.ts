import { describe, expect, it } from 'vitest';

import { getQaToolsSection, resolvePromptsDir, setPromptsDir, tryLoadPrompt } from '../prompt-loader';
import type { ProjectCapabilities } from '../types';

describe('prompts directory', () => {
  it('finds the role prompts outside Electron', () => {
    setPromptsDir(resolvePromptsDir());
    for (const role of ['planner', 'coder', 'qa_reviewer', 'qa_fixer', 'architect', 'spec_writer']) {
      expect(tryLoadPrompt(role), role).toBeTruthy();
    }
  });

  it('adds the browser validation guide for web frontends', () => {
    setPromptsDir(resolvePromptsDir());
    const section = getQaToolsSection({ is_web_frontend: true } as ProjectCapabilities);
    expect(section).toContain('mcp__playwright__browser_navigate');
  });

  it('leaves the UI guides out when the task changed no UI file (no browser tools then), keeps API and database', () => {
    setPromptsDir(resolvePromptsDir());
    const caps = { is_web_frontend: true, is_electron: false, is_tauri: true, has_api: true, has_database: true } as ProjectCapabilities;
    const section = getQaToolsSection(caps, { taskTouchesUi: false });
    expect(section).not.toContain('mcp__playwright__browser_navigate');
    expect(section).not.toMatch(/tauri/i);
    expect(section).toBe(getQaToolsSection({ has_api: true, has_database: true } as ProjectCapabilities));
    expect(getQaToolsSection(caps, { taskTouchesUi: true })).toContain('mcp__playwright__browser_navigate');
    expect(getQaToolsSection(caps)).toContain('mcp__playwright__browser_navigate');
  });
});
