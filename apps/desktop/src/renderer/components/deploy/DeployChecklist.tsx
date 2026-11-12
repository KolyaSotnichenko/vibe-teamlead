/**
 * Top of Deploy: what is still missing before the project deploys, numbered, one action each
 * (sign in to GitHub, install the GitHub App, set up). Hidden once all is done.
 * Accounts are read again whenever the window regains focus (sign-ins finish in the browser).
 */
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { GITHUB_APP_INSTALL_URL } from '../../../shared/constants/github';
import { Button } from '../ui/button';
import { openWebUrl, StatusMark } from './status';

/** undefined = not known yet (or could not be read). */
interface Accounts {
  loaded: boolean;
  github?: boolean;
  app?: boolean;
}

function useAccounts(refreshKey: unknown): Accounts {
  const [accounts, setAccounts] = useState<Accounts>({ loaded: false });
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      const api = window.electronAPI;
      const read = async <T,>(f: () => Promise<{ success: boolean; data?: T }>, pick: (d: T) => boolean) => {
        try {
          const r = await f();
          return r.success && r.data ? pick(r.data) : undefined;
        } catch {
          return undefined;
        }
      };
      const [github, app] = await Promise.all([
        read(() => api.checkGitHubAuth(), (d) => d.authenticated),
        read(() => api.getGitHubAppAccess(), (d) => d.installed),
      ]);
      if (!cancelled) setAccounts({ loaded: true, github, app });
    };
    void load();
    const onFocus = () => void load();
    window.addEventListener('focus', onFocus);
    return () => {
      cancelled = true;
      window.removeEventListener('focus', onFocus);
    };
  }, [refreshKey]);
  return accounts;
}

export interface DeployChecklistProps {
  /** Deploy is set up for the project. */
  setUp: boolean;
  onConnectGitHub: () => void;
  onSetUp: () => void;
  /** Changes when something outside may have changed the accounts (e.g. GitHub sign-in finished). */
  refreshKey?: unknown;
}

export function DeployChecklist({ setUp, onConnectGitHub, onSetUp, refreshKey }: DeployChecklistProps) {
  const { t } = useTranslation(['deploy']);
  const accounts = useAccounts(refreshKey);
  if (!accounts.loaded) return null;

  const steps: Array<{ key: string; done: boolean; action?: React.ReactNode }> = [
    {
      key: 'github',
      done: accounts.github === true,
      action: <Button size="sm" onClick={onConnectGitHub}>{t('deploy:checklist.actions.github')}</Button>,
    },
    {
      key: 'app',
      done: accounts.app === true,
      // the install check needs a GitHub sign-in
      action: accounts.github ? (
        <Button size="sm" variant="outline" onClick={() => openWebUrl(GITHUB_APP_INSTALL_URL)}>{t('deploy:checklist.actions.app')}</Button>
      ) : undefined,
    },
    {
      key: 'setUp',
      done: setUp,
      action: <Button size="sm" onClick={onSetUp}>{t('deploy:setup.cta')}</Button>,
    },
  ];
  if (steps.every((s) => s.done)) return null;

  return (
    <section aria-labelledby="deploy-checklist-title" className="flex flex-col gap-2">
      <h3 id="deploy-checklist-title" className="font-mono text-[11px] uppercase tracking-[0.06em] text-muted-foreground">
        {t('deploy:checklist.title')}
      </h3>
      <ol aria-label={t('deploy:checklist.title')} className="flex flex-col border border-foreground">
        {steps.map((s, i) => (
          <li key={s.key} className="flex min-h-11 items-center gap-3 border-b border-border px-3 py-2 text-sm last:border-b-0">
            <span className="w-4 font-mono text-xs text-muted-foreground">{i + 1}</span>
            <StatusMark status={s.done ? 'success' : 'attention'} />
            <span className={s.done ? 'min-w-0 flex-1 text-muted-foreground' : 'min-w-0 flex-1 text-foreground'}>
              {t(`deploy:checklist.${s.key}`)}
            </span>
            {!s.done && s.action}
          </li>
        ))}
      </ol>
    </section>
  );
}
