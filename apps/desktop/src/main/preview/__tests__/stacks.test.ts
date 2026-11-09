import { describe, expect, it } from 'vitest';

import { frameworkMigrations, migratesOnLocalFile, proposeStackServices, stackInstalls } from '../stacks';

const project = (files: Record<string, string>) => ({ files: Object.keys(files), read: (p: string) => files[p] ?? null });

describe('proposeStackServices', () => {
  it('Django: runserver on the port, through the project runner, and it is a page', () => {
    expect(proposeStackServices(project({ 'manage.py': '', 'uv.lock': '', 'pyproject.toml': 'dependencies = ["django"]' }))).toEqual([
      { name: 'web', dir: '', command: 'uv run python manage.py runserver 127.0.0.1:{port}', page: true },
    ]);
    expect(proposeStackServices(project({ 'backend/manage.py': '', 'backend/requirements.txt': 'Django==5' }))).toEqual([
      { name: 'backend', dir: 'backend', command: '.venv/bin/python manage.py runserver 127.0.0.1:{port}', page: true },
    ]);
  });

  it('FastAPI: uvicorn with the module and the variable that hold the app', () => {
    const services = proposeStackServices(
      project({ 'api/pyproject.toml': 'dependencies = ["fastapi", "uvicorn"]', 'api/poetry.lock': '', 'api/app/main.py': 'from fastapi import FastAPI\napplication = FastAPI()\n' }),
    );
    expect(services).toEqual([{ name: 'api', dir: 'api', command: 'poetry run uvicorn app.main:application --reload --host 127.0.0.1 --port {port}', page: true }]);
  });

  it('Flask, Rails and Laravel', () => {
    expect(proposeStackServices(project({ 'requirements.txt': 'flask', 'app.py': 'app = Flask(__name__)' }))[0].command).toBe('.venv/bin/flask run --host 127.0.0.1 --port {port}');
    expect(proposeStackServices(project({ Gemfile: "gem 'rails', '~> 8.0'", 'bin/rails': '' }))[0].command).toBe('bin/rails server -b 127.0.0.1 -p {port}');
    expect(proposeStackServices(project({ artisan: '', 'composer.json': '{}' }))[0].command).toBe('php artisan serve --host=127.0.0.1 --port={port}');
  });

  it('Go: runs the main package, at the root or the first under cmd/', () => {
    expect(proposeStackServices(project({ 'go.mod': 'module x', 'main.go': 'package main' }))[0].command).toBe('go run .');
    expect(proposeStackServices(project({ 'go.mod': 'module x', 'cmd/server/main.go': 'package main', 'cmd/worker/main.go': 'package main' }))[0]).toMatchObject({ name: 'server', command: 'go run ./cmd/server' });
  });

  it('proposes nothing for a library, vendored code or tests', () => {
    expect(proposeStackServices(project({ 'pyproject.toml': 'dependencies = ["requests"]', 'src/lib.py': '' }))).toEqual([]);
    expect(proposeStackServices(project({ 'vendor/x/artisan': '', 'node_modules/y/manage.py': '' }))).toEqual([]);
  });
});

describe('stackInstalls', () => {
  it('installs each folder with its own tool, and names the files that say when to do it again', () => {
    expect(
      stackInstalls(project({ 'uv.lock': '', 'pyproject.toml': '', 'api/Gemfile': '', 'api/Gemfile.lock': '', 'site/composer.json': '{}', 'svc/go.mod': '', 'svc/go.sum': '' }), ['', 'api', 'site', 'svc']),
    ).toEqual([
      { dir: '', command: 'uv sync', lockfiles: ['uv.lock', 'pyproject.toml'] },
      { dir: 'api', command: 'bundle install', lockfiles: ['api/Gemfile.lock', 'api/Gemfile'] },
      { dir: 'site', command: 'composer install --no-interaction', lockfiles: ['site/composer.json'] },
      { dir: 'svc', command: 'go mod download', lockfiles: ['svc/go.sum', 'svc/go.mod'] },
    ]);
    expect(stackInstalls(project({ 'requirements.txt': '' }), [''])[0].command).toBe('python3 -m venv .venv && .venv/bin/pip install -r requirements.txt');
    expect(stackInstalls(project({ 'poetry.lock': '', 'pyproject.toml': '' }), [''])[0].command).toBe('poetry install --no-interaction');
  });
});

describe('frameworkMigrations', () => {
  it("finds each framework's migrations in a folder", () => {
    expect(frameworkMigrations(project({ 'backend/manage.py': '', 'backend/requirements.txt': '' }), 'backend')).toEqual(['.venv/bin/python manage.py migrate']);
    expect(frameworkMigrations(project({ 'alembic.ini': '', 'uv.lock': '' }), '')).toEqual(['uv run alembic upgrade head']);
    expect(frameworkMigrations(project({ 'svc/alembic.ini': '', 'svc/poetry.lock': '' }), 'svc')).toEqual(['poetry run alembic upgrade head']);
    expect(frameworkMigrations(project({ Gemfile: '', 'config/database.yml': '' }), '')).toEqual(['bundle exec rails db:prepare']);
    expect(frameworkMigrations(project({ artisan: '' }), '')).toEqual(['php artisan migrate --force']);
    expect(frameworkMigrations(project({ 'package.json': '{}' }), '')).toEqual([]);
  });
});

describe('names from the repository never reach a shell unchecked', () => {
  it('skips a cmd/ folder or a FastAPI module whose name is not a plain identifier', () => {
    expect(proposeStackServices(project({ 'go.mod': '', 'cmd/x;rm -rf ~/main.go': 'package main' }))).toEqual([]);
    expect(proposeStackServices(project({ 'go.mod': '', 'cmd/$(id)/main.go': '', 'cmd/server/main.go': '' }))[0].command).toBe('go run ./cmd/server');
    expect(
      proposeStackServices(project({ 'requirements.txt': 'fastapi', 'a b;c/main.py': 'app = FastAPI()' })),
    ).toEqual([]);
  });
});

describe('migratesOnLocalFile: without a database in compose, migrations run only on a local file', () => {
  it('Django with sqlite3, Rails with sqlite3, Laravel with sqlite, Alembic with a sqlite URL', () => {
    expect(migratesOnLocalFile(project({ 'mysite/settings.py': "'ENGINE': 'django.db.backends.sqlite3'" }), '', '.venv/bin/python manage.py migrate')).toBe(true);
    expect(migratesOnLocalFile(project({ 'config/database.yml': 'development:\n  adapter: sqlite3\n' }), '', 'bundle exec rails db:prepare')).toBe(true);
    expect(migratesOnLocalFile(project({ '.env.example': 'DB_CONNECTION=sqlite\n' }), '', 'php artisan migrate --force')).toBe(true);
    expect(migratesOnLocalFile(project({ 'alembic.ini': 'sqlalchemy.url = sqlite:///app.db' }), '', 'uv run alembic upgrade head')).toBe(true);
  });

  it('not when the config names a server database, or anything else', () => {
    expect(migratesOnLocalFile(project({ 'mysite/settings.py': "'ENGINE': 'django.db.backends.postgresql'" }), '', '.venv/bin/python manage.py migrate')).toBe(false);
    expect(migratesOnLocalFile(project({ 'mysite/settings.py': "'ENGINE': 'django.db.backends.sqlite3'\nOTHER = {'ENGINE': 'django.db.backends.postgresql'}" }), '', '.venv/bin/python manage.py migrate')).toBe(false);
    expect(migratesOnLocalFile(project({ 'config/database.yml': 'development:\n  adapter: postgresql\n  host: db.prod.example.com' }), '', 'bundle exec rails db:prepare')).toBe(false);
    expect(migratesOnLocalFile(project({ '.env.example': 'DB_CONNECTION=mysql\n' }), '', 'php artisan migrate --force')).toBe(false);
    expect(migratesOnLocalFile(project({}), '', 'something else')).toBe(false);
  });
});
