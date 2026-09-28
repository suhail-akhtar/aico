/**
 * In-app notifications, bottom-right. Native OS notifications are for when the
 * window is not in front (see notifications.ts); these are for when it is.
 * @module desktop/renderer/shell/Toasts
 */

import React from 'react';
import { useDesk } from '@/state/desk';
import { Icon } from '@/lib/icons';
import { cls } from '@/lib/util';

const TONE: Record<string, { icon: string; cls: string }> = {
  info: { icon: 'info', cls: 'text-aico-info' },
  success: { icon: 'check-circle', cls: 'text-aico-success' },
  warning: { icon: 'alert', cls: 'text-aico-warning' },
  error: { icon: 'x-circle', cls: 'text-aico-danger' },
};

export function Toasts(): React.ReactElement {
  const toasts = useDesk(s => s.toasts);
  const dismiss = useDesk(s => s.dismissToast);
  return (
    <div className="pointer-events-none fixed bottom-4 right-4 z-[80] flex w-[360px] max-w-[calc(100vw-32px)] flex-col gap-2" aria-live="polite">
      {toasts.map(t => {
        const tone = TONE[t.kind]!;
        return (
          <div key={t.id} role={t.kind === 'error' ? 'alert' : 'status'}
            className="pointer-events-auto flex items-start gap-3 rounded-xl border border-aico-border-subtle bg-aico-bg p-3 shadow-[var(--desk-shadow)]"
            style={{ animation: 'desk-slide-up 180ms ease-out' }}>
            <Icon name={tone.icon} size={18} className={cls('mt-0.5 shrink-0', tone.cls)} />
            <div className="min-w-0 flex-1">
              <div className="text-[13.5px] font-medium text-aico-primary">{t.title}</div>
              {t.body && <div className="mt-0.5 whitespace-pre-wrap break-words text-[12.5px] text-aico-secondary selectable">{t.body}</div>}
              {t.action && (
                <button className="mt-2 text-[12.5px] font-medium text-aico-accent hover:underline" onClick={() => { t.action!.run(); dismiss(t.id); }}>
                  {t.action.label}
                </button>
              )}
            </div>
            <button className="icon-btn-sm -mr-1 -mt-1" onClick={() => dismiss(t.id)} aria-label="Dismiss"><Icon name="x" size={14} /></button>
          </div>
        );
      })}
    </div>
  );
}
