import { createRootRouteWithContext, HeadContent, Link } from '@tanstack/react-router';
import { AppShell } from '../app/AppShell';
import { appName, type RouterContext } from '../app/context';
import { t } from '../shared/i18n/i18n';
import { buttonClass } from '../shared/ui/Button';
import { ErrorState } from '../shared/ui/Feedback';

function NotFound() {
  return (
    <section>
      <h1 className="text-2xl font-semibold">{t('notFound.title')}</h1>
      <p className="mt-2 text-muted">{t('notFound.body')}</p>
      <p className="mt-6">
        <Link to="/" className={buttonClass('primary')}>
          {t('notFound.home')}
        </Link>
      </p>
    </section>
  );
}

function RouteError({ reset }: { reset: () => void }) {
  return <ErrorState title={t('error.title')} body={t('error.body')} onRetry={reset} />;
}

export const Route = createRootRouteWithContext<RouterContext>()({
  head: () => ({ meta: [{ title: appName }] }),
  component: () => (
    <>
      <HeadContent />
      <AppShell />
    </>
  ),
  notFoundComponent: NotFound,
  errorComponent: RouteError,
});
