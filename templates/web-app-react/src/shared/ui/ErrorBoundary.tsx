import { Component, type ErrorInfo, type ReactNode } from 'react';
import { browser } from '../browser';
import { t } from '../i18n/i18n';
import { Button } from './Button';

interface Props {
  children: ReactNode;
  /** Replaces the default screen (the config-error screen uses this). */
  fallback?: (error: Error) => ReactNode;
}

/**
 * The last line of defence for render errors outside the router (the router
 * has its own `defaultErrorComponent`). It shows a recoverable screen instead
 * of a blank page and reports to the console, where a log shipper or an error
 * tracker hooks in (see docs/EXTENDING.md).
 */
export class ErrorBoundary extends Component<Props, { error: Error | null }> {
  override state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('Unhandled render error', error, info.componentStack);
  }

  override render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    if (this.props.fallback) return this.props.fallback(error);
    return (
      <main className="mx-auto max-w-lg p-8">
        <h1 className="text-2xl font-semibold">{t('error.title')}</h1>
        <p className="mt-2 text-muted">{t('error.body')}</p>
        <div className="mt-6">
          <Button variant="primary" onClick={() => browser.reload()}>
            {t('error.reload')}
          </Button>
        </div>
      </main>
    );
  }
}
