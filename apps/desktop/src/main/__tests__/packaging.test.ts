import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const build = JSON.parse(readFileSync(resolve(__dirname, '../../../package.json'), 'utf-8')).build as {
  files: string[];
  extraResources: { from: string; to: string }[];
};

describe('what ships in the app', () => {
  // resolvePackagedTools runs them from Resources. As dependencies they would ship a second time, unpacked from the asar.
  it.each([
    ['Claude Code', '!**/node_modules/@anthropic-ai/claude-agent-sdk-*/**', 'claude-code/claude'],
    ['CodeGraph', '!**/node_modules/@colbymchenry/codegraph-*/**', 'codegraph'],
  ])('%s ships once, in Resources', (_name, excluded, resource) => {
    expect(build.files).toContain(excluded);
    expect(build.extraResources.map((entry) => entry.to)).toContain(resource);
  });
});
