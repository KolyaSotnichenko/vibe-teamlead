/**
 * Mail in the Preview: when the project's example settings configure SMTP, the preview runs
 * Mailpit, a local mail catcher, and points those settings at it. Nothing leaves the machine;
 * the Mail panel reads what the app sent from Mailpit's API. A project that prints mail to
 * its log (a "console" provider) needs none of this: the Logs panel shows it.
 * No Electron imports: docker and fetch are passed in.
 */

import type { DockerRun } from '../ai/verification/test-services';
import type { PreviewMailMessage, PreviewMailSummary } from '../../shared/types/preview';

/** Pinned: a preview never pulls whatever "latest" is that day */
export const MAILPIT_IMAGE = 'axllent/mailpit:v1.33';
const LABEL = 'vibe-teamlead-preview';
const SMTP_PORT = 1025;
const HTTP_PORT = 8025;

const exampleKeys = (text: string) =>
  text.split('\n').map((line) => /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=/.exec(line)?.[1]).filter((key): key is string => !!key);

/** Settings that name an SMTP server, by their usual names */
const HOST_KEYS = /^(SMTP|MAIL|EMAIL|MAILER)_(HOST|SERVER_HOST|SMTP_HOST)$|^SMTP_SERVER$/;
const PORT_KEYS = /^(SMTP|MAIL|EMAIL|MAILER)_(PORT|SERVER_PORT|SMTP_PORT)$/;
const URL_KEYS = /^(MAILER_DSN|MAILER_URL|SMTP_URL|MAIL_URL|EMAIL_SERVER|EMAIL_URL|SMTP_CONNECTION_URL)$/;
const SECRET_KEYS = /^(SMTP|MAIL|EMAIL|MAILER)_(USER|USERNAME|PASS|PASSWORD|SERVER_USER|SERVER_PASSWORD)$/;
const TLS_KEYS = /^(SMTP|MAIL|EMAIL|MAILER)_(SECURE|TLS|USE_TLS|USE_SSL|SSL|SERVER_SECURE)$/;

/** Whether the example configures SMTP. Pure. */
export function needsMail(example: string): boolean {
  return exampleKeys(example).some((key) => HOST_KEYS.test(key) || URL_KEYS.test(key));
}

/** Every SMTP setting the example names, pointed at the local catcher: no credentials, no TLS. Pure. */
export function mailEnv(example: string, smtpPort: number): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of exampleKeys(example)) {
    if (HOST_KEYS.test(key)) env[key] = '127.0.0.1';
    else if (PORT_KEYS.test(key)) env[key] = String(smtpPort);
    else if (URL_KEYS.test(key)) env[key] = `smtp://127.0.0.1:${smtpPort}`;
    else if (SECRET_KEYS.test(key)) env[key] = '';
    else if (TLS_KEYS.test(key)) env[key] = 'false';
  }
  return env;
}

export interface PreviewMail {
  status: 'started' | 'unavailable';
  smtpPort?: number;
  httpPort?: number;
  reason?: string;
  stop(): Promise<void>;
}

/** Mailpit on local ports, labelled like the preview's database so the same cleanup removes it */
export async function startPreviewMail(docker: DockerRun, key: string): Promise<PreviewMail> {
  const nothing = async () => {};
  if (!(await docker(['info'])).ok) return { status: 'unavailable', reason: 'Docker is not running, so the app\'s mail can\'t be caught.', stop: nothing };
  const run = await docker(['run', '-d', '--rm', '--label', `${LABEL}=${key}`, '-p', `127.0.0.1::${SMTP_PORT}`, '-p', `127.0.0.1::${HTTP_PORT}`, MAILPIT_IMAGE]);
  const id = run.stdout.trim().split('\n').pop() ?? '';
  if (!run.ok || !id) return { status: 'unavailable', reason: `Docker could not start ${MAILPIT_IMAGE}.`, stop: nothing };
  const stop = async () => {
    await docker(['rm', '-f', id]);
  };
  const portOf = async (port: number) => Number((await docker(['port', id, `${port}/tcp`])).stdout.trim().split('\n')[0]?.split(':').pop());
  const smtpPort = await portOf(SMTP_PORT);
  const httpPort = await portOf(HTTP_PORT);
  if (!smtpPort || !httpPort) {
    await stop();
    return { status: 'unavailable', reason: 'Docker gave no ports for the mail catcher.', stop: nothing };
  }
  return { status: 'started', smtpPort, httpPort, stop };
}

export type FetchJson = (url: string) => Promise<unknown>;

const address = (value: unknown): string => (value && typeof value === 'object' && typeof (value as { Address?: unknown }).Address === 'string' ? (value as { Address: string }).Address : '');
const text = (value: unknown, max = 2000): string => (typeof value === 'string' ? value.slice(0, max) : '');

/** The latest messages Mailpit caught */
export async function listMail(httpPort: number, fetchJson: FetchJson): Promise<PreviewMailSummary[]> {
  const data = (await fetchJson(`http://127.0.0.1:${httpPort}/api/v1/messages?limit=50`)) as { messages?: unknown };
  return (Array.isArray(data?.messages) ? data.messages : []).map((m: Record<string, unknown>) => ({
    id: text(m.ID, 100),
    from: address(m.From),
    to: (Array.isArray(m.To) ? m.To : []).map(address).filter(Boolean),
    subject: text(m.Subject, 300),
    at: text(m.Created, 40),
    snippet: text(m.Snippet, 300),
  }));
}

const ID = /^[\w-]{1,100}$/;
const LINK = /https?:\/\/[^\s"'<>)]+/g;

/** One message, its text and the links in it (from the text and the HTML's hrefs) */
export async function getMail(httpPort: number, id: string, fetchJson: FetchJson): Promise<PreviewMailMessage | null> {
  if (!ID.test(id)) return null;
  const m = (await fetchJson(`http://127.0.0.1:${httpPort}/api/v1/message/${id}`)) as Record<string, unknown> | null;
  if (!m || typeof m !== 'object') return null;
  const body = text(m.Text, 50_000);
  const html = text(m.HTML, 200_000);
  const links = [...new Set([...(body.match(LINK) ?? []), ...[...html.matchAll(/href=["'](https?:\/\/[^"']+)["']/g)].map((x) => x[1].replace(/&amp;/g, '&'))])].slice(0, 20);
  return {
    id: text(m.ID, 100),
    from: address(m.From),
    to: (Array.isArray(m.To) ? m.To : []).map(address).filter(Boolean),
    subject: text(m.Subject, 300),
    at: text(m.Date, 40),
    text: body,
    links,
  };
}
