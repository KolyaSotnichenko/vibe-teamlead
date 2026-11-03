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
});
