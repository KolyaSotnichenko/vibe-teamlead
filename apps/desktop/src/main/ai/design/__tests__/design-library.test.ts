import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { BASE_FRAMES_MAX, copyLibraryToBase, type LibraryFrame, libraryDir, publishToLibrary, readLibrary, selectBaseFrames } from '../design-library';

function taskSpec(root: string, specId: string, frames: Array<{ file: string; title: string; kind: 'wireframe' | 'screen'; html: string }>): string {
  const dir = path.join(root, '.vibe-teamlead', 'specs', specId);
  for (const f of frames) {
    mkdirSync(path.dirname(path.join(dir, 'design', f.file)), { recursive: true });
    writeFileSync(path.join(dir, 'design', f.file), f.html);
  }
  writeFileSync(path.join(dir, 'design', 'canvas.json'), JSON.stringify({ frames: frames.map((f, i) => ({ file: f.file, title: f.title, kind: f.kind, width: 1280, height: 900, x: i * 1360, y: 0 })) }));
  return dir;
}

describe("the project's design library", () => {
  it("collects every task's frames, the same file name replacing the older version", () => {
    const root = mkdtempSync(path.join(tmpdir(), 'vtl-lib-'));
    const a = taskSpec(root, '051-roadmap', [
      { file: 'screens/roadmap-desktop.html', title: 'Roadmap · desktop', kind: 'screen', html: 'v1' },
      { file: 'wireframes/roadmap-desktop.html', title: 'Roadmap · desktop', kind: 'wireframe', html: 'w1' },
    ]);
    publishToLibrary(root, a, { taskId: '051-roadmap', now: new Date('2026-11-10T10:00:00Z') });
    const b = taskSpec(root, '052-changelog', [
      { file: 'screens/roadmap-desktop.html', title: 'Roadmap · desktop', kind: 'screen', html: 'v2' },
      { file: 'screens/changelog.html', title: 'Changelog', kind: 'screen', html: 'c1' },
    ]);
    publishToLibrary(root, b, { taskId: '052-changelog', now: new Date('2026-11-11T10:00:00Z') });

    const library = readLibrary(root);
    // Wireframes in one band, the screens in the band under them
    expect(library.frames.map((f) => [f.file, f.taskId, f.y])).toEqual([
      ['wireframes/roadmap-desktop.html', '051-roadmap', 0],
      ['screens/changelog.html', '052-changelog', 1200],
      ['screens/roadmap-desktop.html', '052-changelog', 1200],
    ]);
    expect(readFileSync(path.join(libraryDir(root), 'screens', 'roadmap-desktop.html'), 'utf-8')).toBe('v2');
  });

  it("gives the next task's designer the library as its starting point, under design/base/", () => {
    const root = mkdtempSync(path.join(tmpdir(), 'vtl-lib-'));
    publishToLibrary(root, taskSpec(root, '051', [{ file: 'screens/roadmap.html', title: 'Roadmap', kind: 'screen', html: 'v1' }]), { taskId: '051' });
    const next = path.join(mkdtempSync(path.join(tmpdir(), 'vtl-wt-')), 'spec');
    expect(copyLibraryToBase(root, next)).toEqual({ copied: 1, listed: 1 });
    expect(readFileSync(path.join(next, 'design', 'base', 'screens', 'roadmap.html'), 'utf-8')).toBe('v1');
    expect(existsSync(path.join(next, 'design', 'base', 'canvas.json'))).toBe(true);
    expect(copyLibraryToBase(mkdtempSync(path.join(tmpdir(), 'vtl-empty-')), next)).toEqual({ copied: 0, listed: 0 });
  });
});

describe('what the library refuses', () => {
  it('a frame that is a link, or whose path leaves the library, is not copied', async () => {
    const { symlinkSync } = await import('node:fs');
    const root = mkdtempSync(path.join(tmpdir(), 'vtl-lib-'));
    const spec = taskSpec(root, '060', [{ file: 'screens/ok.html', title: 'Ok', kind: 'screen', html: 'ok' }]);
    const outside = path.join(mkdtempSync(path.join(tmpdir(), 'vtl-out-')), 'secret.html');
    writeFileSync(outside, 'secret');
    symlinkSync(outside, path.join(spec, 'design', 'screens', 'leak.html'));
    mkdirSync(path.join(spec, 'design', 'other'), { recursive: true });
    writeFileSync(path.join(spec, 'design', 'other', 'x.html'), 'x');
    writeFileSync(path.join(spec, 'design', 'canvas.json'), JSON.stringify({ frames: [
      { file: 'screens/ok.html', title: 'Ok', kind: 'screen', width: 400, height: 400, x: 0, y: 0 },
      { file: 'screens/leak.html', title: 'Leak', kind: 'screen', width: 400, height: 400, x: 0, y: 0 },
      { file: 'other/x.html', title: 'Elsewhere', kind: 'screen', width: 400, height: 400, x: 0, y: 0 },
    ] }));
    expect(publishToLibrary(root, spec, { taskId: '060' })).toBe(1);
    expect(readLibrary(root).frames.map((f) => f.file)).toEqual(['screens/ok.html']);
    expect(existsSync(path.join(libraryDir(root), 'screens', 'leak.html'))).toBe(false);
    expect(existsSync(path.join(libraryDir(root), 'other'))).toBe(false);
  });

  it('a library entry that is a link is not copied into a task', async () => {
    const { symlinkSync } = await import('node:fs');
    const root = mkdtempSync(path.join(tmpdir(), 'vtl-lib-'));
    publishToLibrary(root, taskSpec(root, '061', [{ file: 'screens/a.html', title: 'A', kind: 'screen', html: 'a' }]), { taskId: '061' });
    const outside = path.join(mkdtempSync(path.join(tmpdir(), 'vtl-out-')), 'secret.html');
    writeFileSync(outside, 'secret');
    symlinkSync(outside, path.join(libraryDir(root), 'screens', 'b.html'));
    const canvas = JSON.parse(readFileSync(path.join(libraryDir(root), 'canvas.json'), 'utf-8'));
    canvas.frames.push({ ...canvas.frames[0], file: 'screens/b.html' });
    writeFileSync(path.join(libraryDir(root), 'canvas.json'), JSON.stringify(canvas));
    const next = path.join(mkdtempSync(path.join(tmpdir(), 'vtl-wt-')), 'spec');
    expect(copyLibraryToBase(root, next)).toEqual({ copied: 1, listed: 1 });
    expect(existsSync(path.join(next, 'design', 'base', 'screens', 'b.html'))).toBe(false);
  });

  it('keeps a responsive page once per width it is shown at', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'vtl-lib-'));
    const spec = taskSpec(root, '062', [{ file: 'screens/table.html', title: 'Table · desktop', kind: 'screen', html: 't' }]);
    writeFileSync(path.join(spec, 'design', 'canvas.json'), JSON.stringify({ frames: [
      { file: 'screens/table.html', title: 'Table · desktop', kind: 'screen', width: 1280, height: 900, x: 0, y: 0 },
      { file: 'screens/table.html', title: 'Table · phone', kind: 'screen', width: 390, height: 844, x: 1360, y: 0 },
    ] }));
    publishToLibrary(root, spec, { taskId: '062' });
    expect(readLibrary(root).frames.map((f) => [f.file, f.width])).toEqual([['screens/table.html', 1280], ['screens/table.html', 390]]);
  });
});

const frame = (file: string, title: string, width = 1280): LibraryFrame => ({
  file, title, kind: file.startsWith('screens/') ? 'screen' : 'wireframe', width, height: 900, x: 0, y: 0, taskId: 't', updatedAt: 'x',
});

describe("the designer's start: only the frames the task needs", () => {
  const library = [
    frame('screens/app-shell.html', 'Оболонка застосунку · desktop'),
    frame('screens/app-shell.html', 'Оболонка застосунку · phone', 390),
    frame('screens/plan-board.html', 'Дошка плану · desktop'),
    frame('screens/plan-board.html', 'Дошка плану · phone', 390),
    frame('wireframes/plan-board.html', 'Дошка плану · desktop'),
    frame('screens/plan-settings.html', 'Налаштування плану'),
    frame('screens/audit-log.html', 'Журнал аудиту'),
    frame('screens/sign-in.html', 'Вхід'),
    ...Array.from({ length: 40 }, (_, i) => frame(`screens/other-${i}.html`, `Other ${i}`)),
  ];

  it("takes the frames whose names the spec's screens and routes name, and the app shell", () => {
    const spec = '## Overview\nThe plan owner names labels in plan settings (`/plans/:id/settings`), and the `PlanBoard` shows them on its cards.';
    const files = selectBaseFrames(library, spec).map((f) => `${f.file}@${f.width}`);
    expect(files).toEqual(expect.arrayContaining(['screens/app-shell.html@1280', 'screens/app-shell.html@390', 'screens/plan-board.html@1280', 'screens/plan-board.html@390', 'wireframes/plan-board.html@1280', 'screens/plan-settings.html@1280']));
    expect(files).not.toContain('screens/audit-log.html@1280');
    expect(files).not.toContain('screens/other-1.html@1280');
  });

  it('without an exact signal, the words of the spec fill the list', () => {
    const spec = '## Overview\nLabels show on cards on the plan board.';
    const files = selectBaseFrames(library, spec).map((f) => f.file);
    expect(files).toContain('screens/plan-board.html');
    expect(files).toContain('screens/app-shell.html');
  });

  it('never more than the cap', () => {
    const spec = Array.from({ length: 40 }, (_, i) => `other ${i}`).join(' ');
    const many = Array.from({ length: 40 }, (_, i) => frame(`screens/other-screen-${i}.html`, `Other ${i}`));
    expect(selectBaseFrames(many, `${spec} other screen`).length).toBeLessThanOrEqual(BASE_FRAMES_MAX);
  });

  it('lists the chosen frames in base/canvas.json and the rest in base/index.md, every file still there to open', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'vtl-lib-'));
    const files = [...new Set(library.map((f) => f.file))];
    for (const file of files) {
      mkdirSync(path.dirname(path.join(libraryDir(root), file)), { recursive: true });
      writeFileSync(path.join(libraryDir(root), file), `<p>${file}</p>`);
    }
    writeFileSync(path.join(libraryDir(root), 'canvas.json'), JSON.stringify({ frames: library }));
    const spec = path.join(mkdtempSync(path.join(tmpdir(), 'vtl-wt-')), 'spec');
    const result = copyLibraryToBase(root, spec, 'Show labels on the plan board.');
    expect(result.copied).toBe(files.length);
    const canvas = JSON.parse(readFileSync(path.join(spec, 'design', 'base', 'canvas.json'), 'utf-8')) as { frames: LibraryFrame[] };
    expect(canvas.frames.length).toBe(result.listed);
    expect(canvas.frames.map((f) => f.file)).toContain('screens/plan-board.html');
    const index = readFileSync(path.join(spec, 'design', 'base', 'index.md'), 'utf-8');
    expect(index).toContain('screens/audit-log.html');
    expect(index).not.toContain('screens/plan-board.html');
    expect(existsSync(path.join(spec, 'design', 'base', 'screens', 'audit-log.html'))).toBe(true);
  });
});

/** A planner-mhp-like library: the admin section, directory sync and the audit log with their states, plans */
function plannerLibrary(): LibraryFrame[] {
  const names = [
    'home', 'admin', 'access-refused', 'not-found',
    'directory-sync', 'directory-sync-warning', 'directory-sync-failed', 'directory-sync-running', 'directory-sync-empty',
    'audit-log', 'audit-log-empty', 'audit-log-error', 'audit-log-filtered', 'audit-log-entry',
    'plans', 'plans-empty', 'plan-board', 'plan-board-member', 'plan-create', 'plan-history', 'plan-settings',
    'task-card', 'task-card-history', 'my-tasks', 'sign-in-error', 'signed-out',
  ];
  return names.flatMap((name) => [frame(`screens/${name}.html`, `${name} · desktop`), frame(`wireframes/${name}.html`, `${name} · desktop`)]);
}

/** Spec 005 of planner-mhp (RBAC) in short: an admin Roles page, and much about directory sync in its API */
const RBAC_SPEC = [
  '# Specification: Introduce role-based access control',
  '## Overview',
  'System roles are assigned to users or to directory groups synced by the directory sync (T4). The web app gets an Administration › Roles page. A warning shows when a sync removed a group.',
  '## Files to Modify',
  '| File | Service | What |',
  '|---|---|---|',
  '| `apps/api/src/directory-sync/routes.ts` | api | `config.authz` on `GET /api/admin/directory-sync/status`, `GET /api/admin/directory-sync/runs` |',
  '| `apps/web/src/App.tsx` | web | Route `/admin/roles` inside `<RequireRole>` |',
  '## Files to Create',
  '- `apps/web/src/pages/admin/RolesPage.tsx`, `RolesPage.test.tsx`',
  '## Files to Reference',
  '| `apps/web/src/pages/admin/DirectorySyncPage.tsx` | the directory sync page: api prop, mhp components |',
  '## Requirements',
  'Directory sync keeps groups in step; the sync warning names removed groups.',
].join('\n');

/** Spec 006 (audit log viewer) in short */
const AUDIT_SPEC = [
  '# Specification: Record an immutable audit log with a viewer',
  '## Overview',
  'Record sign-ins, role changes and directory sync runs. An Administration › Audit log viewer at `/admin/audit`.',
  '## Files to Create',
  '| `apps/web/src/pages/admin/AuditLogPage.tsx` | web | the viewer |',
  '## Files to Reference',
  '| `apps/web/src/pages/admin/DirectorySyncPage.tsx` | api prop injection, Alert/Button |',
  '## Requirements',
  'Directory sync runs are recorded with a warning when the sync failed.',
].join('\n');

describe("the designer's start: exact signals before words (planner-mhp)", () => {
  const library = plannerLibrary();

  it('RBAC (005): the admin page its route and files name, the shell; not the directory sync its words match', () => {
    const files = selectBaseFrames(library, RBAC_SPEC).map((f) => f.file);
    expect(files).toEqual(expect.arrayContaining(['screens/admin.html', 'wireframes/admin.html', 'screens/home.html']));
    expect(files.some((f) => f.includes('directory-sync'))).toBe(false);
    expect(files.length).toBeLessThanOrEqual(BASE_FRAMES_MAX);
  });

  it('audit log (006): the audit-log screen and its states from the route and the page name; not the directory sync', () => {
    const files = selectBaseFrames(library, AUDIT_SPEC).map((f) => f.file);
    expect(files).toEqual(expect.arrayContaining(['screens/audit-log.html', 'wireframes/audit-log.html']));
    expect(files.filter((f) => f.startsWith('screens/audit-log')).length).toBe(3);
    expect(files.some((f) => f.includes('directory-sync'))).toBe(false);
  });

  it('a route like /plans/:id/board and a component name pick the screen itself, before the shell', () => {
    const spec = '## Overview\nShow plans as a Kanban board at `/plans/:id/board`.\n## Files to Modify\n| `apps/web/src/pages/plans/board/Board.tsx` | web | columns |\n| `apps/web/src/pages/plans/board/BoardCard.tsx` | web | the `TaskCard` summary |';
    const chosen = selectBaseFrames(library, spec).map((f) => f.file);
    expect(chosen.indexOf('screens/plan-board.html')).toBeGreaterThanOrEqual(0);
    expect(chosen.indexOf('screens/plan-board.html')).toBeLessThan(chosen.indexOf('screens/home.html'));
    expect(chosen).toContain('screens/task-card.html');
  });

  it('an API route or a file to reference is no signal', () => {
    const spec = '## Overview\nA health check.\n## Files to Modify\n| `apps/api/src/plans/routes.ts` | api | `GET /api/plans/:id` |\n## Files to Reference\n| `apps/web/src/pages/plans/PlansPage.tsx` | pattern |';
    const files = selectBaseFrames(library, spec).map((f) => f.file);
    expect(files.some((f) => /\/plans?[-.]/.test(f))).toBe(false);
  });

  it('never more than the cap, however many screens the spec names exactly', () => {
    const spec = library.map((f) => '`/' + path.basename(f.file, '.html') + '`').join(' ');
    expect(selectBaseFrames(library, spec, 7).length).toBeLessThanOrEqual(7);
  });

  it('keeps library frames whole: the shared stylesheet is put inside each copy, and kept as the next designer\'s start', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'vtl-lib-'));
    const spec = taskSpec(root, '070', [{ file: 'screens/board.html', title: 'Board', kind: 'screen', html: '<head><link rel="stylesheet" href="styles.css"><style>.x{}</style></head><body></body>' }]);
    writeFileSync(path.join(spec, 'design', 'screens', 'styles.css'), '.btn{color:#111}');
    publishToLibrary(root, spec, { taskId: '070' });
    const copy = readFileSync(path.join(libraryDir(root), 'screens', 'board.html'), 'utf-8');
    expect(copy).not.toContain('href="styles.css"');
    expect(copy).toContain('<style>.btn{color:#111}</style>');
    expect(copy).toContain('<style>.x{}</style>');
    // The task's own stylesheet stays untouched in its spec folder
    expect(readFileSync(path.join(spec, 'design', 'screens', 'board.html'), 'utf-8')).toContain('href="styles.css"');
    expect(readFileSync(path.join(libraryDir(root), 'screens', 'styles.css'), 'utf-8')).toBe('.btn{color:#111}');

    const next = path.join(mkdtempSync(path.join(tmpdir(), 'vtl-wt-')), 'spec');
    copyLibraryToBase(root, next);
    expect(readFileSync(path.join(next, 'design', 'base', 'screens', 'styles.css'), 'utf-8')).toBe('.btn{color:#111}');
  });

  it('leaves a frame without a stylesheet link as it is', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'vtl-lib-'));
    const spec = taskSpec(root, '071', [{ file: 'wireframes/a.html', title: 'A', kind: 'wireframe', html: '<link rel="stylesheet" href="https://x/y.css"><p>a</p>' }]);
    publishToLibrary(root, spec, { taskId: '071' });
    expect(readFileSync(path.join(libraryDir(root), 'wireframes', 'a.html'), 'utf-8')).toBe('<link rel="stylesheet" href="https://x/y.css"><p>a</p>');
    expect(existsSync(path.join(libraryDir(root), 'wireframes', 'styles.css'))).toBe(false);
  });
});

