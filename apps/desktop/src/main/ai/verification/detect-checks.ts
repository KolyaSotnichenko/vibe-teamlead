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
  /** Migrations: run after the install, and only against a temporary database the app started */
  prepare?: string[];
  checks: Check[];
}

export interface ServiceImage {
  kind: 'postgres' | 'mysql' | 'redis' | 'mongo';
  image: string;
}

export interface StartedService {
  kind: ServiceImage['kind'];
  url: string;
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
  const found: DetectedChecks = { install: [], prepare: [], checks: [] };
  const prepare = found.prepare as string[];
  const nodeManager = has('pnpm-lock.yaml') ? 'pnpm exec' : has('yarn.lock') ? 'yarn' : has('bun.lock') || has('bun.lockb') ? 'bunx' : 'npx';
  const pythonPrefix = has('uv.lock') ? 'uv run ' : has('poetry.lock') ? 'poetry run ' : '.venv/bin/';
  const inFolder = (folder: string, command: string) => (folder ? `cd ${/^[\w./-]+$/.test(folder) ? folder : `'${folder.replace(/'/g, `'\\''`)}'`} && ${command}` : command);

  const prismaSchema = files.find((file) => /(^|\/)prisma\/schema\.prisma$/.test(file));
  if (prismaSchema) {
    prepare.push(inFolder(prismaSchema.replace(/\/?prisma\/schema\.prisma$/, ''), `${nodeManager} prisma generate && ${nodeManager} prisma migrate deploy`));
  }
  if (atRoot(/^drizzle\.config\.[cm]?[jt]s$/)) prepare.push(`${nodeManager} drizzle-kit migrate`);
  if (has('manage.py')) prepare.push(`${pythonPrefix === '.venv/bin/' ? '.venv/bin/python' : `${pythonPrefix}python`} manage.py migrate`);
  if (has('alembic.ini')) prepare.push(`${pythonPrefix}alembic upgrade head`);
  if (has('Gemfile') && has('config/database.yml')) prepare.push('bundle exec rails db:prepare');
  if (has('artisan')) prepare.push('php artisan migrate --force');

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

const SAFE_IMAGE = /^[A-Za-z0-9][\w./:@-]*$/;
const KINDS: [RegExp, ServiceImage['kind']][] = [
  [/postgres|pgvector|postgis|timescale/, 'postgres'],
  [/mysql|mariadb/, 'mysql'],
  [/redis|valkey/, 'redis'],
  [/mongo/, 'mongo'],
];

/** The databases a compose file asks for, by image. Only plain names: this reaches a command line. Pure. */
export function serviceImages(compose: string): ServiceImage[] {
  const found = new Map<ServiceImage['kind'], string>();
  for (const line of compose.split('\n')) {
    const image = /^\s*image:\s*["']?([^"'\s#]+)["']?\s*(#.*)?$/.exec(line)?.[1];
    if (!image || !SAFE_IMAGE.test(image)) continue;
    const kind = KINDS.find(([pattern]) => pattern.test(image))?.[1];
    if (kind && !found.has(kind)) found.set(kind, image);
  }
  return [...found].map(([kind, image]) => ({ kind, image }));
}

const STANDARD_NAMES: Record<ServiceImage['kind'], string[]> = {
  postgres: ['DATABASE_URL', 'POSTGRES_URL'],
  mysql: ['DATABASE_URL', 'MYSQL_URL'],
  redis: ['REDIS_URL'],
  mongo: ['MONGODB_URI', 'MONGO_URL'],
};
const SCHEME_KINDS: Record<string, ServiceImage['kind']> = {
  postgres: 'postgres', postgresql: 'postgres',
  mysql: 'mysql', mariadb: 'mysql',
  redis: 'redis', rediss: 'redis',
  mongodb: 'mongo',
};
/** Settings that say where a database is, without being an address */
const CONNECTION_SETTING = /^(DB|DATABASE|PG|POSTGRES|POSTGRESQL|MYSQL|MARIADB|MONGO|MONGODB|REDIS)_?(HOST|HOSTNAME|PORT|USER|USERNAME|PASS|PASSWORD|NAME|DATABASE|DB|URL|URI|SOCKET)$/i;

/** host, port, user, password and name, for tools that read them apart */
function splitConnection(url: string): [string, string][] {
  const { hostname, port, username, password, pathname } = new URL(url);
  const name = pathname.slice(1);
  return [
    ['DB_HOST', hostname], ['DB_PORT', port],
    ['DB_USER', username], ['DB_USERNAME', username], ['DB_PASSWORD', password],
    ['DB_NAME', name], ['DB_DATABASE', name],
  ];
}

/**
 * The variables the checks get: the project's example file, with database addresses
 * pointing at what was started. Anything else that says where a database or a broker
 * is stays out: it would point at nothing, or at something real. Pure.
 */
export function serviceEnv(example: string, started: StartedService[]): Record<string, string> {
  const urlOf = (kind: ServiceImage['kind']) => started.find((service) => service.kind === kind)?.url;
  const entries: [string, string][] = [];
  for (const line of example.split('\n')) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (!match) continue;
    const value = match[2].replace(/\s+#.*$/, '').trim().replace(/^(["'])(.*)\1$/, '$2');
    const scheme = /^(?:jdbc:)?([a-z][a-z0-9.-]*)(?:\+[a-z0-9.+-]*)?:\/\//i.exec(value)?.[1]?.toLowerCase();
    if (scheme && scheme !== 'http' && scheme !== 'https') {
      const url = SCHEME_KINDS[scheme] ? urlOf(SCHEME_KINDS[scheme]) : undefined;
      if (url) entries.push([match[1], url]);
    } else if (!CONNECTION_SETTING.test(match[1])) {
      entries.push([match[1], value]);
    }
  }
  for (const service of started) for (const name of STANDARD_NAMES[service.kind]) entries.push([name, service.url]);
  const database = started.find((service) => service.kind === 'postgres' || service.kind === 'mysql' || service.kind === 'mongo');
  if (database) entries.push(...splitConnection(database.url));
  return Object.fromEntries(entries);
}
