import { describe, expect, it } from 'vitest';

import { detectChecks } from '../detect-checks';

const project = (files: Record<string, string>) => detectChecks({ files: Object.keys(files), read: (path) => files[path] ?? null });
const pkg = (scripts: Record<string, string>, extra: Record<string, unknown> = {}) => JSON.stringify({ scripts, ...extra });
const names = (found: ReturnType<typeof detectChecks>) => found.checks.map((check) => check.command);

describe('detectChecks', () => {
  it('finds nothing to run in a project it does not know', () => {
    expect(project({ 'README.md': 'hi' })).toEqual({ install: [], checks: [] });
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
