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

describe('plannedEnv', () => {
  const FILES: Record<string, string> = {
    'docker-compose.yml': 'services:\n  db:\n    image: postgres:18-alpine\n  queue:\n    image: rabbitmq:3\n',
    '.env.example': 'VITE_AUTH_MODE=test\nAMQP_URL=amqp://queue:5672\n',
    'api/.env.example': 'DATABASE_URL=postgresql://u:p@localhost:5432/x\nAUTH_TEST_IDP_ENABLED=true\nSTRIPE_KEY=\nSMTP_HOST=smtp.x\n',
    'api/.env': 'LEAK=1\n',
  };
  const read = (path: string) => FILES[path] ?? null;

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
