/**
 * Environment → Needed from you: what only the owner can do before CI setup goes on, each with
 * its action. Messages come from i18n by kind (main's English `message` is not shown).
 */
import { useTranslation } from 'react-i18next';
import type { NeededFromYou as NeededItem } from '../../../shared/types/deploy';
import { Button } from '../ui/button';
import { isWebUrl, openWebUrl } from './status';

export interface NeededFromYouProps {
  items: NeededItem[];
  /** `owner/repo`, when known. */
  repo?: string;
  onAcknowledge: (id: string) => void;
  onConnectGitHub: () => void;
}

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

function Item({ item, repo, onAcknowledge, onConnectGitHub }: NeededFromYouProps & { item: NeededItem }) {
  const { t } = useTranslation(['deploy']);
  const link = (label: string, url: string | undefined) =>
    isWebUrl(url) ? (
      <Button size="sm" variant="outline" onClick={() => openWebUrl(url)}>
        {label}
      </Button>
    ) : null;

  let message: string;
  let actions: React.ReactNode = null;
  switch (item.kind) {
    case 'github-sign-in':
      message = t('deploy:needed.github-sign-in');
      actions = <Button size="sm" onClick={onConnectGitHub}>{t('deploy:needed.actions.connectGitHub')}</Button>;
      break;
    case 'github-app-install':
      message = t('deploy:needed.github-app-install');
      actions = link(t('deploy:needed.actions.installApp'), item.actionUrl);
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
    default:
      message = t('deploy:env.errors.unknown');
  }

  return (
    <>
      <p className="text-sm text-foreground">{message}</p>
      {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
    </>
  );
}
