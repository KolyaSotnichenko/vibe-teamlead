/**
 * What to run to check a project, from the files at its root: the install and the
 * typecheck and tests its own stack uses. Nothing here is run. Nested projects, and
 * stacks with no standard command, take commands from the project's settings. Pure.
 */

export interface Check {
  name: string;
  command: string;
}

export interface DetectedChecks {
  /** Run in order before any check */
  install: string[];
  checks: Check[];
}

export interface ProjectFiles {
  /** Paths from the root, with `/` */
  files: string[];
  read: (path: string) => string | null;
}

const NO_TESTS_PLACEHOLDER = /no test specified/i;

function json(text: string | null): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(text ?? '');
    return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

const record = (value: unknown): Record<string, unknown> => (value && typeof value === 'object' ? (value as Record<string, unknown>) : {});

export function detectChecks({ files, read }: ProjectFiles): DetectedChecks {
  const has = (path: string) => files.includes(path);
  const atRoot = (pattern: RegExp) => files.some((file) => !file.includes('/') && pattern.test(file));
  const found: DetectedChecks = { install: [], checks: [] };

  if (has('package.json')) {
    const scripts = record(json(read('package.json')).scripts);
    const manager = has('pnpm-lock.yaml') ? 'pnpm' : has('yarn.lock') ? 'yarn' : has('bun.lock') || has('bun.lockb') ? 'bun' : 'npm';
    const install = {
      pnpm: 'pnpm install --frozen-lockfile',
      yarn: has('.yarnrc.yml') ? 'yarn install --immutable' : 'yarn install --frozen-lockfile',
      bun: 'bun install --frozen-lockfile',
      npm: has('package-lock.json') ? 'npm ci' : 'npm install',
    }[manager];
    const typecheck = typeof scripts.typecheck === 'string';
    const test = typeof scripts.test === 'string' && !NO_TESTS_PLACEHOLDER.test(scripts.test);
    if (typecheck || test) found.install.push(install);
    if (typecheck) found.checks.push({ name: 'typecheck', command: `${manager} run typecheck` });
    if (test) found.checks.push({ name: 'test', command: `${manager} run test` });
  }

  if (has('pyproject.toml') || has('requirements.txt')) {
    if (has('uv.lock')) {
      found.install.push('uv sync --frozen');
      found.checks.push({ name: 'pytest', command: 'uv run pytest' });
    } else if (has('poetry.lock')) {
      found.install.push('poetry install --no-interaction');
      found.checks.push({ name: 'pytest', command: 'poetry run pytest' });
    } else {
      found.install.push(`python3 -m venv .venv && .venv/bin/pip install ${has('requirements.txt') ? '-r requirements.txt' : '-e .'}`);
      found.checks.push({ name: 'pytest', command: '.venv/bin/python -m pytest' });
    }
  }

  if (has('go.mod')) found.checks.push({ name: 'go test', command: 'go test ./...' });
  if (has('Cargo.toml')) found.checks.push({ name: 'cargo test', command: 'cargo test' });
  if (has('pom.xml')) found.checks.push({ name: 'maven test', command: `${has('mvnw') ? './mvnw' : 'mvn'} -B test` });
  if (has('build.gradle') || has('build.gradle.kts')) found.checks.push({ name: 'gradle test', command: `${has('gradlew') ? './gradlew' : 'gradle'} test --console=plain` });
  if (atRoot(/\.(sln|slnx|csproj|fsproj|vbproj)$/)) found.checks.push({ name: 'dotnet test', command: 'dotnet test' });
  if (has('Package.swift')) found.checks.push({ name: 'swift test', command: 'swift test' });

  if (has('Gemfile')) {
    found.install.push('bundle install');
    const rspec = files.some((file) => file.startsWith('spec/'));
    found.checks.push(rspec ? { name: 'rspec', command: 'bundle exec rspec' } : { name: 'rake test', command: 'bundle exec rake test' });
  }

  if (has('composer.json')) {
    const composer = json(read('composer.json'));
    const pest = Object.hasOwn(record(composer['require-dev']), 'pestphp/pest');
    const command = typeof record(composer.scripts).test === 'string'
      ? 'composer run-script test'
      : pest ? 'vendor/bin/pest'
        : has('phpunit.xml') || has('phpunit.xml.dist') ? 'vendor/bin/phpunit' : undefined;
    if (command) {
      found.install.push('composer install --no-interaction');
      found.checks.push({ name: 'php test', command });
    }
  }

  return found;
}
