import { describe, expect, it } from 'vitest';

import { codegraphMcpServer } from '../codegraph';
import { toSdkServerConfig } from '../mcp-servers';

describe('MCP server environments', () => {
  it('never hand the session credentials to third-party stdio servers', () => {
    const sdk = toSdkServerConfig({
      id: 'context7',
      name: 'Context7',
      description: '',
      enabledByDefault: true,
      transport: { type: 'stdio', command: 'npx', args: ['-y', '@upstash/context7-mcp@4.4.4'], env: { FOO: '1' } },
    }) as { env: Record<string, string> };
    expect(sdk.env).toMatchObject({ FOO: '1', ANTHROPIC_API_KEY: '', CLAUDE_CODE_OAUTH_TOKEN: '' });
    expect(codegraphMcpServer('/bin/codegraph', '/repo').env).toMatchObject({ ANTHROPIC_API_KEY: '', CLAUDE_CODE_OAUTH_TOKEN: '' });
  });
});
