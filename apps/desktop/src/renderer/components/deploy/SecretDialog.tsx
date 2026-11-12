/**
 * Add a CI secret: a name (GitHub's rules) and a value entered once, saved as a GitHub Actions
 * secret of the project's repository through `deploy:setSecret` (main seals it for GitHub). The
 * value is never shown again: it is dropped from state once saved and on close (and goes with the component).
 * Used by the Readiness tab (a missing secret) and the Setup tab (add or replace).
 */
import { useEffect, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { isValidSecretName } from '../../../shared/utils/github-secret-name';
import { Button } from '../ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../ui/dialog';
import { Input } from '../ui/input';
import { Label } from '../ui/label';
import { useDeployErrorText } from './status';

export interface SecretDialogProps {
  open: boolean;
  projectId: string;
  /** The name to start with (a secret the workflow reads); the owner can still change it. */
  initialName?: string;
  onClose: () => void;
  /** Called once GitHub has the secret (the dialog does not close itself). */
  onSaved: (name: string) => void;
}

export function SecretDialog({ open, projectId, initialName, onClose, onSaved }: SecretDialogProps) {
  const { t } = useTranslation(['deploy']);
  const errorText = useDeployErrorText();
  const ids = useId();
  const [name, setName] = useState(initialName ?? '');
  const [value, setValue] = useState('');
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  // Closed (cancel, Escape, outside click): the typed value is dropped
  useEffect(() => {
    if (!open) setValue('');
  }, [open]);

  useEffect(() => {
    if (!open) return;
    setName(initialName ?? '');
    setValue('');
    setFailure(null);
  }, [open, initialName]);

  const trimmed = name.trim();
  const nameOk = isValidSecretName(trimmed);
  const canSave = !saving && nameOk && value !== '';

  const save = async () => {
    if (!canSave) return;
    setSaving(true);
    setFailure(null);
    let kind: string | undefined;
    let ok = false;
    try {
      const r = await window.electronAPI.deploy.setSecret(projectId, trimmed, value);
      if (r.success && r.data) {
        ok = r.data.ok;
        if (!r.data.ok) kind = r.data.kind;
      }
    } catch {
      // the request itself failed: the generic words
    }
    setSaving(false);
    if (ok) {
      setValue('');
      onSaved(trimmed);
      return;
    }
    setFailure(errorText(kind));
  };

  const field = (id: string) => `${ids}-${id}`;

  return (
    <Dialog open={open} onOpenChange={(next) => !next && !saving && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('deploy:secretDialog.title')}</DialogTitle>
          <DialogDescription>{t('deploy:secretDialog.description')}</DialogDescription>
        </DialogHeader>
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <fieldset disabled={saving} className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor={field('name')}>{t('deploy:secretDialog.name')}</Label>
              <Input
                id={field('name')}
                value={name}
                onChange={(e) => setName(e.target.value)}
                autoComplete="off"
                spellCheck={false}
                className="font-mono"
                placeholder="API_KEY"
                aria-invalid={trimmed !== '' && !nameOk}
                aria-describedby={field('name-rule')}
              />
              <p id={field('name-rule')} className={trimmed !== '' && !nameOk ? 'text-xs text-destructive' : 'text-xs text-muted-foreground'}>
                {t('deploy:secretDialog.nameRule')}
              </p>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor={field('value')}>{t('deploy:secretDialog.value')}</Label>
              <Input
                id={field('value')}
                type="password"
                value={value}
                onChange={(e) => setValue(e.target.value)}
                autoComplete="new-password"
                spellCheck={false}
              />
              <p className="text-xs text-muted-foreground">{t('deploy:secretDialog.valueHint')}</p>
            </div>
          </fieldset>

          {failure && (
            <p role="alert" className="text-sm text-destructive">
              {failure}
            </p>
          )}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose} disabled={saving}>
              {t('deploy:secretDialog.cancel')}
            </Button>
            <Button type="submit" disabled={!canSave}>
              {saving ? t('deploy:secretDialog.saving') : t('deploy:secretDialog.save')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
