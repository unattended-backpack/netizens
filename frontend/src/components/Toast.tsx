import { useToast } from '../contexts/ToastContext';
import { useSoundEffects } from '../hooks/useSoundEffects';
import './Toast.css';

export function ToastContainer() {
  const { toasts, removeToast } = useToast();
  const { playClickSound } = useSoundEffects();

  if (toasts.length === 0) return null;

  return (
    <div
      className="toast-container"
      aria-live="polite"
      aria-atomic="false"
    >
      {toasts.map((toast) => (
        <div
          key={toast.id}
          className={`toast toast--${toast.type}`}
          role="alert"
          onClick={() => { removeToast(toast.id); playClickSound(); }}
        >
          <div className="toast__content">
            <span className="toast__message">{toast.message}</span>
            {toast.details && (
              <span className="toast__details">{toast.details}</span>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
