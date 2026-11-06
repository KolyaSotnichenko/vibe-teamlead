import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const build = JSON.parse(readFileSync(resolve(__dirname, '../../../package.json'), 'utf-8')).build as {
  files: string[];
  extraResources: { from: string; to: string }[];
  dmg?: { size?: string };
  afterAllArtifactBuild?: string;
};

describe('what ships in the app', () => {
  // Sized automatically, the volume once came out too small: it dropped the framework, the build
  // succeeded, and the released app crashed on launch.
  it('sets the DMG volume size, and checks every DMG against the app', () => {
    expect(build.dmg?.size).toBeTruthy();
    expect(build.afterAllArtifactBuild).toBe('scripts/verify-dmg.cjs');
  });

  // resolvePackagedTools runs them from Resources. As dependencies they would ship a second time, unpacked from the asar.
  it.each([
    ['Claude Code', '!**/node_modules/@anthropic-ai/claude-agent-sdk-*/**', 'claude-code/claude'],
    ['CodeGraph', '!**/node_modules/@colbymchenry/codegraph-*/**', 'codegraph'],
  ])('%s ships once, in Resources', (_name, excluded, resource) => {
    expect(build.files).toContain(excluded);
    expect(build.extraResources.map((entry) => entry.to)).toContain(resource);
  });
});
