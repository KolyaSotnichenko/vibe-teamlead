import { describe, expect, it } from 'vitest';

import { composeServices } from '../../ai/verification/compose-services';
import { baseEnvVars, envOf, plannedEnv, serviceEnvVars } from '../preview-env';

const PG = [{ kind: 'postgres' as const, url: 'postgresql://verify:pw@127.0.0.1:55001/verify' }];
const byName = (vars: ReturnType<typeof baseEnvVars>) => Object.fromEntries(vars.map((v) => [v.name, v]));

describe('baseEnvVars', () => {
  it('names where each value came from: root example, folder example, database, empty on purpose', () => {
    const vars = byName(baseEnvVars({
      dir: 'apps/api',
      rootExample: 'APP_NAME=acme\nVITE_AUTH_MODE=prod\n',
      dirExample: 'VITE_AUTH_MODE=test\nDATABASE_URL=postgresql://u:p@localhost:5432/x\nREDIS_URL=redis://localhost:6379\n',
      started: PG,
    }));
    expect(vars.APP_NAME).toMatchObject({ value: 'acme', source: 'example' });
    expect(vars.VITE_AUTH_MODE).toMatchObject({ value: 'test', source: 'exampleDir' });
    expect(vars.DATABASE_URL).toMatchObject({ value: PG[0].url, source: 'database' });
    expect(vars.DB_PASSWORD).toMatchObject({ value: 'pw', source: 'database' });
    expect(vars.REDIS_URL).toMatchObject({ value: '', source: 'blocked' });
  });

  it('marks what only the root example names as shared, for a service in a folder; never at the root itself', () => {
    const input = {
      rootExample: 'APP_NAME=acme\nVITE_AUTH_MODE=prod\nDATABASE_URL=postgresql://u:p@localhost:5432/x\nREDIS_URL=redis://localhost:6379\n',
      started: PG,
    };
    const vars = byName(baseEnvVars({ ...input, dir: 'apps/web', dirExample: 'VITE_AUTH_MODE=test\nVITE_X=1\n', overrides: { APP_NAME: 'mine' } }));
    expect(vars.APP_NAME.shared).toBeUndefined();
    expect(vars.DATABASE_URL).toMatchObject({ source: 'database', shared: true });
    expect(vars.REDIS_URL).toMatchObject({ source: 'blocked', shared: true });
    expect(vars.VITE_AUTH_MODE.shared).toBeUndefined();
    expect(vars.VITE_X.shared).toBeUndefined();
    const plain = byName(baseEnvVars({ ...input, dir: 'apps/web', dirExample: '' }));
    expect(plain.APP_NAME).toMatchObject({ source: 'example', shared: true });
    const atRoot = baseEnvVars({ ...input, dir: '', dirExample: null });
    expect(atRoot.some((v) => v.shared)).toBe(false);
  });

  it('points SMTP at the mail catcher, and the owner wins over everything with the automatic value kept', () => {
    const vars = byName(baseEnvVars({
      dir: '',
      rootExample: 'SMTP_HOST=smtp.sendgrid.net\nSMTP_PORT=587\nREDIS_URL=redis://localhost:6379\n',
      dirExample: null,
      started: [],
      mailPort: 41025,
      overrides: { REDIS_URL: 'redis://real', EXTRA: '1' },
    }));
    expect(vars.SMTP_HOST).toMatchObject({ value: '127.0.0.1', source: 'mail' });
    expect(vars.SMTP_PORT).toMatchObject({ value: '41025', source: 'mail' });
    expect(vars.REDIS_URL).toMatchObject({ value: 'redis://real', source: 'override', automatic: { value: '', source: 'blocked' } });
    expect(vars.EXTRA).toMatchObject({ value: '1', source: 'override' });
    expect(vars.EXTRA.automatic).toBeUndefined();
  });

  it("before the preview starts, the database's and the mail catcher's values are pending and empty", () => {
    const vars = byName(baseEnvVars({ dir: '', rootExample: 'DATABASE_URL=postgresql://x@localhost/x\nSMTP_HOST=h\n', dirExample: null, started: PG, mailPort: 1, pending: true }));
    expect(vars.DATABASE_URL).toMatchObject({ value: '', source: 'database', pending: true });
    expect(vars.SMTP_HOST).toMatchObject({ value: '', source: 'mail', pending: true });
  });

  it('names the compose service a value comes from, and empties what points at one that did not start', () => {
    const planned = composeServices(['services:\n  rabbitmq:\n    image: rabbitmq:3\n  minio:\n    image: minio/minio\n    ports: ["9000:9000"]\n']);
    const vars = byName(baseEnvVars({
      dir: '',
      rootExample: 'AMQP_URL=amqp://rabbitmq:5672\nS3_ENDPOINT=http://localhost:9000\n',
      dirExample: null,
      started: [],
      compose: { planned, started: [{ name: 'rabbitmq', kind: 'rabbitmq', image: 'rabbitmq:3', ports: { 5672: 50001 }, env: {} }] },
    }));
    expect(vars.AMQP_URL).toEqual({ name: 'AMQP_URL', value: 'amqp://127.0.0.1:50001', source: 'service', service: 'rabbitmq' });
    expect(vars.S3_ENDPOINT).toEqual({ name: 'S3_ENDPOINT', value: '', source: 'blocked', service: 'minio' });
  });

  it("before the start, a compose service's values are pending", () => {
    const planned = composeServices(['services:\n  rabbitmq:\n    image: rabbitmq:3\n']);
    const vars = byName(baseEnvVars({ dir: '', rootExample: 'AMQP_URL=amqp://rabbitmq\n', dirExample: null, started: [], compose: { planned, started: [] }, pending: true }));
    expect(vars.AMQP_URL).toEqual({ name: 'AMQP_URL', value: '', source: 'service', service: 'rabbitmq', pending: true });
  });

  it('gives the same values the preview always gave (example + database + mail + previewEnv)', () => {
    const env = envOf(baseEnvVars({ dir: 'a', rootExample: 'A=1\nDATABASE_URL=postgres://h/x\n', dirExample: 'A=2\nB=\n', started: PG, overrides: { C: '3' } }));
    expect(env).toMatchObject({ A: '2', B: '', C: '3', DATABASE_URL: PG[0].url });
  });
});

describe('serviceEnvVars', () => {
  const base = baseEnvVars({ dir: 'web', rootExample: null, dirExample: 'API=http://localhost:3001/v1\nSITE=x\nKEY=a\n', started: [] });

  it("points local example addresses and urlEnv at the preview's services, then the owner's per-service values, then the port", () => {
    const vars = byName(serviceEnvVars(base, {
      byExamplePort: new Map([[3001, 'http://localhost:5002']]),
      urlEnv: { API_ORIGIN: 'api' },
      urls: { api: 'http://localhost:5002' },
      serviceOverrides: { SITE: 'mine' },
      portEnv: 'PORT',
      port: 5001,
    }));
    expect(vars.API).toMatchObject({ value: 'http://localhost:5002/v1', source: 'address' });
    expect(vars.API_ORIGIN).toMatchObject({ value: 'http://localhost:5002', source: 'address' });
    expect(vars.SITE).toMatchObject({ value: 'mine', source: 'serviceOverride', automatic: { value: 'x', source: 'exampleDir' } });
    expect(vars.KEY).toMatchObject({ value: 'a', source: 'exampleDir' });
    expect(vars.PORT).toMatchObject({ value: '5001', source: 'port' });
  });

  it('before the start, addresses and the port are pending', () => {
    const vars = byName(serviceEnvVars(base, { byExamplePort: new Map([[3001, 'x']]), urlEnv: { API_ORIGIN: 'api' }, urls: { api: 'x' }, portEnv: 'PORT', pending: true }));
    expect(vars.API).toMatchObject({ value: '', source: 'address', pending: true });
    expect(vars.API_ORIGIN).toMatchObject({ pending: true });
    expect(vars.PORT).toMatchObject({ value: '', source: 'port', pending: true });
  });
});

describe("a recipe's values", () => {
  it("a recipe value replaces an example value and adds a new one, marked as the recipe's", () => {
    const vars = baseEnvVars({ dir: '', rootExample: 'AUTH_MODE=sso\n', dirExample: null, started: [], recipe: { AUTH_MODE: 'dev', FEATURE_X: 'on' } });
    expect(vars).toContainEqual({ name: 'AUTH_MODE', value: 'dev', source: 'recipe', automatic: { value: 'sso', source: 'example' } });
    expect(vars).toContainEqual({ name: 'FEATURE_X', value: 'on', source: 'recipe' });
  });

  it("a recipe value never replaces the preview's database address, a setting left empty on purpose, or the owner's value", () => {
    const vars = byName(baseEnvVars({
      dir: '', rootExample: 'DATABASE_URL=postgresql://u:p@localhost:5432/x\nREDIS_URL=redis://localhost:6379\nMODE=a\n', dirExample: null, started: PG,
      recipe: { DATABASE_URL: 'postgresql://real/prod', REDIS_URL: 'redis://real:6379', MODE: 'b' }, overrides: { MODE: 'mine' },
    }));
    expect(vars.DATABASE_URL).toMatchObject({ value: 'postgresql://verify:pw@127.0.0.1:55001/verify', source: 'database' });
    expect(vars.REDIS_URL).toMatchObject({ value: '', source: 'blocked' });
    expect(vars.MODE).toMatchObject({ value: 'mine', source: 'override' });
  });

  it("points a local address in a service's own recipe values at the preview's port, as it does for the shared ones", () => {
    const byExamplePort = new Map([[3001, 'http://localhost:4101']]);
    const base = baseEnvVars({ dir: 'apps/web', rootExample: null, dirExample: null, started: [], recipe: { SHARED_API: 'http://localhost:3001/v1' } });
    const vars = byName(serviceEnvVars(base, { byExamplePort, urls: {}, portEnv: 'PORT', port: 4102, recipe: { OWN_API: 'http://localhost:3001/v1', ELSEWHERE: 'https://example.com' } }));
    expect(vars.SHARED_API.value).toBe('http://localhost:4101/v1');
    expect(vars.OWN_API).toMatchObject({ value: 'http://localhost:4101/v1', source: 'recipe' });
    expect(vars.ELSEWHERE.value).toBe('https://example.com');
  });

  it("a recipe value never replaces a part of the preview's database address, even where the example has the same value", () => {
    const vars = byName(baseEnvVars({ dir: '', rootExample: 'DB_HOST=127.0.0.1\nDB_PORT=5432\nDB_NAME=app\n', dirExample: null, started: PG, recipe: { DB_HOST: 'db.internal', DB_PORT: '6543' } }));
    expect(vars.DB_HOST).toMatchObject({ value: '127.0.0.1', source: 'database' });
    expect(vars.DB_PORT).toMatchObject({ value: '55001', source: 'database' });
  });

  it("a service's own recipe value wins over the recipe's shared one, and loses to another service's address and to the owner", () => {
    const base = baseEnvVars({ dir: 'apps/web', rootExample: null, dirExample: 'API_URL=http://localhost:3001\nMODE=a\nTHEME=x\n', started: [], recipe: { MODE: 'shared' } });
    const vars = byName(serviceEnvVars(base, {
      byExamplePort: new Map([[3001, 'http://localhost:4101']]), urls: {}, portEnv: 'PORT', port: 4102,
      recipe: { MODE: 'own', API_URL: 'http://elsewhere', THEME: 'y' }, serviceOverrides: { THEME: 'mine' },
    }));
    expect(vars.MODE).toMatchObject({ value: 'own', source: 'recipe' });
    expect(vars.API_URL).toMatchObject({ value: 'http://localhost:4101', source: 'address' });
    expect(vars.THEME).toMatchObject({ value: 'mine', source: 'serviceOverride' });
  });
});

describe('plannedEnv', () => {
  const FILES: Record<string, string> = {
    'docker-compose.yml': 'services:\n  db:\n    image: postgres:18-alpine\n  queue:\n    image: rabbitmq:3\n',
    '.env.example': 'VITE_AUTH_MODE=test\nAMQP_URL=amqp://queue:5672\n',
    'api/.env.example': 'DATABASE_URL=postgresql://u:p@localhost:5432/x\nAUTH_TEST_IDP_ENABLED=true\nSTRIPE_KEY=\nSMTP_HOST=smtp.x\n',
    'api/.env': 'LEAK=1\n',
  };
  const read = (path: string) => FILES[path] ?? null;

  it("plans from the project's preview.json when it has one: its services and its values", () => {
    const recipe = { version: 1, kind: 'web', env: { FEATURE_Y: 'on' }, services: [{ name: 'site', dir: '', command: 'make serve', page: true, env: { ONLY_SITE: '1' } }] };
    const planned = plannedEnv({ previewServices: [] }, ['preview.json'], (path) => (path === 'preview.json' ? JSON.stringify(recipe) : null));
    expect(planned.services.map((s) => s.service)).toEqual(['site']);
    const vars = byName(planned.services[0].vars);
    expect(vars.FEATURE_Y).toMatchObject({ value: 'on', source: 'recipe' });
    expect(vars.ONLY_SITE).toMatchObject({ value: '1', source: 'recipe' });
  });

  it('lists what each service will get before the start, without ever reading .env', () => {
    const seen: string[] = [];
    const planned = plannedEnv(
      { previewServices: [{ name: 'web', dir: '', command: 'x', page: true }, { name: 'api', dir: 'api', command: 'y' }], previewServiceEnv: { api: { STRIPE_KEY: 'sk_test' } } },
      Object.keys(FILES),
      (path) => { seen.push(path); return read(path); },
    );
    expect(planned.databases).toEqual(['postgres']);
    expect(planned.composeServices).toEqual(['queue']);
    expect(byName(planned.services[0].vars).AMQP_URL).toMatchObject({ value: '', source: 'service', service: 'queue', pending: true });
    expect(planned.mail).toBe(true);
    const api = byName(planned.services.find((s) => s.service === 'api')!.vars);
    expect(api.VITE_AUTH_MODE).toMatchObject({ value: 'test', source: 'example' });
    expect(api.AUTH_TEST_IDP_ENABLED).toMatchObject({ value: 'true', source: 'exampleDir' });
    expect(api.DATABASE_URL).toMatchObject({ source: 'database', pending: true });
    expect(api.STRIPE_KEY).toMatchObject({ value: 'sk_test', source: 'serviceOverride', automatic: { value: '', source: 'exampleDir' } });
    expect(seen.some((p) => /\.env$/.test(p))).toBe(false);
  });
});
