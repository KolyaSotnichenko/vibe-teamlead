import { describe, expect, it } from 'vitest';

import type { PreviewEnvReport, PreviewEnvVar } from '../../../../shared/types';
import { featureOf, isEmptyVar, isSecretVar, sortVars, summarizeEnv } from '../env-summary';

const v = (name: string, value = '', extra: Partial<PreviewEnvVar> = {}): PreviewEnvVar => ({ name, value, source: 'exampleDir', ...extra });

describe('isSecretVar', () => {
  it.each([
    ['JWT_SECRET', 'x'], ['STRIPE_API_KEY', 'x'], ['GITHUB_TOKEN', 'x'], ['DB_PASSWORD', 'x'], ['PRIVATE_KEY_PEM', 'x'], ['SECRET', 'x'],
    ['DATABASE_URL', 'postgresql://verify:pw@127.0.0.1:5/x'],
  ])('masks %s', (name, value) => expect(isSecretVar(v(name, value))).toBe(true));
  it.each([['VITE_AUTH_MODE', 'test'], ['API_URL', 'http://localhost:3000'], ['KEYCLOAK_REALM', 'x'], ['DATABASE_URL', 'postgresql://127.0.0.1/x']])(
    'shows %s',
    (name, value) => expect(isSecretVar(v(name, value))).toBe(false),
  );
});

describe('featureOf', () => {
  it.each([
    ['AUTH_TEST_IDP_ENABLED', 'signIn'], ['ENTRA_CLIENT_ID', 'signIn'], ['OAUTH_CLIENT_SECRET', 'signIn'],
    ['STRIPE_KEY', 'payments'], ['PAYMENT_PROVIDER', 'payments'],
    ['S3_BUCKET', 'storage'], ['STORAGE_ACCOUNT', 'storage'],
    ['SMTP_HOST', 'email'], ['MAIL_FROM', 'email'],
    ['OPENAI_API_KEY', 'externalApi'], ['ANTHROPIC_API_KEY', 'externalApi'], ['WEATHER_API_KEY', 'externalApi'],
    ['GOOGLE_MAPS_KEY', 'maps'], ['TWILIO_SID', 'sms'],
    ['APP_NAME', 'other'],
  ])('%s → %s', (name, feature) => expect(featureOf(name)).toBe(feature));
});

describe('isEmptyVar and sortVars', () => {
  it('counts an empty value, not one the preview fills in at the start', () => {
    expect(isEmptyVar(v('A'))).toBe(true);
    expect(isEmptyVar(v('A', '', { pending: true }))).toBe(false);
    expect(isEmptyVar(v('A', 'x'))).toBe(false);
  });
  it('puts empty values first, then by name', () => {
    expect(sortVars([v('B', '1'), v('Z'), v('A', '1')]).map((x) => x.name)).toEqual(['Z', 'A', 'B']);
  });
});

describe('summarizeEnv', () => {
  const report = (extra: Partial<PreviewEnvReport>): PreviewEnvReport => ({ running: true, restartNeeded: false, databases: [], mail: false, dockerUnavailable: false, services: [], ...extra });

  it('says what was started, and that nothing is missing', () => {
    expect(summarizeEnv(report({ databases: ['postgres'], composeServices: ['rabbitmq'], mail: true, services: [{ service: 'api', dir: '', vars: [v('A', '1')] }] }))).toEqual({
      dockerUnavailable: false, databases: ['postgres'], composeServices: ['rabbitmq'], mail: true, empty: 0, features: [], outside: [],
    });
  });

  it('groups empty settings by what they are for, once each, and names the outside services that need keys', () => {
    const s = summarizeEnv(report({
      services: [
        { service: 'api', dir: 'api', vars: [v('STRIPE_KEY'), v('ENTRA_CLIENT_ID'), v('APP_NAME'), v('DATABASE_URL', '', { pending: true })] },
        { service: 'web', dir: 'web', vars: [v('VITE_ENTRA_CLIENT_ID'), v('SMTP_HOST')] },
      ],
    }));
    expect(s.empty).toBe(5);
    expect(s.features).toEqual(['signIn', 'payments', 'email', 'other']);
    expect(s.outside).toEqual(['signIn', 'payments']);
  });
});
