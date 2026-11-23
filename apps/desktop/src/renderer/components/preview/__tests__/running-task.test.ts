import { describe, expect, it } from 'vitest';

import { RUNNING_MD_SECTIONS, runningTask } from '../running-task';

describe('the "write RUNNING.md" task', () => {
  const task = runningTask();

  it('names the file in its title', () => {
    expect(task.title).toMatch(/RUNNING\.md/);
  });

  it('lists every section the file has', () => {
    for (const section of RUNNING_MD_SECTIONS) expect(task.description).toContain(section);
    expect(RUNNING_MD_SECTIONS).toEqual(['Prerequisites', 'Setup', 'Database', 'Start', 'Signing in locally', 'Common problems']);
  });

  it("documents the project without changing its code, and checks what it documents", () => {
    expect(task.description).toMatch(/Don't change the project's code/);
    expect(task.description).toMatch(/run it where it is safe/);
  });

  it('never puts real secrets in the file', () => {
    expect(task.description).toMatch(/\.env\.example/);
    expect(task.description).toMatch(/never real values/);
  });

  it('writes preview.json too, and has the app start the project by it', () => {
    expect(task.title).toMatch(/preview\.json/);
    expect(task.description).toMatch(/`preview\.json`/);
    expect(task.description).toMatch(/- AC-\d+: `preview\.json` exists[^\n]*starts/);
    expect(task.description).not.toMatch(/adds `RUNNING\.md` and nothing else/);
  });

  it('has acceptance criteria with ids, as every task does', () => {
    expect(task.description).toMatch(/## Acceptance criteria/);
    expect(task.description).toMatch(/- AC-1: /);
    expect(task.description).toMatch(/- AC-3: /);
  });
});
