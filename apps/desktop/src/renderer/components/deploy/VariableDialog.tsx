/**
 * Environment → Add variable: name, value (a password field; the value is never shown again and
 * is dropped from memory once a side has saved it), Production/Preview, and "also as a GitHub
 * secret". The result of each side (Vercel, GitHub) is shown in words.
 */
import { useEffect, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { DeploySetVariableResult, DeploySideError, DeployVariableInput, DeployVariableTarget } from '../../../shared/types/deploy';
import { Button } from '../ui/button';
import { Checkbox } from '../ui/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../ui/dialog';
import { Input } from '../ui/input';
import { Label } from '../ui/label';
import { useDeployErrorText } from './status';

export interface VariableDialogProps {
  open: boolean;
  initialName?: string;
  onClose: () => void;
  /** null: the request itself failed. */
  onSave: (input: DeployVariableInput) => Promise<DeploySetVariableResult | null>;
  /** Called after a save that fully succeeded (the dialog closes). */
  onSaved: (name: string, result: Extract<DeploySetVariableResult, { ok: true }>) => void;
}

type SideResult = 'ok' | 'skipped' | DeploySideError;

export function VariableDialog({ open, initialName, onClose, onSave, onSaved }: VariableDialogProps) {
  const { t } = useTranslation(['deploy']);
  const errorText = useDeployErrorText();
  const ids = useId();
  const [name, setName] = useState(initialName ?? '');
  const [value, setValue] = useState('');
  const [targets, setTargets] = useState<Record<DeployVariableTarget, boolean>>({ production: true, preview: true });
  const [alsoGitHub, setAlsoGitHub] = useState(false);
  const [saving, setSaving] = useState(false);
  const [sides, setSides] = useState<{ vercel: SideResult; github: SideResult } | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  // Closed (cancel, Escape, outside click) or unmounted: the typed value is dropped
  useEffect(() => {
    if (!open) setValue('');
    return () => setValue('');
  }, [open]);

  useEffect(() => {
    if (!open) return;
    setName(initialName ?? '');
    setValue('');
    setTargets({ production: true, preview: true });
    setAlsoGitHub(false);
    setSides(null);
    setFailure(null);
  }, [open, initialName]);

  const chosen = (Object.keys(targets) as DeployVariableTarget[]).filter((k) => targets[k]);
  const canSave = !saving && name.trim() !== '' && value !== '' && chosen.length > 0;

  const save = async () => {
    if (!canSave) return;
    setSaving(true);
    setSides(null);
    setFailure(null);
    const input: DeployVariableInput = { name: name.trim(), value, targets: chosen, alsoGitHubSecret: alsoGitHub };
    let result: DeploySetVariableResult | null = null;
    try {
      result = await onSave(input);
    } catch {
      result = null;
    }
    setSaving(false);
    if (!result) {
      setFailure(t('deploy:env.errors.unknown'));
      return;
    }
    if (result.ok) {
      setValue('');
      onSaved(input.name, result);
      return;
    }
    if ('kind' in result) {
      setFailure(errorText(result.kind));
      return;
    }
    // Saved on Vercel: the value is there now; it is not kept here
    if (result.vercel === 'ok') setValue('');
    setSides({ vercel: result.vercel, github: result.github });
  };

  const sideText = (side: 'vercel' | 'github', r: SideResult) =>
    r === 'ok'
      ? t(`deploy:variableDialog.result.${side}.ok`)
      : r === 'skipped'
        ? t(`deploy:variableDialog.result.${side}.skipped`)
        : t(`deploy:variableDialog.result.${side}.failed`, { reason: errorText(r.kind) });

  const field = (id: string) => `${ids}-${id}`;

  return (
    <Dialog open={open} onOpenChange={(next) => !next && !saving && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('deploy:variableDialog.title')}</DialogTitle>
          <DialogDescription>{t('deploy:variableDialog.description')}</DialogDescription>
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
              <Label htmlFor={field('name')}>{t('deploy:variableDialog.name')}</Label>
              <Input
                id={field('name')}
                value={name}
                onChange={(e) => setName(e.target.value)}
                autoComplete="off"
                spellCheck={false}
                className="font-mono"
                placeholder="API_KEY"
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor={field('value')}>{t('deploy:variableDialog.value')}</Label>
              <Input
                id={field('value')}
                type="password"
                value={value}
                onChange={(e) => setValue(e.target.value)}
                autoComplete="new-password"
                spellCheck={false}
              />
              <p className="text-xs text-muted-foreground">{t('deploy:variableDialog.valueHint')}</p>
            </div>
            <div className="flex flex-col gap-2">
              {(['production', 'preview'] as const).map((target) => (
                <div key={target} className="flex items-center gap-2">
                  <Checkbox
                    id={field(target)}
                    checked={targets[target]}
                    onCheckedChange={(c) => setTargets((s) => ({ ...s, [target]: c === true }))}
                  />
                  <Label htmlFor={field(target)}>{t(`deploy:variableDialog.${target}`)}</Label>
                </div>
              ))}
              <div className="flex items-center gap-2">
                <Checkbox id={field('github')} checked={alsoGitHub} onCheckedChange={(c) => setAlsoGitHub(c === true)} />
                <Label htmlFor={field('github')}>{t('deploy:variableDialog.alsoGitHub')}</Label>
              </div>
            </div>
          </fieldset>

          {sides && (
            <ul role="status" className="flex flex-col gap-1 border-l-2 border-foreground bg-muted px-3 py-2 text-sm">
              {(['vercel', 'github'] as const).map((side) => (
                <li key={side} className={typeof sides[side] === 'object' ? 'text-destructive' : 'text-foreground'}>
                  {sideText(side, sides[side])}
                </li>
              ))}
            </ul>
          )}
          {failure && (
            <p role="alert" className="text-sm text-destructive">
              {failure}
            </p>
          )}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose} disabled={saving}>
              {t('deploy:variableDialog.cancel')}
            </Button>
            <Button type="submit" disabled={!canSave}>
              {saving ? t('deploy:variableDialog.saving') : t('deploy:variableDialog.save')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
