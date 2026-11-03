import { useTranslation } from 'react-i18next';
import { AlertCircle, Clock, ExternalLink, FileText, Lightbulb, ListTodo, Map as MapIcon } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from './ui/dialog';
import { Button } from './ui/button';
import { useRateLimitStore } from '../stores/rate-limit-store';
import type { SDKRateLimitInfo } from '../../shared/types';

/** Where API-key users see and raise their limits */
const ANTHROPIC_LIMITS_URL = 'https://console.anthropic.com/settings/limits';

const SOURCE_KEYS: Record<SDKRateLimitInfo['source'], string> = {
  changelog: 'rateLimit.sources.changelog',
  task: 'rateLimit.sources.task',
  roadmap: 'rateLimit.sources.roadmap',
  ideation: 'rateLimit.sources.ideation',
  'title-generator': 'rateLimit.sources.titleGenerator',
  other: 'rateLimit.sources.claude',
};

function getSourceIcon(source: SDKRateLimitInfo['source']) {
  switch (source) {
    case 'changelog': return FileText;
    case 'task': return ListTodo;
    case 'roadmap': return MapIcon;
    case 'ideation': return Lightbulb;
    default: return AlertCircle;
  }
}

/**
 * Shown when a Claude session (task, roadmap, ideation, changelog...) stops
 * because it hit a rate limit. It says what stopped and when the limit resets;
 * the operation can be started again once it has.
 */
export function SDKRateLimitModal() {
  const { isSDKModalOpen, sdkRateLimitInfo, hideSDKRateLimitModal } = useRateLimitStore();
  const { t } = useTranslation('common');

  if (!sdkRateLimitInfo) return null;

  const SourceIcon = getSourceIcon(sdkRateLimitInfo.source);
  const sourceName = t(SOURCE_KEYS[sdkRateLimitInfo.source]);

  return (
    <Dialog open={isSDKModalOpen} onOpenChange={(open) => !open && hideSDKRateLimitModal()}>
      <DialogContent className="sm:max-w-[480px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <AlertCircle className="h-5 w-5 text-warning" />
            {t('rateLimit.sdk.title')}
          </DialogTitle>
          <DialogDescription className="flex items-center gap-2">
            <SourceIcon className="h-4 w-4" />
            {t('rateLimit.sdk.interrupted', { source: sourceName })}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          {sdkRateLimitInfo.resetTime && (
            <div className="flex items-center gap-3 border border-border p-4">
              <Clock className="h-5 w-5 shrink-0 text-muted-foreground" />
              <div>
                <p className="text-sm font-medium text-foreground">
                  {t('rateLimit.sdk.resetsLabel', { time: sdkRateLimitInfo.resetTime })}
                </p>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {sdkRateLimitInfo.limitType === 'weekly'
                    ? t('rateLimit.sdk.weeklyLimit')
                    : t('rateLimit.sdk.sessionLimit')}
                </p>
              </div>
            </div>
          )}

          <p className="text-sm text-muted-foreground">{t('rateLimit.sdk.whatToDo')}</p>

          {sdkRateLimitInfo.originalError && (
            <details className="text-xs">
              <summary className="cursor-pointer text-muted-foreground hover:text-foreground">
                {t('rateLimit.sdk.details')}
              </summary>
              <pre className="mt-2 overflow-x-auto whitespace-pre-wrap break-all border border-border p-2 font-mono">
                {sdkRateLimitInfo.originalError}
              </pre>
            </details>
          )}
        </div>

        <DialogFooter className="gap-2">
          <Button variant="outline" className="gap-2" onClick={() => window.open(ANTHROPIC_LIMITS_URL, '_blank')}>
            <ExternalLink className="h-4 w-4" />
            {t('rateLimit.sdk.viewLimits')}
          </Button>
          <Button onClick={hideSDKRateLimitModal}>{t('rateLimit.sdk.close')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
