/**
 * Toaster: renders the toast viewport. Mounted once in the app root.
 */
import { useTranslation } from 'react-i18next';
import { Toast, ToastClose, ToastDescription, ToastProvider, ToastTitle, ToastViewport } from './toast';
import { useToast } from '../../hooks/use-toast';

/** Success and info toasts leave after this long; errors stay until dismissed. */
const AUTO_DISMISS_MS = 5000;

export function Toaster() {
  const { t } = useTranslation('common');
  const { toasts } = useToast();

  return (
    <ToastProvider swipeDirection="right" label={t('toast.region')}>
      {toasts.map(({ id, title, description, action, variant, duration, ...props }) => {
        const error = variant === 'destructive';
        return (
          <Toast
            key={id}
            variant={variant}
            duration={duration ?? (error ? Number.POSITIVE_INFINITY : AUTO_DISMISS_MS)}
            // An error interrupts; success and info wait their turn.
            type={error ? 'foreground' : 'background'}
            {...props}
          >
            <div className="min-w-0 flex-1 py-3">
              {error && (
                <p className="text-[11px] font-semibold uppercase tracking-[0.06em] text-[var(--vt-signal-on-dark)]">
                  {t('toast.error')}
                </p>
              )}
              {title && <ToastTitle className={error ? 'mt-1' : undefined}>{title}</ToastTitle>}
              {description && <ToastDescription>{description}</ToastDescription>}
            </div>
            {action}
            <ToastClose aria-label={t('toast.dismiss')} />
          </Toast>
        );
      })}
      <ToastViewport />
    </ToastProvider>
  );
}
