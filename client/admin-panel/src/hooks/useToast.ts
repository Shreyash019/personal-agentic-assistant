import { useCallback, useRef, useState } from 'react';

export interface ToastItem {
  id: number;
  kind: 'success' | 'error';
  message: string;
}

export interface UseToastReturn {
  toasts: ToastItem[];
  toast: (kind: ToastItem['kind'], message: string) => void;
  dismiss: (id: number) => void;
}

export function useToast(): UseToastReturn {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const idRef = useRef(0);
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());

  const dismiss = useCallback((id: number) => {
    setToasts(prev => prev.filter(t => t.id !== id));
    const t = timers.current.get(id);
    if (t) { clearTimeout(t); timers.current.delete(id); }
  }, []);

  const toast = useCallback(
    (kind: ToastItem['kind'], message: string) => {
      const id = ++idRef.current;
      setToasts(prev => [...prev, { id, kind, message }]);
      const t = setTimeout(() => {
        setToasts(prev => prev.filter(item => item.id !== id));
        timers.current.delete(id);
      }, 4500);
      timers.current.set(id, t);
    },
    [],
  );

  return { toasts, toast, dismiss };
}
