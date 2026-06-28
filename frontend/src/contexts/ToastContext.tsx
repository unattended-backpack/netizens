import { createContext, useContext, useMemo, useState, type ReactNode } from 'react';

export type ToastType = 'success' | 'error' | 'info';

export type Toast = {
  id: string;
  type: ToastType;
  message: string;
  details?: string;
};

// Separate contexts for state and actions to prevent unnecessary re-renders
const ToastStateContext = createContext<Toast[]>([]);

interface ToastActions {
  addToast: (type: ToastType, message: string, details?: string) => string;
  removeToast: (id: string) => void;
}

const ToastActionsContext = createContext<ToastActions | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  // Actions are stable - empty dependency array
  const actions = useMemo<ToastActions>(
    () => ({
      addToast: (type: ToastType, message: string, details?: string) => {
        const id = crypto.randomUUID();
        const toast: Toast = { id, type, message, details };

        // Prepend new toasts so newest appears on top
        setToasts((prev) => [toast, ...prev]);
        return id;
      },
      removeToast: (id: string) => {
        setToasts((prev) => prev.filter((t) => t.id !== id));
      },
    }),
    []
  );

  return (
    <ToastActionsContext.Provider value={actions}>
      <ToastStateContext.Provider value={toasts}>{children}</ToastStateContext.Provider>
    </ToastActionsContext.Provider>
  );
}

export function useToasts() {
  return useContext(ToastStateContext);
}

export function useToastActions() {
  const actions = useContext(ToastActionsContext);
  if (!actions) {
    throw new Error('useToastActions must be used within a ToastProvider');
  }
  return actions;
}

// Backward compatibility hook
export function useToast() {
  const toasts = useToasts();
  const actions = useToastActions();
  return { toasts, ...actions };
}
