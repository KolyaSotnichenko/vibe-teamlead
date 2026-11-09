/**
 * Preview beyond JavaScript: services, dependency installs and migrations for Python
 * (Django, FastAPI, Flask), Ruby (Rails), PHP (Laravel) and Go, found from the project's
 * files the way detect-services.ts finds Node packages. The owner confirms the services
 * once, as for Node. Pure: no Electron imports, no file access.
 */

import type { PreviewService } from '../../shared/types/project';
import type { ProjectFiles } from '../ai/verification/detect-checks';

const SKIPPED = /(^|\/)(node_modules|vendor|\.venv|venv|\.vibe-teamlead|\.git|dist|build|tests?|__tests__|e2e)\//;
const MAX_DEPTH = 2;

/** A folder's dependency install, and the files whose change means installing again */
export interface StackInstall {
  dir: string;
  command: string;
  lockfiles: string[];
}

const join = (dir: string, file: string) => (dir ? `${dir}/${file}` : file);
const parentOf = (file: string) => (file.includes('/') ? file.slice(0, file.lastIndexOf('/')) : '');
const depthOf = (dir: string) => (dir ? dir.split('/').length : 0);
const nameOf = (dir: string) => (dir ? dir.split('/').pop()!.replace(/[^\w-]/g, '-').slice(0, 40) : 'web');

/** How Python commands run in a folder: the project's runner, or the preview's own .venv. `has` takes paths in the folder. */
function pythonRunner(has: (file: string) => boolean): string {
  if (has('uv.lock')) return 'uv run ';
  if (has('poetry.lock')) return 'poetry run ';
  return '.venv/bin/';
}

function pythonDependencies(project: ProjectFiles, dir: string): string {
  return ['pyproject.toml', 'requirements.txt', 'Pipfile'].map((file) => project.read(join(dir, file)) ?? '').join('\n').toLowerCase();
}

/** The module and variable holding a FastAPI app, as uvicorn wants them (`app.main:app`) */
function fastapiTarget(project: ProjectFiles, dir: string): { target: string; appDir?: string } | undefined {
  const prefix = dir ? `${dir}/` : '';
  const candidates = project.files
    .filter((file) => file.startsWith(prefix) && file.endsWith('.py') && !SKIPPED.test(file) && depthOf(file.slice(prefix.length)) <= 4)
    .sort((a, b) => Number(!/(^|\/)main\.py$/.test(a)) - Number(!/(^|\/)main\.py$/.test(b)) || a.length - b.length);
  for (const file of candidates) {
    const variable = /^(\w+)\s*=\s*FastAPI\(/m.exec(project.read(file) ?? '')?.[1];
    if (!variable) continue;
    let module = file.slice(prefix.length, -'.py'.length);
    let appDir: string | undefined;
    if (module.startsWith('src/')) {
      appDir = 'src';
      module = module.slice('src/'.length);
    }
    return { target: `${module.replace(/\//g, '.')}:${variable}`, appDir };
  }
  return undefined;
}

interface Proposal {
  service: PreviewService;
  /** Serves pages a person opens, not only an API */
  html: boolean;
}

function proposalsIn(project: ProjectFiles, dir: string): Proposal[] {
  const has = (file: string) => project.files.includes(join(dir, file));
  const name = nameOf(dir);
  const py = pythonRunner(has);
  if (has('manage.py')) {
    const python = py === '.venv/bin/' ? '.venv/bin/python' : `${py}python`;
    return [{ service: { name, dir, command: `${python} manage.py runserver 127.0.0.1:{port}` }, html: true }];
  }
  if (has('artisan')) return [{ service: { name, dir, command: 'php artisan serve --host=127.0.0.1 --port={port}' }, html: true }];
  if (has('bin/rails') && /gem\s+['"]rails['"]/.test(project.read(join(dir, 'Gemfile')) ?? '')) {
    return [{ service: { name, dir, command: 'bin/rails server -b 127.0.0.1 -p {port}' }, html: true }];
  }
  const python = pythonDependencies(project, dir);
  if (/\bfastapi\b/.test(python)) {
    const found = fastapiTarget(project, dir);
    if (found) {
      const appDir = found.appDir ? ` --app-dir ${found.appDir}` : '';
      return [{ service: { name, dir, command: `${py}uvicorn ${found.target} --reload${appDir} --host 127.0.0.1 --port {port}` }, html: false }];
    }
  }
  if (/\bflask\b/.test(python) && (has('app.py') || has('wsgi.py'))) {
    return [{ service: { name, dir, command: `${py}flask run --host 127.0.0.1 --port {port}` }, html: true }];
  }
  if (has('go.mod')) {
    if (has('main.go')) return [{ service: { name, dir, command: 'go run .' }, html: false }];
    const prefix = join(dir, 'cmd/');
    const main = project.files.filter((file) => file.startsWith(prefix) && /^[^/]+\/main\.go$/.test(file.slice(prefix.length))).sort()[0];
    if (main) {
      const command = main.slice(prefix.length).split('/')[0];
      return [{ service: { name: command.replace(/[^\w-]/g, '-'), dir, command: `go run ./cmd/${command}` }, html: false }];
    }
  }
  return [];
}

/** Folders that may hold a service: where a framework's marker file is */
function candidateDirs(files: string[]): string[] {
  const markers = /(^|\/)(manage\.py|artisan|bin\/rails|go\.mod|pyproject\.toml|requirements\.txt)$/;
  const dirs = new Set<string>();
  for (const file of files) {
    if (SKIPPED.test(file) || !markers.test(file)) continue;
    const dir = file.endsWith('bin/rails') ? parentOf(parentOf(file)) : parentOf(file);
    if (depthOf(dir) <= MAX_DEPTH) dirs.add(dir);
  }
  return [...dirs].sort();
}

/** Services in Python, Ruby, PHP and Go; the first one serving pages is the page. */
export function proposeStackServices(project: ProjectFiles): PreviewService[] {
  const proposals = candidateDirs(project.files).flatMap((dir) => proposalsIn(project, dir));
  const pageIndex = Math.max(0, proposals.findIndex((p) => p.html));
  return proposals.map((p, i) => (i === pageIndex ? { ...p.service, page: true } : p.service));
}

/** Each folder's dependency install, for the folders given (the root and the services'). */
export function stackInstalls(project: ProjectFiles, dirs: string[]): StackInstall[] {
  const installs: StackInstall[] = [];
  for (const dir of [...new Set(dirs)]) {
    const has = (file: string) => project.files.includes(join(dir, file));
    const existing = (...files: string[]) => files.filter(has).map((file) => join(dir, file));
    if (has('uv.lock')) installs.push({ dir, command: 'uv sync', lockfiles: existing('uv.lock', 'pyproject.toml') });
    else if (has('poetry.lock')) installs.push({ dir, command: 'poetry install --no-interaction', lockfiles: existing('poetry.lock', 'pyproject.toml') });
    else if (has('requirements.txt')) installs.push({ dir, command: 'python3 -m venv .venv && .venv/bin/pip install -r requirements.txt', lockfiles: existing('requirements.txt') });
    else if (has('pyproject.toml') && has('manage.py')) installs.push({ dir, command: 'python3 -m venv .venv && .venv/bin/pip install -e .', lockfiles: existing('pyproject.toml') });
    if (has('Gemfile')) installs.push({ dir, command: 'bundle install', lockfiles: existing('Gemfile.lock', 'Gemfile') });
    if (has('composer.json')) installs.push({ dir, command: 'composer install --no-interaction', lockfiles: existing('composer.lock', 'composer.json') });
    if (has('go.mod')) installs.push({ dir, command: 'go mod download', lockfiles: existing('go.sum', 'go.mod') });
  }
  return installs;
}

/** A folder's framework migrations: Django, Alembic, Rails, Laravel. */
export function frameworkMigrations(project: ProjectFiles, dir: string): string[] {
  const has = (file: string) => project.files.includes(join(dir, file));
  const py = pythonRunner(has);
  const commands: string[] = [];
  if (has('manage.py')) commands.push(`${py === '.venv/bin/' ? '.venv/bin/python' : `${py}python`} manage.py migrate`);
  if (has('alembic.ini')) commands.push(`${py}alembic upgrade head`);
  if (has('Gemfile') && has('config/database.yml')) commands.push('bundle exec rails db:prepare');
  if (has('artisan')) commands.push('php artisan migrate --force');
  return commands;
}
