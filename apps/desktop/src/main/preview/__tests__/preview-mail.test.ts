import { describe, expect, it, vi } from 'vitest';

import type { DockerRun } from '../../ai/verification/test-services';
import { getMail, listMail, mailEnv, MAILPIT_IMAGE, needsMail, startPreviewMail } from '../preview-mail';

describe('needsMail', () => {
  it('is on when the example configures SMTP, and off for a console provider', () => {
    expect(needsMail('SMTP_HOST=smtp.example.com\nSMTP_PORT=587')).toBe(true);
    expect(needsMail('MAILER_DSN=smtp://user:pass@mail.example.com:25')).toBe(true);
    expect(needsMail('EMAIL_SERVER=smtp://a:b@x:587')).toBe(true);
    expect(needsMail('MAIL_HOST=mailhog')).toBe(true);
    expect(needsMail('EMAIL_PROVIDER=console\nPORT=3001')).toBe(false);
    expect(needsMail('')).toBe(false);
  });
});

describe('mailEnv', () => {
  it('points every SMTP setting the example names at the local mail catcher, with no credentials or TLS', () => {
    const env = mailEnv('SMTP_HOST=smtp.sendgrid.net\nSMTP_PORT=587\nSMTP_USER=apikey\nSMTP_PASS=secret\nSMTP_SECURE=true\nMAILER_DSN=smtp://x\nOTHER=1', 41025);
    expect(env).toEqual({
      SMTP_HOST: '127.0.0.1',
      SMTP_PORT: '41025',
      SMTP_USER: '',
      SMTP_PASS: '',
      SMTP_SECURE: 'false',
      MAILER_DSN: 'smtp://127.0.0.1:41025',
    });
  });
});

describe('startPreviewMail', () => {
  function fakeDocker(ok = true) {
    const calls: string[][] = [];
    const docker: DockerRun = async (args) => {
      calls.push(args);
      if (args[0] === 'info') return { ok, stdout: '' };
      if (args[0] === 'run') return { ok: true, stdout: 'mail123\n' };
      if (args[0] === 'port') return { ok: true, stdout: args[2] === '1025/tcp' ? '127.0.0.1:41025\n' : '127.0.0.1:48025\n' };
      return { ok: true, stdout: '' };
    };
    return { docker, calls };
  }

  it("starts a pinned Mailpit on local ports only, labelled like the preview's database", async () => {
    const { docker, calls } = fakeDocker();
    const mail = await startPreviewMail(docker, 'p1');
    const run = calls.find((c) => c[0] === 'run')!;
    expect(run).toEqual(expect.arrayContaining(['--label', 'vibe-teamlead-preview=p1', '-p', '127.0.0.1::1025', '-p', '127.0.0.1::8025', MAILPIT_IMAGE]));
    expect(MAILPIT_IMAGE).toMatch(/^axllent\/mailpit:v\d+\.\d+/);
    expect(mail).toMatchObject({ status: 'started', smtpPort: 41025, httpPort: 48025 });
    await mail.stop();
    expect(calls.at(-1)).toEqual(['rm', '-f', 'mail123']);
  });

  it('says so without Docker', async () => {
    const { docker } = fakeDocker(false);
    expect((await startPreviewMail(docker, 'p1')).status).toBe('unavailable');
  });
});

describe('reading the caught mail', () => {
  it('lists the messages and reads one, with the links in it', async () => {
    const fetchJson = vi.fn(async (url: string) => {
      if (url.endsWith('/api/v1/messages?limit=50')) {
        return { messages: [{ ID: 'm1', From: { Address: 'no-reply@app.test' }, To: [{ Address: 'me@x.test' }], Subject: 'Verify your email', Created: '2026-11-09T14:00:00Z', Snippet: 'Click…' }] };
      }
      return { ID: 'm1', From: { Address: 'no-reply@app.test' }, To: [{ Address: 'me@x.test' }], Subject: 'Verify your email', Date: '2026-11-09T14:00:00Z', Text: 'Open http://localhost:4100/verify?token=abc to verify.', HTML: '<a href="http://localhost:4100/verify?token=abc">Verify</a>' };
    });
    expect(await listMail(48025, fetchJson)).toEqual([{ id: 'm1', from: 'no-reply@app.test', to: ['me@x.test'], subject: 'Verify your email', at: '2026-11-09T14:00:00Z', snippet: 'Click…' }]);
    expect(fetchJson).toHaveBeenCalledWith('http://127.0.0.1:48025/api/v1/messages?limit=50');
    const message = await getMail(48025, 'm1', fetchJson);
    expect(message).toMatchObject({ id: 'm1', subject: 'Verify your email', text: 'Open http://localhost:4100/verify?token=abc to verify.' });
    expect(message?.links).toEqual(['http://localhost:4100/verify?token=abc']);
  });

  it('refuses an id that is not one', async () => {
    const fetchJson = vi.fn();
    expect(await getMail(48025, '../../x', fetchJson)).toBeNull();
    expect(fetchJson).not.toHaveBeenCalled();
  });
});
