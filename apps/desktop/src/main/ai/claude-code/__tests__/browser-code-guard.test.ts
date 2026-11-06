import { describe, expect, it } from 'vitest';

import { evaluatePreToolUse } from '../security-hooks';
import type { ToolContext } from '../../tools/types';

const context: ToolContext = {
  cwd: '/work/tree',
  projectDir: '/work/tree',
  specDir: '/work/tree/.vibe-teamlead/specs/001-demo',
  securityProfile: undefined as never,
};

const decision = (toolName: string, agentType?: ToolContext['agentType']) => {
  const output = evaluatePreToolUse(toolName, { code: 'async (page) => page.url()' }, { ...context, agentType }) as {
    hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string };
  };
  return output.hookSpecificOutput;
};

describe('code run in the browser server', () => {
  it.each(['qa_reviewer', 'qa_fixer', 'coder'] as const)('is denied to %s: it runs outside the Bash and write checks', (agentType) => {
    expect(decision('mcp__playwright__browser_run_code_unsafe', agentType)?.permissionDecision).toBe('deny');
  });

  it('is denied under the name other versions of the server use', () => {
    expect(decision('mcp__playwright__browser_run_code')?.permissionDecision).toBe('deny');
  });

  it('tells the agent what to use instead, so it goes on with the check', () => {
    expect(decision('mcp__playwright__browser_run_code_unsafe')?.permissionDecisionReason).toMatch(/browser_click/);
  });

  it.each(['browser_click', 'browser_snapshot', 'browser_fill_form', 'browser_take_screenshot', 'browser_console_messages'])(
    'leaves %s alone',
    (tool) => {
      expect(decision(`mcp__playwright__${tool}`)).toBeUndefined();
    },
  );
});
