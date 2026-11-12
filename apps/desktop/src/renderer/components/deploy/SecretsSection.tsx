/**
 * Setup → Secrets: the names of the project's GitHub Actions secrets (values are never shown),
 * with add and replace through SecretDialog. Only rendered once CI is set up.
 */
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '../ui/button';
import { SecretDialog } from './SecretDialog';
import { Notice, Section } from './parts';
import { useDeployErrorText } from './status';

export function SecretsSection({ projectId }: { projectId: string }) {
  const { t } = useTranslation(['deploy']);
  const errorText = useDeployErrorText();
  const [names, setNames] = useState<string[] | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  // undefined = closed; '' = a new secret; a name = replace it
  const [dialog, setDialog] = useState<string | undefined>();

  const load = useCallback(async () => {
    try {
      const r = await window.electronAPI.deploy.listSecrets(projectId);
      if (r.success && r.data?.ok) {
        setNames(r.data.names);
        setFailure(null);
      } else {
        setFailure(errorText(r.success && r.data && !r.data.ok ? r.data.kind : undefined));
      }
    } catch {
      setFailure(errorText(undefined));
    }
  }, [projectId, errorText]);

  useEffect(() => {
    void load();
    // load changes with the error-text function; the project is what matters
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  return (
    <Section id="deploy-secrets-title" title={t('deploy:secrets.title')}>
      <p className="text-sm text-muted-foreground">{t('deploy:secrets.description')}</p>
      {failure && <Notice tone="attention">{failure}</Notice>}
      {names && names.length === 0 && !failure && <p className="text-sm text-muted-foreground">{t('deploy:secrets.none')}</p>}
      {names && names.length > 0 && (
        <ul aria-label={t('deploy:secrets.title')} className="flex flex-col border border-foreground">
          {names.map((name) => (
            <li key={name} className="flex items-center justify-between gap-2 border-b border-border px-3 py-2 last:border-b-0">
              <span className="font-mono text-sm">{name}</span>
              <Button size="sm" variant="outline" aria-label={t('deploy:secrets.replace', { name })} onClick={() => setDialog(name)}>
                {t('deploy:secrets.replaceShort')}
              </Button>
            </li>
          ))}
        </ul>
      )}
      <div>
        <Button size="sm" onClick={() => setDialog('')}>
          {t('deploy:secrets.add')}
        </Button>
      </div>
      <SecretDialog
        open={dialog !== undefined}
        projectId={projectId}
        initialName={dialog || undefined}
        onClose={() => setDialog(undefined)}
        onSaved={() => {
          setDialog(undefined);
          void load();
        }}
      />
    </Section>
  );
}
