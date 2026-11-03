import { useTranslation } from 'react-i18next';
import { AlertTriangle, Settings } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from './ui/dialog';
import { Button } from './ui/button';
import { useAuthFailureStore } from '../stores/auth-failure-store';

interface AuthFailureModalProps {
  onOpenSettings?: () => void;
}

/**
 * Modal displayed when a Claude session fails to authenticate (401 error).
 * Points the user to Settings > Claude to check the API key.
 */
export function AuthFailureModal({ onOpenSettings }: AuthFailureModalProps) {
  const { isModalOpen, authFailureInfo, hideAuthFailureModal, clearAuthFailure } = useAuthFailureStore();
  const { t } = useTranslation('common');

  if (!authFailureInfo) return null;

  // Get user-friendly message for the auth failure type
  const getFailureMessage = () => {
    switch (authFailureInfo.failureType) {
      case 'expired':
        return t('auth.failure.tokenExpired', 'Your authentication token has expired.');
      case 'invalid':
        return t('auth.failure.tokenInvalid', 'Your authentication token is invalid.');
      case 'missing':
        return t('auth.failure.tokenMissing', 'No authentication token found.');
      default:
        return t('auth.failure.authFailed', 'Authentication failed.');
    }
  };

  const failureMessage = getFailureMessage();

  const handleGoToSettings = () => {
    hideAuthFailureModal();
    onOpenSettings?.();
  };

  const handleDismiss = () => {
    clearAuthFailure();
  };

  return (
    <Dialog open={isModalOpen} onOpenChange={(open) => !open && hideAuthFailureModal()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <div className="flex items-center gap-3">
            <div className="border border-border p-2">
              <AlertTriangle className="h-5 w-5 text-warning" />
            </div>
            <div>
              <DialogTitle className="text-lg">
                {t('auth.failure.title', 'Authentication Required')}
              </DialogTitle>
              <DialogDescription className="text-sm text-muted-foreground">
                {failureMessage}
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>

        <div className="space-y-4 py-4">
          <p className="text-sm text-foreground">
            {t('auth.failure.description')}
          </p>

          {authFailureInfo.taskId && (
            <div className="border border-border p-3 text-xs">
              <p className="text-muted-foreground">
                {t('auth.failure.taskAffected', 'Task affected')}: <span className="font-mono">{authFailureInfo.taskId}</span>
              </p>
            </div>
          )}

          {authFailureInfo.originalError && (
            <details className="text-xs">
              <summary className="cursor-pointer text-muted-foreground hover:text-foreground">
                {t('auth.failure.technicalDetails', 'Technical details')}
              </summary>
              <pre className="mt-2 border border-border p-2 font-mono overflow-x-auto whitespace-pre-wrap break-all">
                {authFailureInfo.originalError}
              </pre>
            </details>
          )}
        </div>

        <DialogFooter className="flex-col sm:flex-row gap-2">
          <Button variant="outline" onClick={handleDismiss} className="sm:mr-auto">
            {t('labels.dismiss', 'Dismiss')}
          </Button>
          <Button onClick={handleGoToSettings} className="gap-2">
            <Settings className="h-4 w-4" />
            {t('auth.failure.goToSettings', 'Go to Settings')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
