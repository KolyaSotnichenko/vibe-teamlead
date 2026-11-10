import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { animatesWithGsap } from '../animation';

function project(files: Record<string, string>): string {
  const root = mkdtempSync(path.join(tmpdir(), 'vtl-anim-'));
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), text);
  }
  return root;
}

describe('whether a task animates with GSAP', () => {
  it('when the project or one of its workspace packages depends on gsap', () => {
    expect(animatesWithGsap(project({ 'package.json': '{"dependencies":{"gsap":"^3.13.0"}}' }))).toBe(true);
    expect(animatesWithGsap(project({ 'package.json': '{"workspaces":["apps/*"]}', 'apps/web/package.json': '{"dependencies":{"@gsap/react":"^2.1.2"}}' }))).toBe(true);
    expect(animatesWithGsap(project({ 'package.json': '{"dependencies":{"react":"19"}}' }))).toBe(false);
  });

  it("when the task's design uses it, though the project doesn't yet", () => {
    const root = project({ 'package.json': '{}', 'spec/design/screens/roadmap.html': '<script src="gsap.min.js"></script><script>gsap.from(".card",{y:8})</script>' });
    expect(animatesWithGsap(root, path.join(root, 'spec'))).toBe(true);
    expect(animatesWithGsap(project({ 'package.json': 'not json' }))).toBe(false);
  });
});
