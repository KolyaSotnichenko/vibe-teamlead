import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { RUNNING_MD_MAX_BYTES, readRunningMd } from '../running-md';

const project = () => mkdtempSync(join(tmpdir(), 'vt-running-'));

describe("the project's RUNNING.md", () => {
  it('reads it from the project root', () => {
    const root = project();
    writeFileSync(join(root, 'RUNNING.md'), '# How to run\n\nnpm run dev\n');
    expect(readRunningMd(root)).toEqual({ exists: true, markdown: '# How to run\n\nnpm run dev\n', truncated: false });
  });

  it('says it is missing when there is none', () => {
    expect(readRunningMd(project())).toEqual({ exists: false });
  });

  it('is missing when RUNNING.md is a folder', () => {
    const root = project();
    mkdirSync(join(root, 'RUNNING.md'));
    expect(readRunningMd(root)).toEqual({ exists: false });
  });

  it('reads at most the cap, so a huge file cannot fill the window', () => {
    const root = project();
    writeFileSync(join(root, 'RUNNING.md'), 'a'.repeat(RUNNING_MD_MAX_BYTES + 100));
    const read = readRunningMd(root);
    expect(read).toMatchObject({ exists: true, truncated: true });
    expect(read.exists && read.markdown.length).toBe(RUNNING_MD_MAX_BYTES);
  });

  it('does not follow a link that leads out of the project', () => {
    const root = project();
    const outside = project();
    writeFileSync(join(outside, 'secret.txt'), 'secret');
    try {
      symlinkSync(join(outside, 'secret.txt'), join(root, 'RUNNING.md'));
    } catch {
      return; // Symlinks need extra rights on Windows
    }
    expect(readRunningMd(root)).toEqual({ exists: false });
  });

  it('follows a link that stays inside the project', () => {
    const root = project();
    mkdirSync(join(root, 'docs'));
    writeFileSync(join(root, 'docs', 'running.md'), 'inside');
    try {
      symlinkSync(join(root, 'docs', 'running.md'), join(root, 'RUNNING.md'));
    } catch {
      return;
    }
    expect(readRunningMd(root)).toMatchObject({ exists: true, markdown: 'inside' });
  });

  it('is missing for a project folder that does not exist', () => {
    expect(readRunningMd(join(project(), 'gone'))).toEqual({ exists: false });
  });
});
