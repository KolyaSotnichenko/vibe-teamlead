/**
 * Why the preview's page may be blank: a config that hard-codes a service's dev address
 * while the preview runs that service on another port, or a request through the page that
 * its backend never answered. Each comes with a button that makes the fix a task, written
 * here without a model call.
 */

import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import type { PreviewAddressIssue, PreviewService } from '../../../shared/types';
import { createTask } from '../../stores/task-store';
import { Button } from '../ui/button';
import { Notice } from '../task-detail/workspace/workspace-ui';

/** A value from the project, safe inline in markdown: one line, no backticks, capped */
const projectValue = (text: string | undefined, max = 200) => (text ?? '').replace(/`/g, "'").replace(/\s+/g, ' ').trim().slice(0, max);

/** The variable the address should come from: `API_URL` for `api` */
const variableFor = (service: string | undefined) => `${(service ?? 'backend').toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'BACKEND'}_URL`;

const exampleOf = (dir: string | undefined) => (dir ? `${dir}/.env.example` : '.env.example');

export function addressTask(issue: PreviewAddressIssue, services: PreviewService[]): { title: string; description: string } {
  const service = projectValue(issue.service, 40) || 'the backend';
  const variable = variableFor(issue.service);
  if (issue.file) {
    const file = projectValue(issue.file);
    const address = projectValue(issue.address, 80);
    const example = exampleOf(issue.fromDir ?? services.find((s) => s.name === issue.from)?.dir);
    return {
      title: `Read the ${service} address in ${file} from ${variable}`,
      description: [
        `\`${file}\` line ${issue.line} sends to \`${address}\`, the port ${service} listens on in development (${issue.ownPort}). In the app's preview that port was taken, so ${service} ran on port ${issue.previewPort} and the page could not reach it: a blank page, every request failing.`,
        '',
        `Read the address from an environment variable, \`${variable}\`, with the current value as the default, for example \`process.env.${variable} ?? "${address}"\` (or the config's own way of reading the environment). Then add \`${variable}=${address}\` to \`${example}\`: the preview points a local address there at the port it runs ${service} on.`,
        '',
        'Change nothing else; without the variable everything works as it does now.',
        '',
        '## Acceptance criteria',
        '',
        `- AC-1: \`${file}\` takes the ${service} address from \`${variable}\`, and uses \`${address}\` when \`${variable}\` is not set.`,
        `- AC-2: \`${example}\` has \`${variable}=${address}\`.`,
        `- AC-3: With \`${variable}\` unset, the app runs in development as before (a test or the existing tests show it).`,
      ].join('\n'),
    };
  }
  const path = projectValue(issue.unreachable?.path, 120) || '/api';
  const result = projectValue(issue.unreachable?.result, 40);
  return {
    title: `Let the preview's page reach ${service}`,
    description: [
      `In the app's preview, a request from the page to \`${path}\` came back ${result}: the page can't reach ${service}, so it stays blank. The preview runs each service on the port the project expects when it is free, otherwise on another port, and points local addresses in \`.env.example\` at it.`,
      '',
      `Find where the page, or its dev server, names ${service}'s address (a proxy target, a rewrite, a base URL) as a fixed \`localhost\` address. Read it from an environment variable, \`${variable}\`, with the current value as the default, and add \`${variable}\` with that value to the page's \`.env.example\`.`,
      '',
      '## Acceptance criteria',
      '',
      `- AC-1: The page takes ${service}'s address from \`${variable}\`, and uses the current address when it is not set.`,
      `- AC-2: The page's \`.env.example\` has \`${variable}\` with the current address.`,
      `- AC-3: With \`${variable}\` unset, the app runs in development as before.`,
    ].join('\n'),
  };
}

function IssueLine({ projectId, issue, services }: { projectId: string; issue: PreviewAddressIssue; services: PreviewService[] }) {
  const { t } = useTranslation(['tasks']);
  const [created, setCreated] = useState(false);
  const make = async () => {
    const { title, description } = addressTask(issue, services);
    if (await createTask(projectId, title, description)) setCreated(true);
  };
  const text = issue.file
    ? t('preview.address.hardcoded', { file: issue.file, line: issue.line, address: issue.address, service: issue.service, ownPort: issue.ownPort, previewPort: issue.previewPort })
    : issue.service
      ? t('preview.address.unreachable', { service: issue.service, path: issue.unreachable?.path, result: issue.unreachable?.result })
      : t('preview.address.unreachableAny', { path: issue.unreachable?.path, result: issue.unreachable?.result });
  return (
    <div className="space-y-2">
      <p>{text}</p>
      {created ? (
        <p className="text-foreground">{t('preview.address.taskCreated')}</p>
      ) : (
        <Button size="sm" variant="outline" onClick={() => void make()}>
          {t('preview.address.createTask')}
        </Button>
      )}
    </div>
  );
}

export function AddressNotice({ projectId, issues, services }: { projectId: string; issues: PreviewAddressIssue[]; services: PreviewService[] }) {
  if (!issues.length) return null;
  return (
    <Notice>
      <div className="space-y-3">
        {issues.map((issue) => (
          <IssueLine key={`${issue.file ?? ''}:${issue.line ?? ''}:${issue.address ?? ''}:${issue.unreachable?.path ?? ''}`} projectId={projectId} issue={issue} services={services} />
        ))}
      </div>
    </Notice>
  );
}
