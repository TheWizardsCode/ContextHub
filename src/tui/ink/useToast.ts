/**
 * useToast — simple hook for managing transient toast messages in the Ink TUI.
 */

import { useState, useCallback, useRef } from 'react';

export type ToastType = 'info' | 'success' | 'error' | 'warning';

export interface Toast {
  message: string;
  type: ToastType;
}

export function useToast(defaultDurationMs = 3000): [Toast | null, (message: string, type?: ToastType, durationMs?: number) => void] {
  const [toast, setToast] = useState<Toast | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const show = useCallback((message: string, type: ToastType = 'info', durationMs = defaultDurationMs) => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
    }
    setToast({ message, type });
    timerRef.current = setTimeout(() => {
      setToast(null);
      timerRef.current = null;
    }, durationMs);
  }, [defaultDurationMs]);

  return [toast, show];
}
