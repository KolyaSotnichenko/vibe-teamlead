import { describe, expect, it } from 'vitest';

import { detectChecks, serviceEnv, serviceImages } from '../detect-checks';

const project = (files: Record<string, string>) => detectChecks({ files: Object.keys(files), read: (path) => files[path] ?? null });
const pkg = (scripts: Record<string, string>, extra: Record<string, unknown> = {}) => JSON.stringify({ scripts, ...extra });
const names = (found: ReturnType<typeof detectChecks>) => found.checks.map((check) => check.command);

describe('detectChecks', () => {
  it('finds nothing to run in a project it does not know', () => {
    expect(project({ 'README.md': 'hi' })).toEqual({ install: [], prepare: [], checks: [] });
  });

  describe('JavaScript and TypeScript', () => {
    it.each([
      ['pnpm-lock.yaml', 'pnpm install --frozen-lockfile', 'pnpm run test'],
      ['package-lock.json', 'npm ci', 'npm run test'],
      ['yarn.lock', 'yarn install --frozen-lockfile', 'yarn run test'],
      ['bun.lock', 'bun install --frozen-lockfile', 'bun run test'],
      ['bun.lockb', 'bun install --frozen-lockfile', 'bun run test'],
    ])('with %s', (lockfile, install, test) => {
      const found = project({ 'package.json': pkg({ test: 'vitest run' }), [lockfile]: '' });
      expect(found.install).toEqual([install]);
      expect(names(found)).toEqual([test]);
    });

    it('takes yarn berry from its config', () => {
      expect(project({ 'package.json': pkg({ test: 'x' }), 'yarn.lock': '', '.yarnrc.yml': '' }).install).toEqual(['yarn install --immutable']);
    });

    it('installs without a lockfile', () => {
      expect(project({ 'package.json': pkg({ test: 'x' }) }).install).toEqual(['npm install']);
    });

    it('runs the typecheck first, then the tests', () => {
      expect(names(project({ 'package.json': pkg({ test: 'x', typecheck: 'tsc' }), 'pnpm-lock.yaml': '' }))).toEqual(['pnpm run typecheck', 'pnpm run test']);
    });

    it("doesn't count npm's placeholder as a test", () => {
      expect(names(project({ 'package.json': pkg({ test: 'echo "Error: no test specified" && exit 1' }) }))).toEqual([]);
    });

    it('survives a broken package.json', () => {
      expect(project({ 'package.json': '{ not json' }).checks).toEqual([]);
    });
  });

  describe('Python', () => {
    it.each([
      [{ 'pyproject.toml': '', 'uv.lock': '' }, 'uv sync --frozen', 'uv run pytest'],
      [{ 'pyproject.toml': '', 'poetry.lock': '' }, 'poetry install --no-interaction', 'poetry run pytest'],
      [{ 'requirements.txt': '' }, 'python3 -m venv .venv && .venv/bin/pip install -r requirements.txt', '.venv/bin/python -m pytest'],
      [{ 'pyproject.toml': '' }, 'python3 -m venv .venv && .venv/bin/pip install -e .', '.venv/bin/python -m pytest'],
    ])('%j', (files, install, test) => {
      const found = project(files as Record<string, string>);
      expect(found.install).toEqual([install]);
      expect(names(found)).toEqual([test]);
    });
  });

  it.each([
    ['Go', { 'go.mod': '' }, [], ['go test ./...']],
    ['Rust', { 'Cargo.toml': '' }, [], ['cargo test']],
    ['Maven', { 'pom.xml': '' }, [], ['mvn -B test']],
    ['the Maven wrapper', { 'pom.xml': '', mvnw: '' }, [], ['./mvnw -B test']],
    ['Gradle', { 'build.gradle': '' }, [], ['gradle test --console=plain']],
    ['Gradle with Kotlin', { 'build.gradle.kts': '' }, [], ['gradle test --console=plain']],
    ['the Gradle wrapper', { 'build.gradle.kts': '', gradlew: '' }, [], ['./gradlew test --console=plain']],
    ['.NET by solution', { 'App.sln': '' }, [], ['dotnet test']],
    ['.NET by project', { 'App.csproj': '' }, [], ['dotnet test']],
    ['F#', { 'App.fsproj': '' }, [], ['dotnet test']],
    ['Swift', { 'Package.swift': '' }, [], ['swift test']],
    ['Ruby with rspec', { Gemfile: '', 'spec/a_spec.rb': '' }, ['bundle install'], ['bundle exec rspec']],
    ['Ruby with minitest', { Gemfile: '' }, ['bundle install'], ['bundle exec rake test']],
    ['PHP with a composer script', { 'composer.json': JSON.stringify({ scripts: { test: 'phpunit' } }) }, ['composer install --no-interaction'], ['composer run-script test']],
    ['PHP with phpunit', { 'composer.json': '{}', 'phpunit.xml.dist': '' }, ['composer install --no-interaction'], ['vendor/bin/phpunit']],
    ['PHP with pest', { 'composer.json': JSON.stringify({ 'require-dev': { 'pestphp/pest': '*' } }) }, ['composer install --no-interaction'], ['vendor/bin/pest']],
  ])('%s', (_name, files, install, checks) => {
    const found = project(files as Record<string, string>);
    expect(found.install).toEqual(install);
    expect(names(found)).toEqual(checks);
  });

  it('runs every stack a project has at its root', () => {
    expect(names(project({ 'package.json': pkg({ test: 'x' }), 'go.mod': '' }))).toEqual(['npm run test', 'go test ./...']);
  });

  it("doesn't look inside folders: nested projects need their own commands", () => {
    expect(project({ 'services/api/go.mod': '' }).checks).toEqual([]);
  });

  it('gives each check a name for the report', () => {
    expect(project({ 'go.mod': '' }).checks[0].name).toBe('go test');
    expect(project({ 'package.json': pkg({ typecheck: 'tsc' }) }).checks[0].name).toBe('typecheck');
  });
});

describe('detectChecks: migrations', () => {
  it('prepares the database with Prisma where its schema lives, after the install', () => {
    const found = project({ 'package.json': pkg({ test: 'x' }), 'pnpm-lock.yaml': '', 'apps/api/prisma/schema.prisma': '' });
    expect(found.prepare).toEqual(['cd apps/api && pnpm exec prisma generate && pnpm exec prisma migrate deploy']);
  });

  it.each([
    ['Drizzle', { 'package.json': pkg({ test: 'x' }), 'pnpm-lock.yaml': '', 'drizzle.config.ts': '' }, 'pnpm exec drizzle-kit migrate'],
    ['Django', { 'requirements.txt': '', 'manage.py': '' }, '.venv/bin/python manage.py migrate'],
    ['Alembic', { 'pyproject.toml': '', 'uv.lock': '', 'alembic.ini': '' }, 'uv run alembic upgrade head'],
    ['Rails', { Gemfile: '', 'config/database.yml': '' }, 'bundle exec rails db:prepare'],
    ['Laravel', { 'composer.json': '{}', artisan: '' }, 'php artisan migrate --force'],
  ])('%s', (_name, files, command) => {
    expect(project(files as Record<string, string>).prepare).toEqual([command]);
  });

  it('no prepare step without a migration tool', () => {
    expect(project({ 'go.mod': '' }).prepare).toEqual([]);
  });
});

describe('serviceImages', () => {
  it('takes the images of what a test database needs from the compose file', () => {
    const compose = 'services:\n  postgres:\n    image: postgres:18-alpine\n  cache:\n    image: "redis:7"\n  api:\n    image: node:24-alpine\n';
    expect(serviceImages(compose)).toEqual([{ kind: 'postgres', image: 'postgres:18-alpine' }, { kind: 'redis', image: 'redis:7' }]);
  });

  it.each([
    ['pgvector/pgvector:pg16', 'postgres'],
    ['postgis/postgis:16-3.4', 'postgres'],
    ['mysql:8', 'mysql'],
    ['mariadb:11', 'mysql'],
    ['valkey/valkey:8', 'redis'],
    ['mongo:7', 'mongo'],
  ])('%s is %s', (image, kind) => {
    expect(serviceImages(`services:\n  db:\n    image: ${image}\n`)).toEqual([{ kind, image }]);
  });

  it('runs one of each kind', () => {
    expect(serviceImages('a:\n  image: postgres:16\nb:\n  image: postgres:15\n')).toEqual([{ kind: 'postgres', image: 'postgres:16' }]);
  });

  it("takes nothing that isn't a plain image name: this reaches a command line", () => {
    expect(serviceImages('db:\n  image: postgres:16; rm -rf /\n')).toEqual([]);
    expect(serviceImages('db:\n  image: --privileged\n')).toEqual([]);
    expect(serviceImages('db:\n  image: ${DB_IMAGE}\n')).toEqual([]);
  });

  it('nothing from a file without services', () => {
    expect(serviceImages('')).toEqual([]);
  });
});

describe('serviceEnv', () => {
  const started = [{ kind: 'postgres' as const, url: 'postgresql://verify:pw@127.0.0.1:50000/verify' }, { kind: 'redis' as const, url: 'redis://127.0.0.1:50001' }];

  it('points the standard names at what it started', () => {
    expect(serviceEnv('', started)).toMatchObject({ DATABASE_URL: started[0].url, POSTGRES_URL: started[0].url, REDIS_URL: started[1].url });
  });

  it("gives the project's own example values, so tests find the settings they need", () => {
    expect(serviceEnv('# comment\nCSRF_SECRET=abc\nPORT="3001"\nEMPTY=\n', [])).toEqual({ CSRF_SECRET: 'abc', PORT: '3001', EMPTY: '' });
  });

  it('a variable with a database address gets the temporary one, whatever its name', () => {
    expect(serviceEnv('PRIMARY_DB=postgres://u:p@localhost/x\nCACHE=redis://localhost\nOTHER=https://example.com\n', started)).toMatchObject({
      PRIMARY_DB: started[0].url,
      CACHE: started[1].url,
      OTHER: 'https://example.com',
    });
  });

  it('splits the address for tools that read host, port and name separately, over what the example says', () => {
    expect(serviceEnv('DB_HOST=prod.example.com\nDB_PASSWORD=real\n', started)).toMatchObject({
      DB_HOST: '127.0.0.1', DB_PORT: '50000', DB_USERNAME: 'verify', DB_USER: 'verify', DB_PASSWORD: 'pw', DB_DATABASE: 'verify', DB_NAME: 'verify',
    });
  });

  it('leaves out connection settings with no database started: they could reach a real one', () => {
    expect(serviceEnv('DB_HOST=127.0.0.1\nDB_PORT=5432\nDB_PASSWORD=x\nPGHOST=localhost\nMYSQL_HOST=db\nAPP_NAME=keep\n', [])).toEqual({ APP_NAME: 'keep' });
  });

  it.each([
    ['jdbc:postgresql://prod/x'],
    ['postgres+asyncpg://prod/x'],
    ['amqp://prod'],
    ['clickhouse://prod'],
    ['postgres://prod/x # the main one'],
  ])('keeps out an address in another form: %s', (value) => {
    expect(serviceEnv(`CONN=${value}\n`, [])).toEqual({});
  });

  it('a database address in another form gets the temporary one', () => {
    expect(serviceEnv('CONN=postgres+asyncpg://prod/x\n', started).CONN).toBe(started[0].url);
  });

  it('keeps web addresses: they are settings, not databases', () => {
    expect(serviceEnv('API=http://localhost:3001\nSITE=https://example.com\n', [])).toEqual({ API: 'http://localhost:3001', SITE: 'https://example.com' });
  });

  it('an example address for a service it did not start stays out: it would point at nothing, or at something real', () => {
    expect(serviceEnv('DATABASE_URL=postgres://localhost/x\n', [])).toEqual({});
  });
});
