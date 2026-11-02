'use client';
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { cx } from '../cx';

export interface ToastOptions {
  /** Repeats the action's outcome: "Claim released." */
  message: string;
  tone?: 'bad';
  /** Offers Undo for 10 seconds (docs/09-ui-screens.md). */
  onUndo?: () => void;
  durationMs?: number;
}

interface ToastItem extends ToastOptions {
  id: number;
}

const ToastContext = createContext<((t: ToastOptions) => void) | null>(null);

export function useToast(): (t: ToastOptions) => void {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast needs a ToastProvider');
  return ctx;
}

/** G-08 Toast. Announced through a polite live region; errors use an assertive one. */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const next = useRef(1);
  const dismiss = useCallback((id: number) => setItems((all) => all.filter((t) => t.id !== id)), []);
  const show = useCallback(
    (t: ToastOptions) => setItems((all) => [...all.slice(-2), { ...t, id: next.current++ }]),
    [],
  );
  return (
    <ToastContext.Provider value={show}>
      {children}
      <div className="toast-region" role="region" aria-label="Notifications">
        <div aria-live="polite" className="stack-sm">
          {items
            .filter((t) => t.tone !== 'bad')
            .map((t) => (
              <Toast key={t.id} item={t} onDone={() => dismiss(t.id)} />
            ))}
        </div>
        <div aria-live="assertive" className="stack-sm">
          {items
            .filter((t) => t.tone === 'bad')
            .map((t) => (
              <Toast key={t.id} item={t} onDone={() => dismiss(t.id)} />
            ))}
        </div>
      </div>
    </ToastContext.Provider>
  );
}

function Toast({ item, onDone }: { item: ToastItem; onDone: () => void }) {
  useEffect(() => {
    const timer = setTimeout(onDone, item.durationMs ?? (item.onUndo ? 10_000 : 5_000));
    return () => clearTimeout(timer);
  }, [item, onDone]);
  return (
    <div className={cx('toast', item.tone)} role="status">
      <span>{item.message}</span>
      {item.onUndo && (
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          onClick={() => {
            item.onUndo?.();
            onDone();
          }}
        >
          Undo
        </button>
      )}
    </div>
  );
}
