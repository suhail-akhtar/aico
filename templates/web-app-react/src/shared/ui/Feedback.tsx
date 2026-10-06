import type { ReactNode } from 'react';
import { t } from '../i18n/i18n';
import { Button } from './Button';

export function Spinner({ label = t('app.loading') }: { label?: string }) {
  return (
    <output className="inline-flex items-center gap-2 text-muted">
      <svg
        className="size-5 animate-spin motion-reduce:animate-none"
        viewBox="0 0 24 24"
        fill="none"
        aria-hidden="true"
        focusable="false"
      >
        <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="3" opacity="0.25" />
        <path
          d="M21 12a9 9 0 0 0-9-9"
          stroke="currentColor"
          strokeWidth="3"
          strokeLinecap="round"
        />
      </svg>
      <span>{label}</span>
    </output>
  );
}

/** Placeholder rows while the first page loads: the layout does not jump when data arrives. */
export function ItemsSkeleton() {
  return (
    <output aria-label={t('app.loading')} className="block">
      <ul
        className="divide-y divide-line rounded-xl border border-line bg-surface"
        aria-hidden="true"
      >
        {[0, 1, 2, 3].map((n) => (
          <li
            key={n}
            className="flex animate-pulse items-center gap-4 p-4 motion-reduce:animate-none"
          >
            <div className="flex-1 space-y-2">
              <div className="h-4 w-1/3 rounded bg-surface-2" />
              <div className="h-3 w-2/3 rounded bg-surface-2" />
            </div>
            <div className="h-8 w-20 rounded bg-surface-2" />
          </li>
        ))}
      </ul>
    </output>
  );
}

export function EmptyState({
  title,
  body,
  action,
}: {
  title: string;
  body: string;
  action?: ReactNode;
}) {
  return (
    <div className="rounded-xl border border-dashed border-line bg-surface p-8 text-center sm:p-12">
      <svg
        className="mx-auto size-12 text-muted"
        viewBox="0 0 48 48"
        fill="none"
        aria-hidden="true"
        focusable="false"
      >
        <rect x="6" y="10" width="36" height="28" rx="5" stroke="currentColor" strokeWidth="2.5" />
        <path
          d="M14 20h20M14 28h12"
          stroke="currentColor"
          strokeWidth="2.5"
          strokeLinecap="round"
        />
      </svg>
      <h2 className="mt-4 text-lg font-semibold">{title}</h2>
      <p className="mx-auto mt-1 max-w-sm text-muted">{body}</p>
      {action ? <div className="mt-6">{action}</div> : null}
    </div>
  );
}

export function ErrorState({
  title,
  body,
  onRetry,
}: {
  title: string;
  body?: string | undefined;
  onRetry?: (() => void) | undefined;
}) {
  return (
    <div role="alert" className="rounded-xl border border-danger bg-surface p-6">
      <h2 className="text-lg font-semibold text-danger">{title}</h2>
      {body ? <p className="mt-1 text-muted">{body}</p> : null}
      {onRetry ? (
        <div className="mt-4">
          <Button onClick={onRetry}>{t('error.retry')}</Button>
        </div>
      ) : null}
    </div>
  );
}
