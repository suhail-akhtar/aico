import { useQuery } from '@tanstack/react-query';
import { Link, Outlet, useRouteContext } from '@tanstack/react-router';
import { loginHref, logoutHref, sessionQuery } from '../auth/auth';
import { t } from '../shared/i18n/i18n';
import { buttonClass } from '../shared/ui/Button';
import { ThemeToggle } from '../shared/ui/ThemeToggle';
import { appName } from './context';

/**
 * The frame around every page: skip link, header with the session controls,
 * and a focusable <main> that route changes can move focus to.
 */
export function AppShell() {
  const { config } = useRouteContext({ from: '__root__' });
  const session = useQuery(sessionQuery);
  const user = session.data;

  return (
    <>
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-50 focus:rounded-md focus:bg-surface focus:px-4 focus:py-2 focus:text-fg focus:shadow-lg"
      >
        {t('app.skipToContent')}
      </a>
      <header className="border-b border-line bg-surface">
        <div className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-3 px-4 py-3">
          <div className="flex items-center gap-6">
            <Link to="/" className="text-lg font-bold">
              {appName}
            </Link>
            {user ? (
              <nav aria-label={t('app.nav.label')}>
                <Link
                  to="/items"
                  className="rounded-md px-2 py-1 font-medium text-muted hover:text-fg"
                  activeProps={{
                    className:
                      'rounded-md px-2 py-1 font-semibold text-fg underline underline-offset-4',
                  }}
                >
                  {t('app.nav.items')}
                </Link>
              </nav>
            ) : null}
          </div>
          <div className="flex items-center gap-3">
            <ThemeToggle />
            {user ? (
              <>
                <span className="hidden text-sm text-muted sm:inline">{user.email}</span>
                <a className={buttonClass('secondary')} href={logoutHref(config)}>
                  {t('app.signOut')}
                </a>
              </>
            ) : (
              <a className={buttonClass('primary')} href={loginHref(config, '/items')}>
                {t('app.signIn')}
              </a>
            )}
          </div>
        </div>
      </header>
      <main id="main" tabIndex={-1} className="mx-auto max-w-5xl px-4 py-8 outline-none">
        <Outlet />
      </main>
    </>
  );
}
