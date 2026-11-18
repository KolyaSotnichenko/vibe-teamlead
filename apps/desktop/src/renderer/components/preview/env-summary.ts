/**
 * Preview → Environment, in plain words: which settings are secret (masked), what an empty
 * setting is for, judged by its name, and a summary a non-programmer can read. Pure.
 */

import type { PreviewEnvReport, PreviewEnvVar } from '../../../shared/types';

export type EnvFeature = 'signIn' | 'payments' | 'storage' | 'email' | 'externalApi' | 'maps' | 'sms' | 'other';

/** In the order the summary names them */
const FEATURES: Array<[EnvFeature, RegExp]> = [
  ['signIn', /(^|_)(AUTH|AUTH0|ENTRA|AZURE_AD|AAD|OAUTH|OIDC|IDP|SSO|CLERK|COGNITO|KEYCLOAK|OKTA|NEXTAUTH|SAML|LOGIN)(_|$)/],
  ['payments', /(^|_)(STRIPE|PAYMENT|PAYMENTS|PAYPAL|BRAINTREE|ADYEN|MOLLIE|PADDLE|LIQPAY|WAYFORPAY|CHECKOUT|BILLING)(_|$)/],
  ['storage', /(^|_)(S3|BUCKET|STORAGE|BLOB|MINIO|R2|CLOUDINARY|UPLOADS?)(_|$)/],
  ['email', /(^|_)(SMTP|MAIL|EMAIL|MAILER|SENDGRID|POSTMARK|MAILGUN|RESEND|SES)(_|$)/],
  ['maps', /(^|_)(MAPS?|MAPBOX|GEOCODING|GOOGLE_MAPS)(_|$)/],
  ['sms', /(^|_)(SMS|TWILIO|VONAGE|NEXMO)(_|$)/],
  ['externalApi', /(^|_)(OPENAI|ANTHROPIC|CLAUDE|GEMINI|MISTRAL|COHERE|HUGGINGFACE|AZURE_OPENAI)(_|$)|_API_KEY$/],
];

/** What the setting is for, by its name */
export function featureOf(name: string): EnvFeature {
  const upper = name.toUpperCase();
  return FEATURES.find(([, pattern]) => pattern.test(upper))?.[0] ?? 'other';
}

/** Outside services that need the owner's own keys: the preview can't stand in for them */
const OUTSIDE: EnvFeature[] = ['signIn', 'payments', 'storage', 'externalApi', 'maps', 'sms'];

const SECRET_NAME = /(^|_)(SECRET|KEY|TOKEN|PASSWORD|PASSWD|PASS|PWD|APIKEY|CREDENTIALS?)$|PRIVATE/i;
/** A connection URL with a password in it */
const URL_WITH_CREDENTIALS = /^[a-z][a-z0-9+.-]*:\/\/[^/@\s:]*:[^/@\s]+@/i;

export function isSecretVar(v: PreviewEnvVar): boolean {
  return SECRET_NAME.test(v.name) || URL_WITH_CREDENTIALS.test(v.value);
}

/** Empty now; a value the preview fills in at the start is not */
export function isEmptyVar(v: PreviewEnvVar): boolean {
  return v.value === '' && !v.pending;
}

/** Empty values first, then by name */
export function sortVars(vars: PreviewEnvVar[]): PreviewEnvVar[] {
  return [...vars].sort((a, b) => Number(isEmptyVar(b)) - Number(isEmptyVar(a)) || a.name.localeCompare(b.name));
}

export interface EnvSummary {
  dockerUnavailable: boolean;
  databases: string[];
  mail: boolean;
  /** Empty settings across the services */
  empty: number;
  /** What the empty settings are for, in a fixed order */
  features: EnvFeature[];
  /** Of those, the outside services that need the owner's own keys */
  outside: EnvFeature[];
}

export function summarizeEnv(report: PreviewEnvReport): EnvSummary {
  const empties = report.services.flatMap((s) => s.vars.filter(isEmptyVar));
  const found = new Set(empties.map((v) => featureOf(v.name)));
  const order: EnvFeature[] = [...FEATURES.map(([feature]) => feature), 'other'];
  const features = order.filter((feature) => found.has(feature));
  return {
    dockerUnavailable: report.dockerUnavailable,
    databases: report.databases,
    mail: report.mail,
    empty: empties.length,
    features,
    outside: features.filter((feature) => OUTSIDE.includes(feature)),
  };
}
