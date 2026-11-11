/**
 * Environment → Needed from you: what only the owner can do before deploy goes on, each with
 * its action. Messages come from i18n by kind (main's English `message` is not shown).
 */
import { useTranslation } from 'react-i18next';
import type { NeededFromYou as NeededItem } from '../../../shared/types/deploy';
import { Button } from '../ui/button';
import { isWebUrl, openWebUrl } from './status';

const VERCEL_GITHUB_APP_URL = 'https://github.com/apps/vercel/installations/new';

export interface NeededFromYouProps {
  items: NeededItem[];
  /** `owner/repo`, when known. */
  repo?: string;
  setupRunning: boolean;
  databaseRunning: boolean;
  onChooseProject: (choice: { useProjectId: string } | { createNew: true }) => void;
  onAcknowledge: (id: string) => void;
  onAddValue: (name: string) => void;
  onAcceptTerms: () => void;
}

const openSettings = (section: 'vercel' | 'github') =>
  window.dispatchEvent(new CustomEvent('open-app-settings', { detail: section }));

/** `neon` → `Neon`. */
const integrationName = (slug?: string) => (slug ? slug.charAt(0).toUpperCase() + slug.slice(1) : '');

export function NeededFromYou(props: NeededFromYouProps) {
  const { t } = useTranslation(['deploy']);
  if (props.items.length === 0) return null;
  return (
    <section aria-labelledby="deploy-needed-title" className="flex flex-col gap-2">
      <h3 id="deploy-needed-title" className="font-mono text-[11px] uppercase tracking-[0.06em] text-muted-foreground">
        {t('deploy:needed.title')}
      </h3>
      <ul className="flex flex-col border border-foreground">
        {props.items.map((item) => (
          <li key={item.id} className="flex flex-col gap-2 border-b border-border px-3 py-3 last:border-b-0">
            <Item item={item} {...props} />
          </li>
        ))}
      </ul>
    </section>
  );
}

function Item({ item, repo, setupRunning, databaseRunning, onChooseProject, onAcknowledge, onAddValue, onAcceptTerms }: NeededFromYouProps & { item: NeededItem }) {
  const { t } = useTranslation(['deploy']);
  const link = (label: string, url: string | undefined) =>
    isWebUrl(url) ? (
      <Button size="sm" variant="outline" onClick={() => openWebUrl(url)}>
        {label}
      </Button>
    ) : null;

  let message: string;
  let actions: React.ReactNode = null;
  let extra: React.ReactNode = null;
  switch (item.kind) {
    case 'vercel-sign-in':
      message = t('deploy:needed.vercel-sign-in');
      actions = <Button size="sm" onClick={() => openSettings('vercel')}>{t('deploy:needed.actions.connectVercel')}</Button>;
      break;
    case 'github-sign-in':
      message = t('deploy:needed.github-sign-in');
      actions = <Button size="sm" onClick={() => openSettings('github')}>{t('deploy:needed.actions.connectGitHub')}</Button>;
      break;
    case 'github-app-install':
      message = t('deploy:needed.github-app-install');
      actions = link(t('deploy:needed.actions.installApp'), item.actionUrl);
      break;
    case 'vercel-git-access':
      message = t('deploy:needed.vercel-git-access');
      actions = link(t('deploy:needed.actions.grantVercel'), item.actionUrl ?? VERCEL_GITHUB_APP_URL);
      break;
    case 'vercel-existing-project':
      message = t('deploy:needed.vercel-existing-project');
      actions = (
        <>
          {(item.projects ?? []).map((p) => (
            <Button key={p.id} size="sm" disabled={setupRunning} onClick={() => onChooseProject({ useProjectId: p.id })}>
              {t('deploy:needed.actions.useProject', { name: p.name })}
            </Button>
          ))}
          <Button size="sm" variant="outline" disabled={setupRunning} onClick={() => onChooseProject({ createNew: true })}>
            {t('deploy:needed.actions.createNew')}
          </Button>
        </>
      );
      break;
    case 'non-github-remote':
      message = t('deploy:needed.non-github-remote');
      break;
    case 'public-repo-warning':
      message = t('deploy:needed.public-repo-warning', { repo: repo ?? '' });
      actions = (
        <>
          {link(t('deploy:needed.actions.repoSettings'), item.actionUrl)}
          <Button size="sm" variant="outline" onClick={() => onAcknowledge(item.id)}>
            {t('deploy:needed.actions.acknowledge')}
          </Button>
        </>
      );
      break;
    case 'variable':
      message = t('deploy:needed.variable', { name: item.variable ?? '' });
      actions = <Button size="sm" onClick={() => onAddValue(item.variable ?? '')}>{t('deploy:needed.actions.addValue')}</Button>;
      break;
    case 'database-terms':
      message = t('deploy:needed.database-terms', { integration: integrationName(item.integration) });
      extra = (item.policyLinks ?? []).length > 0 && (
        <ul aria-label={t('deploy:needed.policyLinks')} className="flex flex-col gap-1">
          {(item.policyLinks ?? []).map((l) => (
            <li key={l.url} className="flex flex-wrap items-baseline gap-2 text-sm">
              <button
                type="button"
                onClick={() => openWebUrl(l.url)}
                className="text-foreground underline underline-offset-2 hover:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                {l.name}
              </button>
              {/* The host, so the owner sees where a link really goes */}
              <span className="font-mono text-xs text-muted-foreground">{l.host}</span>
            </li>
          ))}
        </ul>
      );
      actions = (
        <Button size="sm" disabled={databaseRunning} onClick={onAcceptTerms}>
          {t('deploy:needed.actions.acceptTerms')}
        </Button>
      );
      break;
    case 'database-dashboard':
      message = t('deploy:needed.database-dashboard');
      actions = link(t('deploy:needed.actions.openDashboard'), item.actionUrl);
      break;
    default:
      message = t('deploy:env.errors.unknown');
  }

  return (
    <>
      <p className="text-sm text-foreground">{message}</p>
      {extra}
      {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
    </>
  );
}
