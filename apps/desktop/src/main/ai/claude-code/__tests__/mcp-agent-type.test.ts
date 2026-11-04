import { describe, expect, it, vi } from 'vitest';

const { createBuildToolsServer } = vi.hoisted(() => ({
  createBuildToolsServer: vi.fn((_context: unknown, _tools: unknown) => ({ type: 'sdk' })),
}));
vi.mock('../sdk-tools', () => ({ APP_TOOLS_SERVER_KEY: 'vibe-teamlead', createBuildToolsServer }));

import { buildMcpServers } from '../mcp-servers';
import type { ToolContext } from '../../tools/types';

describe('app tools know their agent', () => {
  it('passes the agent type in the tool context', () => {
    buildMcpServers('qa_fixer', { cwd: '/x', specDir: '/x', projectDir: '/x' } as unknown as ToolContext);
    expect(createBuildToolsServer.mock.calls[0][0]).toMatchObject({ agentType: 'qa_fixer', cwd: '/x' });
  });
});
