/**
 * The agent that fixes a failed start, as the owner sees it under the failure: that it is
 * working and on which try, with a way to stop it; or what it found when no recipe could make
 * the project start (a change the code needs, as a task ready to make; what only the owner
 * can supply; or that it could not work it out); or, when nothing ran for this failure, the
 * button that asks for it. A start it did fix is said over the running page, not here.
 */

import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { PREVIEW_FIX_MAX_TRIES } from '../../../shared/constants/preview-fix';
import type { PreviewFix } from '../../../shared/types';
import { createTask } from '../../stores/task-store';
import { Button } from '../ui/button';

const MAX_TRIES = PREVIEW_FIX_MAX_TRIES;

export function StartFixPanel({ projectId, fix, onEnvironment }: { projectId: string; fix: PreviewFix; onEnvironment: () => void }) {
  const { t } = useTranslation(['tasks']);
  const [task, setTask] = useState<'created' | 'failed' | null>(null);
  /** Why the agent could not be asked, in the interface's language */
  const [askFailed, setAskFailed] = useState<string | null>(null);
  const api = window.electronAPI.preview;
  const ask = async () => {
    setAskFailed(null);
    const result = await api.fix(projectId);
    if (result.success) return;
    const said = result.errorSaid;
    setAskFailed(said ? t(`preview.say.${said.key}`, { ...said.params, defaultValue: said.text }) : (result.error ?? ''));
  };

  if (fix.state === 'running') {
    return (
      <div role="status" className="flex items-center justify-between gap-4 border-l-2 border-foreground bg-muted px-3 py-2 text-sm">
        <div>
          <p className="font-semibold text-foreground">{t(fix.check ? 'preview.fix.checking' : 'preview.fix.running')}</p>
          {fix.tries > 0 && <p className="text-muted-foreground">{t('preview.fix.tries', { n: fix.tries, max: MAX_TRIES })}</p>}
        </div>
        <Button size="sm" variant="outline" onClick={() => void api.cancelFix()}>
          {t('preview.fix.stop')}
        </Button>
      </div>
    );
  }
  if (fix.state === 'done' && fix.outcome === 'fixed') return null;

  // The task is an agent's text, written from what it read in the project: the owner sees all of it first,
  // and it goes to Planning, where nothing works from it until the owner starts it
  const makeTask = async (title: string, description: string) => {
    setTask((await createTask(projectId, title, description, { sourceType: 'preview-fix' })) ? 'created' : 'failed');
  };

  return (
    <div className="space-y-3 border border-border p-3 text-sm">
      {fix.state === 'done' && fix.outcome === 'needs_owner' && (
        <div className="space-y-2">
          <p className="font-semibold text-foreground">{t('preview.fix.missingTitle')}</p>
          <p className="text-muted-foreground">{fix.summary}</p>
          <ul className="space-y-1">
            {fix.missing.map((item) => (
              <li key={`${item.what}:${item.why}`}>
                <span className="font-mono text-foreground">{item.what}</span>
                <span className="text-muted-foreground"> · </span>
                <span className="text-muted-foreground">{item.why}</span>
              </li>
            ))}
          </ul>
          {fix.missing.some((item) => item.variable) && (
            <Button size="sm" variant="outline" onClick={onEnvironment}>
              {t('preview.fix.environment')}
            </Button>
          )}
        </div>
      )}
      {fix.state === 'done' && fix.outcome === 'needs_code_change' && (
        <div className="space-y-2">
          <p className="font-semibold text-foreground">{t('preview.fix.codeTitle')}</p>
          <p className="text-muted-foreground">{fix.summary}</p>
          <div className="border border-border p-3">
            <p className="font-semibold text-foreground">{fix.task.title}</p>
            <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap font-sans text-muted-foreground">{fix.task.description}</pre>
          </div>
          {task === 'created' ? (
            <p className="text-foreground">{t('preview.fix.taskCreated')}</p>
          ) : (
            <>
              <Button size="sm" variant="outline" onClick={() => void makeTask(fix.task.title, fix.task.description)}>
                {t('preview.fix.createTask')}
              </Button>
              {task === 'failed' && <p role="alert" className="text-destructive">{t('preview.fix.taskFailed')}</p>}
            </>
          )}
        </div>
      )}
      {fix.state === 'done' && fix.outcome === 'unknown' && (
        <div className="space-y-2">
          <p className="font-semibold text-foreground">{t('preview.fix.unknown')}</p>
          <p className="text-muted-foreground">
            {fix.summarySaid ? t(`preview.say.${fix.summarySaid.key}`, { ...fix.summarySaid.params, defaultValue: fix.summarySaid.text }) : fix.summary}
          </p>
        </div>
      )}
      <div className="flex flex-wrap gap-2">
        {fix.state === 'idle' && (
          <Button size="sm" onClick={() => void ask()}>
            {t('preview.fix.ask')}
          </Button>
        )}
        <Button size="sm" variant="outline" onClick={() => void api.start(projectId)}>
          {t('preview.fix.tryAgain')}
        </Button>
        {fix.state === 'done' && (
          <Button size="sm" variant="outline" onClick={() => void ask()}>
            {t('preview.fix.askAgain')}
          </Button>
        )}
      </div>
      {askFailed && <p role="alert" className="text-destructive">{askFailed}</p>}
    </div>
  );
}
